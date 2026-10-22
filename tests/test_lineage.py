import copy
from datetime import datetime, timezone
import importlib

import pytest

from poly_tally.metrics import 行统计_类


def state(name, values, *, private=False, status='active'):
    history = []
    for index, value in enumerate(values):
        timestamp, code, *extra = value
        metrics = {**行统计_类.api_空指标(), 'code': code, 'comment': extra[0] if extra else code + 1, 'files': 1}
        history.append({'timestamp': timestamp, 'committedAt': timestamp, 'authoredAt': timestamp, 'sha': f'secret-{index}', 'metrics': metrics, 'languages': {name.split('/')[-1]: metrics.copy()}})
    return {'id': name.split('/')[-1], 'name': name, 'private': private, 'status': status, 'history': history, 'rulesVersion': 'rules', 'historyComplete': True, 'lastSuccessAt': '2099-01-01T00:00:00Z', 'url': 'https://github.com/' + name, 'branch': 'main', 'head': 'secret-head', 'notice': '', 'inventory': {}, 'skippedFiles': 0}


def config(*names):
    return [{'id': 'family', 'members': list(names)}]


def lineage():
    assert importlib.util.find_spec('poly_tally.lineage'), 'lineage processor must exist'
    return importlib.import_module('poly_tally.lineage')


def group(repositories):
    return lineage().collapse_repositories(repositories, config(*(r['name'] for r in repositories)), 'rules')[0]


def test_strict_high_watermark_not_current_max_and_all_metrics_from_one_member():
    a = state('o/a', [('2024-01-01T00:00:00Z', 100, 3), ('2024-01-03T00:00:00Z', 20, 8)])
    b = state('o/b', [('2024-01-02T00:00:00Z', 80, 900), ('2024-01-04T00:00:00Z', 100), ('2024-01-05T00:00:00Z', 101, 4)])
    result = group([b, a])
    assert [p['metrics']['code'] for p in result['history']] == [100, 100, 20, 20, 101]
    assert result['history'][1]['metrics']['comment'] == 3
    assert result['history'][2]['metrics']['comment'] == 8
    assert result['history'][-1]['languages'] == b['history'][-1]['languages']
    assert result['lineage']['dominantMember'] == 'o/b'


def test_highs_survive_switch_back_and_non_dominant_updates_do_not_replace_stock():
    a = state('o/a', [('2024-01-01T00:00:00Z', 100), ('2024-01-04T00:00:00Z', 130), ('2024-01-05T00:00:00Z', 5)])
    b = state('o/b', [('2024-01-02T00:00:00Z', 120), ('2024-01-03T00:00:00Z', 2), ('2024-01-06T00:00:00Z', 129), ('2024-01-07T00:00:00Z', 131)])
    result = group([a, b])
    assert [p['metrics']['code'] for p in result['history']] == [100, 120, 2, 130, 5, 5, 131]


def test_representative_uses_actual_commit_not_scan_or_normalized_axis():
    a = state('o/a', [('2024-01-01T00:00:00Z', 100)])
    b = state('o/b', [('2024-01-02T00:00:00Z', 1)])
    a['lastSuccessAt'] = '2100-01-01T00:00:00Z'
    a['history'][0]['timestamp'] = '2024-01-05T00:00:00Z'
    result = group([a, b])
    assert result['name'] == 'o/b'


def test_same_instant_has_canonical_member_order_first_parent_order_and_preserves_peaks():
    a = state('o/a', [('2024-01-01T00:00:00Z', 100), ('2024-01-01T00:00:00Z', 10)])
    b = state('o/b', [('2024-01-01T00:00:00Z', 99), ('2024-01-02T00:00:00Z', 100), ('2024-01-03T00:00:00Z', 101)])
    first = group([a, b]); second = group([b, a])
    assert first == second
    assert [p['metrics']['code'] for p in first['history']] == [10, 10, 101]


def test_zero_valid_empty_unknown_rejected_and_no_implicit_name_grouping():
    a = state('o/a', [('2024-01-01T00:00:00Z', 0)])
    b = state('o/b', [('2024-01-02T00:00:00Z', 0), ('2024-01-03T00:00:00Z', 1)])
    assert group([a, b])['history'][-1]['metrics']['code'] == 1
    assert lineage().collapse_repositories([a, b], [], 'rules') == [a, b]
    b['status'] = 'inaccessible'
    with pytest.raises(ValueError, match='incomplete'):
        group([a, b])
    with pytest.raises(ValueError, match='missing'):
        lineage().collapse_repositories([a], config('o/a', 'o/b'), 'rules')
    a['history'][0]['metrics'].pop('code')
    with pytest.raises(ValueError, match='metrics'):
        group([a])


def test_default_branch_rebuild_and_membership_change_replay_without_stored_winners():
    a = state('o/a', [('2024-01-01T00:00:00Z', 100)])
    b = state('o/b', [('2024-01-02T00:00:00Z', 110)])
    assert group([a, b])['lineage']['dominantMember'] == 'o/b'
    b['history'][0]['metrics']['code'] = 90
    assert group([a, b])['lineage']['dominantMember'] == 'o/a'
    c = state('o/c', [('2023-01-01T00:00:00Z', 200)])
    assert group([a, b, c])['lineage']['dominantMember'] == 'o/c'
    assert lineage().lineage_version(config('o/a', 'o/b')) != lineage().lineage_version(config('o/a', 'o/b', 'o/c'))


def test_config_rejects_duplicates_bad_names_and_duplicate_groups():
    for groups in (config('o/a', 'O/A'), [{'id': 'x', 'members': ['o/a']}, {'id': 'y', 'members': ['o/a']}], config('../secret'), [{'id': '../bad', 'members': ['o/a']}], [{'id': 'x', 'members': []}]):
        with pytest.raises(ValueError):
            lineage().validate_groups(groups)


def collector_config():
    return {'owners': ['o'], 'repositories': {'include': ['o/*'], 'exclude': []}, 'rules': {'include': ['**'], 'exclude': [], 'languages': {}, 'max_blob_bytes': 2000000, 'include_forks': False}, 'lineageGroups': config('o/a', 'o/b')}


def metadata(name, id, private=False, archived=False):
    return {'id': id, 'full_name': name, 'default_branch': 'main', 'private': private, 'archived': archived, 'fork': False, 'clone_url': '/unused', 'size': 1}


def test_collector_scans_group_archived_and_public_in_private_job(tmp_path, monkeypatch):
    from poly_tally.collector import 采集器_类
    collector = 采集器_类(collector_config(), tmp_path, 'fixture', False, True, 'new-lineage')
    try:
        sources = [metadata('o/a', 'a', archived=True), metadata('o/b', 'b', private=True)]
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: sources)
        monkeypatch.setattr(collector.发现器, 'api_读取默认分支', lambda repo: 'head')
        scanned = []
        def sync(repo, url, head):
            scanned.append(repo['full_name'])
            value = state(repo['full_name'], [('2024-01-01T00:00:00Z', 10)], private=repo['private'])
            value['rulesVersion'] = collector.规则.版本
            collector.引擎.数据库.api_保存仓库(value)
        monkeypatch.setattr(collector.引擎, 'api_同步', sync)
        run = collector.api_采集()
        assert scanned == ['o/a', 'o/b']
        assert run['completeness']['complete'] is True
    finally:
        collector.api_关闭()


def test_missing_configured_group_member_and_discovery_failure_never_fresh(tmp_path, monkeypatch):
    import requests
    from poly_tally.collector import 采集器_类
    from poly_tally.private_metrics import 私有规模导出_类
    collector = 采集器_类(collector_config(), tmp_path, 'fixture', False, True, 'new-lineage')
    try:
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: [])
        def unavailable(*args):
            raise requests.HTTPError('403')
        monkeypatch.setattr(collector.发现器, 'api_读取仓库', unavailable)
        run = collector.api_采集()
        assert run['failed'] > 0
        assert run['completeness']['missingMembers'] == 2
        exported = 私有规模导出_类(collector.引擎.数据库, collector.规则).api_构建()
        assert exported['completeness']['complete'] is False
        assert exported['repositories'] == []
        from poly_tally.export import 公开导出_类
        combined = 公开导出_类(collector.引擎.数据库, collector.规则, True).api_构建()
        assert combined['publication']['privateStatus'] == 'pending-rebuild'
        assert combined['completeness']['complete'] is False
        monkeypatch.setattr(collector.发现器, 'api_发现', unavailable)
        run = collector.api_采集()
        assert run['completeness']['discoveryComplete'] is False
    finally:
        collector.api_关闭()


def test_epoch_contract_rejects_old_state_or_changed_members(tmp_path):
    from poly_tally.collector import 采集器_类
    from poly_tally.store import 数据库_类
    database = 数据库_类(tmp_path / 'old')
    database.api_保存仓库(state('o/a', [('2024-01-01T00:00:00Z', 5)]))
    database.api_关闭()
    with pytest.raises(ValueError, match='epoch'):
        采集器_类(collector_config(), tmp_path / 'old', None, True, False, 'new-lineage')
    collector = 采集器_类(collector_config(), tmp_path / 'clean', None, True, False, 'new-lineage')
    collector.api_关闭()
    changed = collector_config(); changed['lineageGroups'][0]['members'].append('o/c')
    with pytest.raises(ValueError, match='epoch'):
        采集器_类(changed, tmp_path / 'clean', None, True, False, 'new-lineage')


def test_private_mixed_group_collapses_before_day_sampling_and_redacts(tmp_path):
    import json
    from poly_tally.rules import 规则_类
    from poly_tally.store import 数据库_类
    from poly_tally.private_metrics import 私有规模导出_类
    from poly_tally.export import 公开导出_类
    database = 数据库_类(tmp_path)
    try:
        rules = 规则_类(collector_config()['rules'])
        database.lineage_groups = config('o/a', 'o/b')
        a = state('o/a', [('2024-01-01T01:00:00Z', 100), ('2024-01-01T02:00:00Z', 10)])
        b = state('o/b', [('2024-01-02T01:00:00Z', 90)], private=True)
        for repo in [a, b]:
            repo['rulesVersion'] = rules.版本
            repo['lastSuccessAt'] = '2024-01-03T00:00:00Z'
            database.api_保存仓库(repo)
        exported = 私有规模导出_类(database, rules).api_构建(datetime(2024, 1, 3, tzinfo=timezone.utc))
        assert len(exported['repositories']) == 1
        result = exported['repositories'][0]
        assert result['history'][-1]['metrics']['code'] == 10
        assert result['name'] == 'o/b'
        assert result['lastCommitDate'] == '2024-01-02'
        assert 'secret-' not in json.dumps(exported)
        assert 'committedAt' not in json.dumps(exported)
        assert result['lineage']['dominantMember'] == 'o/a'
        assert 公开导出_类(database, rules).api_构建()['repositories'] == []
        combined = 公开导出_类(database, rules, True).api_构建()
        assert combined['summary']['repositories'] == 1
        assert combined['summary']['code'] == 10
    finally:
        database.api_关闭()


def test_same_epoch_old_checkpoint_rejected_without_lineage_contract(tmp_path):
    import json
    from poly_tally.collector import 采集器_类
    collector = 采集器_类(collector_config(), tmp_path / 'clean', None, True, False, 'new-lineage')
    try:
        checkpoint = tmp_path / 'old.json'
        checkpoint.write_text(json.dumps({'schemaVersion': 1, 'generatedAt': '2024-01-01T00:00:00Z', 'datasetEpoch': 'new-lineage', 'repositories': []}))
        with pytest.raises(ValueError, match='lineage'):
            collector.api_恢复检查点(checkpoint)
    finally:
        collector.api_关闭()


def test_old_objects_cannot_seed_new_epoch_even_when_sqlite_is_absent(tmp_path):
    from poly_tally.collector import 采集器_类
    (tmp_path / 'objects').mkdir()
    (tmp_path / 'objects' / 'old.git').mkdir()
    with pytest.raises(ValueError, match='epoch'):
        采集器_类(collector_config(), tmp_path, None, True, False, 'new-lineage')


def test_rebuild_config_sets_explicit_confirmed_group_only():
    import json
    from pathlib import Path
    actual = json.loads(Path('config.json').read_text())
    assert actual.get('datasetEpoch') == 'source-only-no-eigen-2026-10-22-v1'
    assert actual.get('lineageGroups') == [{'id': 'vitro', 'members': ['SiliconYC/vitro', 'SiliconYC/vitro_zero_lab', 'SiliconYC/vitro_union_lab']}]


def test_same_timestamp_batches_incumbent_growth_before_challenges_and_id_ties():
    a = state('o/z-name', [('2024-01-01T00:00:00Z', 100), ('2024-01-02T00:00:00Z', 150)])
    b = state('o/a-name', [('2024-01-02T00:00:00Z', 130)])
    a['id'], b['id'] = '1', '2'
    assert group([b, a])['lineage']['dominantMember'] == 'o/z-name'
    b['history'][0]['metrics']['code'] = 160
    c = state('o/0-name', [('2024-01-02T00:00:00Z', 160)]); c['id'] = '3'
    assert group([c, b, a])['lineage']['dominantMember'] == 'o/a-name'


def test_optional_fresh_inventory_detects_narrow_token_without_old_metrics(tmp_path, monkeypatch):
    from poly_tally.collector import 采集器_类
    cfg = collector_config(); cfg['lineageGroups'] = []
    inventory = {'source': 'authorized GitHub connector owner inventory', 'verifiedAt': '2026-10-21T12:03:39Z', 'repositories': [{'id':'hidden', 'name':'o/hidden', 'visibility':'private', 'archived':False, 'defaultBranch':'main'}]}
    collector = 采集器_类(cfg, tmp_path, 'fixture', False, True, 'new-lineage', arg_预期清单=inventory)
    try:
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: [])
        run = collector.api_采集()
        assert run['completeness']['complete'] is False
        assert run['completeness']['expectedRepositories'] == 1
        assert run['failed'] > 0
    finally:
        collector.api_关闭()


def test_optional_inventory_counts_group_archived_but_excludes_ordinary_archived(tmp_path, monkeypatch):
    from poly_tally.collector import 采集器_类
    inventory = {'source':'fixture', 'verifiedAt':'2026-10-21T12:03:39Z', 'repositories':[{'id':'archived', 'name':'o/ordinary-archived', 'visibility':'private', 'archived':True}, {'id':'a', 'name':'o/a', 'visibility':'public', 'archived':True}]}
    collector = 采集器_类(collector_config(), tmp_path, 'fixture', False, True, 'new-lineage', arg_预期清单=inventory)
    try:
        sources = [metadata('o/a', 'a', archived=True), metadata('o/b', 'b', private=True)]
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: sources)
        monkeypatch.setattr(collector.发现器, 'api_读取默认分支', lambda repo: None)
        run = collector.api_采集()
        assert run['completeness']['expectedRepositories'] == 2
        assert run['completeness']['complete'] is True
    finally:
        collector.api_关闭()


def test_failed_current_run_with_previous_complete_history_exports_no_fresh_proof(tmp_path, monkeypatch):
    import requests
    from poly_tally.collector import 采集器_类
    from poly_tally.private_metrics import 私有规模导出_类
    from poly_tally.export import 公开导出_类
    collector = 采集器_类(collector_config(), tmp_path, 'fixture', False, True, 'new-lineage')
    try:
        sources = [metadata('o/a', 'a', private=True), metadata('o/b', 'b', private=True)]
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: sources)
        monkeypatch.setattr(collector.发现器, 'api_读取默认分支', lambda repo: 'head')
        def sync(repo, url, head):
            value = state(repo['full_name'], [('2024-01-01T00:00:00Z', 10)], private=True)
            value['rulesVersion'] = collector.规则.版本
            collector.引擎.数据库.api_保存仓库(value)
        monkeypatch.setattr(collector.引擎, 'api_同步', sync)
        assert collector.api_采集()['completeness']['complete'] is True
        prior = 私有规模导出_类(collector.引擎.数据库, collector.规则).api_构建()
        assert prior['completeness']['complete'] is True
        def failed(*args):
            raise requests.HTTPError('403')
        monkeypatch.setattr(collector.发现器, 'api_发现', failed)
        monkeypatch.setattr(collector.发现器, 'api_读取仓库', failed)
        current = collector.api_采集()
        assert current['completeness']['complete'] is False
        assert collector.引擎.数据库.api_最近运行()[0]['completeness']['complete'] is False
        private = 私有规模导出_类(collector.引擎.数据库, collector.规则).api_构建()
        combined = 公开导出_类(collector.引擎.数据库, collector.规则, True).api_构建()
        assert private['completeness']['complete'] is False
        assert combined['completeness']['complete'] is False
        assert combined['publication']['privateStatus'] == 'pending-rebuild'
        assert all(repo['history'] for repo in collector.引擎.api_仓库列表()), 'local prior history is preserved, not counted as fresh'
        assert prior['completeness']['complete'] is True, 'previous successful evidence remains unchanged'
    finally:
        collector.api_关闭()


def test_metadata_size_zero_and_ambiguous_http_errors_cannot_publish_empty_complete(tmp_path, monkeypatch):
    import json
    import requests
    from poly_tally.collector import 采集器_类
    from poly_tally.private_metrics import 私有规模导出_类
    cfg = collector_config(); cfg['lineageGroups'] = config('o/a')
    source = {**metadata('o/a', 'a', private=True), 'size': 0}
    collector = 采集器_类(cfg, tmp_path, 'fixture', False, True, 'new-lineage')
    try:
        monkeypatch.setattr(collector.发现器, 'api_发现', lambda owners: [source])
        def response(status, body):
            result = requests.Response(); result.status_code = status
            result._content = json.dumps(body).encode(); result.url = 'https://api.github.com/repos/o/a/branches/main'
            return result
        monkeypatch.setattr(collector.发现器.会话, 'get', lambda *args, **kwargs: response(404, {'message':'Not Found'}))
        current = collector.api_采集()
        assert current['failed'] == 1
        assert current['completeness']['complete'] is False
        assert collector.引擎.数据库.api_读取仓库('a')['status'] == 'inaccessible'
        assert 私有规模导出_类(collector.引擎.数据库, collector.规则).api_构建()['completeness']['complete'] is False
        # Once an authorized Contents branch-list response positively establishes
        # zero refs, the empty result is a fact rather than an error fallback.
        replies = iter([response(404, {'message':'Not Found'}), response(200, [])])
        monkeypatch.setattr(collector.发现器.会话, 'get', lambda *args, **kwargs: next(replies))
        current = collector.api_采集()
        assert current['failed'] == 0
        assert current['completeness']['complete'] is True
        assert collector.引擎.数据库.api_读取仓库('a')['status'] == 'empty'
    finally:
        collector.api_关闭()
