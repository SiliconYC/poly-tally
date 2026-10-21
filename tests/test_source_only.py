"""Source-only policy: hard category/extension exclusions precede all inclusions."""
import copy
import json
import os
from pathlib import Path
import subprocess

import pytest

from poly_tally.engine import 历史引擎_类
from poly_tally.rules import 规则_类


def configuration():
    return json.loads(Path('config.json').read_text())


def test_reviewable_config_excludes_data_categories_and_uses_new_epoch():
    config = configuration()
    assert config['datasetEpoch'] == 'source-only-lineage-2026-10-21-v1'
    assert config['rules'].get('exclude_extensions') == ['.json', '.jsonc', '.yaml', '.yml', '.xml']
    assert config['rules'].get('exclude_languages') == ['JSON', 'YAML', 'XML']


@pytest.mark.parametrize('path', ['config.json', 'package.json', 'src/static-registry.JSON', 'src/config.JSONC', 'tests/fixtures/sample.JsonC', 'src/data.yaml', 'tests/data.YML', '.github/workflows/ci.YaMl', 'settings.Xml', 'src/registry.XML', 'images/icon.svg', 'src/icon.SVG'])
def test_global_hard_exclusion_covers_case_aliases_config_and_source_preserve(path):
    assert 规则_类(configuration()['rules']).api_语言(path) is None


def test_includes_and_language_overrides_cannot_rescue_excluded_source_types():
    config = configuration()['rules']
    config['include'] = ['**', '**/*.JSON', 'src/**', 'tests/**']
    config['exclude'] = []
    config['artifact_exclude'] = []
    config['source_preserve'] = ['**']
    config['languages'] = {'.json': 'Python', '.jsonc': 'Markdown', '.yaml': 'TypeScript', '.yml': 'C', '.xml': 'Text', '.svg': 'Python', '.payload': 'JSON', '.manifest': 'XML', '.recipe': 'YAML'}
    rules = 规则_类(config)
    for suffix in ['json', 'jsonc', 'yaml', 'yml', 'xml', 'svg', 'payload', 'manifest', 'recipe']:
        assert rules.api_语言('src/config.' + suffix.upper()) is None
    for path, language in {'src/main.py':'Python', 'src/app.ts':'TypeScript', 'docs/README.md':'Markdown', 'index.html':'HTML', 'settings.toml':'TOML'}.items():
        assert rules.api_语言(path) == language


def test_hard_filters_are_config_driven_case_insensitive_and_versioned():
    config = configuration()['rules']
    legacy = copy.deepcopy(config)
    legacy.pop('exclude_extensions', None); legacy.pop('exclude_languages', None)
    current = 规则_类(config)
    old = 规则_类(legacy)
    assert current.版本 != old.版本
    assert old.api_语言('src/config.json') == 'JSON'
    config['exclude_extensions'] = ['.JSON', '.JSONC', '.YAML', '.YML', '.XML']
    config['exclude_languages'] = ['json', 'yaml', 'xml']
    assert 规则_类(config).api_语言('src/config.json') is None


@pytest.mark.parametrize('field,value', [('exclude_extensions', '*.json'), ('exclude_extensions', [None]), ('exclude_extensions', ['json']), ('exclude_languages', 'JSON'), ('exclude_languages', ['unknown'])])
def test_hard_filter_configuration_is_validated(field, value):
    config = configuration()['rules']; config[field] = value
    with pytest.raises(ValueError):
        规则_类(config)


def test_real_git_full_and_incremental_histories_exclude_data_without_reading_or_counting_files(tmp_path):
    source = tmp_path / 'source'; source.mkdir()
    def git(*args, date=None):
        env = {**os.environ, 'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date} if date else os.environ
        return subprocess.check_output(['git', '-C', str(source), *args], env=env, stderr=subprocess.DEVNULL).decode().strip()
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    (source / 'main.py').write_text('x = 1\n# comment\n')
    (source / 'README.md').write_text('# Guide\n')
    (source / 'src').mkdir()
    for suffix in ['JSON','JSONC','yaml','YML','Xml','SVG']:
        (source / 'src' / ('data.' + suffix)).write_text('{"static_config": true}\n' * 50)
    git('add', '.'); git('commit', '-qm', 'fixture', date='2024-01-01T12:00:00Z')
    metadata = {'id':1, 'full_name':'fixture/source', 'private':False, 'archived':False, 'default_branch':'main'}
    rules = 规则_类(configuration()['rules'])
    engine = 历史引擎_类(tmp_path / 'state', rules)
    try:
        first = engine.api_同步(metadata, str(source))
        expected = {'code':1, 'comment':1, 'blank':0, 'documentation':1, 'files':2}
        assert first['history'][-1]['metrics'] == expected
        assert set(first['inventory']) == {'main.py', 'README.md'}
        assert engine.计数['objectReads'] == 2
        (source / 'src' / 'data.JSON').write_text('{"large": "dataset"}\n' * 100)
        git('add', '.'); git('commit', '-qm', 'data only change', date='2024-01-02T12:00:00Z')
        incremental = engine.api_同步(metadata, str(source))
        assert [point['metrics'] for point in incremental['history']] == [expected, expected]
        assert engine.计数['objectReads'] == 2
        fresh = 历史引擎_类(tmp_path / 'fresh', rules)
        try:
            assert fresh.api_同步(metadata, str(source))['history'] == incremental['history']
        finally:
            fresh.api_关闭()
    finally:
        engine.api_关闭()


def test_bundled_reset_has_current_rules_but_no_collected_facts_or_old_payloads():
    from poly_tally.lineage import lineage_version
    config = configuration()
    data = json.loads(Path('web/data/stats.json').read_text())
    assert data['datasetEpoch'] == config['datasetEpoch']
    assert data['rules']['version'] == 规则_类(config['rules']).版本
    assert data['lineageVersion'] == lineage_version(config['lineageGroups'])
    assert data['repositories'] == [] and data['runs'] == []
    assert data['completeness']['complete'] is False
    assert data['completeness']['discoveryComplete'] is False
    assert all(data['summary'][key] == 0 for key in ['code', 'comment', 'blank', 'documentation', 'files', 'repositories'])
    assert not Path('web/data/private-metrics.json').exists()
    assert not Path('web/data/retained-private-baseline.json').exists()
    assert Path('config.json').exists(), 'project configuration is not a statistics artifact to delete'
