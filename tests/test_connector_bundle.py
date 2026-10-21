"""Offline API-shaped bundles compared with real Git, never mocked metrics."""
import base64
import copy
from datetime import datetime, timezone
import importlib
import json
import os
from pathlib import Path
import subprocess

import pytest

from poly_tally.engine import 历史引擎_类
from poly_tally.rules import 规则_类


def adapter_module():
    try:
        return importlib.import_module('poly_tally.connector_bundle')
    except ModuleNotFoundError:
        pytest.fail('connector bundle adapter has not been implemented')


class Fixture:
    def __init__(self, root):
        self.root = root
        self.repo = root / 'source'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.sequence = 0
        self.metadata = dict(id=1, full_name='fixture/source', default_branch='main', private=True, archived=False, fork=False, clone_url=str(self.repo))
        self.config = dict(owners=['fixture'], repositories=dict(include=['fixture/*'], exclude=[]), lineageGroups=[], rules=dict(include=['**'], exclude=['**/vendor/**'], languages={}, max_blob_bytes=200, include_forks=False))
        self.rules = 规则_类(self.config['rules'])

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL)

    def commit(self, files):
        for name, content in files.items():
            path = self.repo / name
            if content is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content if isinstance(content, bytes) else content.encode())
        self.git('add', '.')
        self.sequence += 1
        stamp = f'2024-01-{self.sequence:02}T12:00:00+00:00'
        subprocess.run(['git', '-C', str(self.repo), 'commit', '-qm', 'fixture'], check=True, env={**os.environ, 'GIT_AUTHOR_DATE': stamp, 'GIT_COMMITTER_DATE': stamp})
        return self.git('rev-parse', 'HEAD').decode().strip()

    def write_bundle(self, name='bundle', head=None, metadata=None):
        root = self.root / name
        root.mkdir(mode=0o700, exist_ok=True)
        meta = metadata or self.metadata
        head = head or self.git('rev-parse', meta['default_branch']).decode().strip()
        manifest = dict(schemaVersion=1, source='github-connector', capturedAt='2026-10-21T12:00:00Z', discoveryComplete=True, repositories=[dict(metadata=meta, head=head, verifiedHead=head, verifiedDefaultBranch=meta['default_branch'])])
        write_json(root / 'manifest.json', manifest)
        seen = set()
        def tree(sha, prefix=''):
            if sha in seen:
                return
            seen.add(sha)
            entries = []
            for row in self.git('ls-tree', '-z', sha).split(b'\0'):
                if not row:
                    continue
                header, raw_name = row.split(b'\t', 1)
                mode, kind, oid = header.decode().split()
                name = raw_name.decode()
                item = dict(path=name, mode=mode, type=kind, sha=oid)
                if kind == 'blob':
                    content = self.git('cat-file', 'blob', oid)
                    item['size'] = len(content)
                    # Deliberately omit excluded/oversize/symlink contents.
                    if mode in {'100644', '100755'} and self.rules.api_语言(prefix + name) and len(content) <= self.rules.配置['max_blob_bytes']:
                        write_json(root / 'objects' / 'blobs' / f'{oid}.json', dict(sha=oid, encoding='base64', content=base64.encodebytes(content).decode()))
                elif kind == 'tree':
                    tree(oid, prefix + name + '/')
                entries.append(item)
            write_json(root / 'objects' / 'trees' / f'{sha}.json', dict(sha=sha, tree=entries, truncated=False))
        for sha in self.git('rev-list', '--first-parent', head).decode().splitlines():
            root_sha, authored, committed = self.git('show', '-s', '--format=%T%n%aI%n%cI', sha).decode().splitlines()
            parents = self.git('show', '-s', '--format=%P', sha).decode().strip().split()
            write_json(root / 'objects' / 'commits' / f'{sha}.json', dict(sha=sha, tree=dict(sha=root_sha), parents=[dict(sha=p) for p in parents], author=dict(date=authored), committer=dict(date=committed)))
            tree(root_sha)
        return root


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    path.chmod(0o600)


def mutate_json(path, change):
    data = json.loads(path.read_text())
    change(data)
    write_json(path, data)


@pytest.fixture
def fixture(tmp_path):
    return Fixture(tmp_path)


def comparable(state):
    result = copy.deepcopy(state)
    result.pop('lastSuccessAt')
    for entry in result['history']:
        for key in ('committedAt', 'authoredAt'):
            entry[key] = datetime.fromisoformat(entry[key]).astimezone(timezone.utc).isoformat()
    return result


def sync_bundle(fixture, bundle, state='offline-state'):
    module = adapter_module()
    bundle = module.ConnectorBundle(bundle, fixture.rules)
    backend = bundle.backend('1')
    engine = 历史引擎_类(fixture.root / state, fixture.rules)
    try:
        return engine.api_同步(backend.metadata, '', backend.head, arg_对象=backend)
    finally:
        engine.api_关闭()


def native(fixture, state='native-state'):
    engine = 历史引擎_类(fixture.root / state, fixture.rules)
    try:
        return engine.api_同步(fixture.metadata, str(fixture.repo))
    finally:
        engine.api_关闭()


def test_real_git_metrics_match_every_commit_and_first_parent_merge(fixture):
    root = fixture.commit({'a.py': '# comment\nx=1\n\n', 'docs/readme.md': '# heading\n', 'vendor/omit.py': 'hidden=1\n', 'large.py': 'x=1\n' * 100, 'opaque.bin': b'\0binary'})
    (fixture.repo / 'link.py').symlink_to('a.py')
    fixture.commit({'b.js': 'const x = 1;\n'})
    fixture.git('checkout', '-b', 'feature')
    side = fixture.commit({'side.py': 'side=1\n'})
    fixture.git('checkout', 'main')
    fixture.commit({'a.py': None, 'renamed.md': '# comment\nx=1\n\n'})
    subprocess.run(['git', '-C', str(fixture.repo), 'merge', '--no-ff', '-qm', 'merge', 'feature'], check=True, env={**os.environ, 'GIT_AUTHOR_DATE': '2024-02-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2024-02-01T00:00:00Z'})
    fixture.git('update-index', '--add', '--cacheinfo', f'160000,{root},submodule')
    fixture.git('commit', '--amend', '--no-edit')
    assert b'160000 commit ' + root.encode() in fixture.git('ls-tree', '-r', 'HEAD')
    assert b'120000 blob ' in fixture.git('ls-tree', '-r', 'HEAD')
    bundle = fixture.write_bundle()
    assert not (bundle / 'objects/commits' / (side + '.json')).exists()
    result = sync_bundle(fixture, bundle)
    assert comparable(result) == comparable(native(fixture))
    assert side not in [item['sha'] for item in result['history']]
    assert 'link.py' not in result['inventory']
    assert 'submodule' not in result['inventory']
    assert result['inventory']['large.py']['metrics'] is None
    assert not list((fixture.root / 'offline-state').glob('objects/*'))


def test_incremental_rollback_and_changed_default_branch(fixture):
    first = fixture.commit({'a.py': 'x=1\n'})
    sync_bundle(fixture, fixture.write_bundle())
    second = fixture.commit({'a.py': 'x=2\ny=3\n'})
    assert comparable(sync_bundle(fixture, fixture.write_bundle('second'))) == comparable(native(fixture))
    fixture.git('reset', '--hard', first)
    assert comparable(sync_bundle(fixture, fixture.write_bundle('rollback'))) == comparable(native(fixture))
    fixture.git('checkout', '--orphan', 'new-default')
    fixture.git('rm', '-rf', '.')
    third = fixture.commit({'new.py': 'new=1\n'})
    fixture.metadata['default_branch'] = 'new-default'
    changed = sync_bundle(fixture, fixture.write_bundle('changed'))
    assert comparable(changed) == comparable(native(fixture))
    assert [entry['sha'] for entry in changed['history']] == [third]
    assert second not in str(changed)


@pytest.mark.parametrize('damage', ['missing_commit', 'missing_tree', 'missing_blob', 'bad_blob', 'bad_blob_sha', 'truncated_tree', 'bad_tree_hash', 'missing_tree_size', 'head_mismatch', 'branch_mismatch', 'cyclic_chain', 'missing_parent_field', 'bad_date'])
def test_missing_or_corrupt_objects_fail_closed(fixture, damage):
    first = fixture.commit({'a.py': 'x=1\n'})
    head = fixture.commit({'a.py': 'x=2\n', 'nested/b.py': 'y=1\n'})
    root = fixture.write_bundle()
    cp = root / 'objects' / 'commits' / f'{head}.json'
    commit = json.loads(cp.read_text())
    tp = root / 'objects' / 'trees' / (commit['tree']['sha'] + '.json')
    bp = next((root / 'objects' / 'blobs').glob('*.json'))
    if damage == 'missing_commit':
        (root / 'objects' / 'commits' / f'{first}.json').unlink()
    elif damage == 'missing_tree':
        tp.unlink()
    elif damage == 'missing_blob':
        bp.unlink()
    elif damage == 'bad_blob':
        mutate_json(bp, lambda d: d.update(content=base64.b64encode(b'wrong').decode()))
    elif damage == 'bad_blob_sha':
        mutate_json(bp, lambda d: d.update(sha='f' * 40))
    elif damage == 'truncated_tree':
        mutate_json(tp, lambda d: d.update(truncated=True))
    elif damage == 'bad_tree_hash':
        mutate_json(tp, lambda d: d['tree'].pop())
    elif damage == 'missing_tree_size':
        mutate_json(tp, lambda d: d['tree'][0].pop('size'))
    elif damage == 'head_mismatch':
        mutate_json(root / 'manifest.json', lambda d: d['repositories'][0].update(verifiedHead=first))
    elif damage == 'branch_mismatch':
        mutate_json(root / 'manifest.json', lambda d: d['repositories'][0].update(verifiedDefaultBranch='other'))
    elif damage == 'cyclic_chain':
        mutate_json(cp, lambda d: d.update(parents=[dict(sha=head)]))
    elif damage == 'missing_parent_field':
        mutate_json(cp, lambda d: d.pop('parents'))
    else:
        mutate_json(cp, lambda d: d['committer'].update(date='2024-01-01'))
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules).validate()


def test_tree_size_disagreement_and_invalid_base64_rejected(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    bp = next((root / 'objects' / 'blobs').glob('*.json'))
    mutate_json(bp, lambda d: d.update(size=100))
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules).validate()
    mutate_json(bp, lambda d: d.update(size=4, content='!!!!'))
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules).validate()


def test_import_starts_from_zero_binds_epoch_and_redacts_private_details(fixture):
    fixture.commit({'secret.py': 'secret=1\n'})
    root = fixture.write_bundle()
    module = adapter_module()
    state = fixture.root / 'imported'
    outcome = module.import_bundle(root, fixture.config, state, 'fresh-source-only', include_private_metrics=True)
    assert outcome['run']['completeness']['complete'] is True
    assert outcome['run']['completeness']['scannedRepositories'] == 1
    assert outcome['public']['summary']['code'] == 1
    encoded = json.dumps(outcome['public'])
    assert 'secret.py' not in encoded
    assert 'secret=1' not in encoded
    assert outcome['public']['datasetEpoch'] == 'fresh-source-only'
    assert outcome['audit']['commitVerification'] == 'github-api-identity-and-first-parent-continuity; not raw-commit-sha-verification'
    with pytest.raises(ValueError, match='empty|fresh|旧|零'):
        module.import_bundle(root, fixture.config, state, 'fresh-source-only', include_private_metrics=True)


def test_incomplete_discovery_or_missing_lineage_member_blocks_import(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    mutate_json(root / 'manifest.json', lambda d: d.update(discoveryComplete=False))
    with pytest.raises(ValueError):
        adapter_module().import_bundle(root, fixture.config, fixture.root / 'state', 'fresh')
    mutate_json(root / 'manifest.json', lambda d: d.update(discoveryComplete=True))
    fixture.config['lineageGroups'] = [dict(id='family', members=['fixture/source', 'fixture/missing'])]
    with pytest.raises(ValueError):
        adapter_module().import_bundle(root, fixture.config, fixture.root / 'state2', 'fresh')


def test_expected_inventory_missing_repo_blocks_import(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    expected = dict(source='github-connector', verifiedAt='2026-10-21T12:00:00Z', repositories=[dict(id='1', name='fixture/source', visibility='private', archived=False), dict(id='2', name='fixture/missing', visibility='private', archived=False)])
    with pytest.raises(ValueError):
        adapter_module().import_bundle(root, fixture.config, fixture.root / 'state', 'fresh', expected_inventory=expected)


def test_scope_cannot_claim_private_capture_is_complete_all_repositories(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    mutate_json(root / 'manifest.json', lambda d: d.update(captureScope='private-only'))
    with pytest.raises(ValueError, match='scope'):
        adapter_module().import_bundle(root, fixture.config, fixture.root / 'wrong-scope', 'fresh')
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'right-scope', 'fresh', private_only=True)
    assert result['audit']['captureScope'] == 'private-only'
    assert result['run']['captureScope'] == 'private-only'
    assert result['public']['summary']['code'] == 0


def test_private_bundle_requires_protected_root_and_rejects_symlinks(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    root.chmod(0o755)
    with pytest.raises(ValueError, match='private|permission'):
        adapter_module().ConnectorBundle(root, fixture.rules)
    root.chmod(0o700)
    bp = next((root / 'objects' / 'blobs').glob('*.json'))
    outside = fixture.root / 'external.json'
    bp.rename(outside)
    bp.symlink_to(outside)
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules).validate()


def test_cli_works_without_credentials_and_writes_only_sanitized_output(fixture):
    fixture.commit({'secret.py': 'x=1\n'})
    root = fixture.write_bundle()
    config = fixture.root / 'config.json'
    write_json(config, fixture.config)
    output = fixture.root / 'stats.json'
    private = fixture.root / 'private.json'
    script = Path(__file__).parents[1] / 'scripts/import-connector-bundle.py'
    args = [os.sys.executable, str(script), str(root), '--config', str(config), '--dataset-epoch', 'fresh', '--state', str(fixture.root / 'state'), '--output', str(output), '--include-private-metrics', '--private-metrics-output', str(private)]
    env = {key: value for key, value in os.environ.items() if 'TOKEN' not in key and 'CREDENTIAL' not in key}
    result = subprocess.run(args, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(output.read_text())['summary']['code'] == 1
    text = output.read_text() + private.read_text()
    assert 'secret.py' not in text
    assert 'x=1' not in text
    assert (fixture.root / 'state/epochs/fresh/stats.sqlite').is_file()
    assert not (fixture.root / 'state/epochs/fresh/objects').exists()


def test_cli_validation_does_not_initialize_any_state(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    mutate_json(root / 'manifest.json', lambda d: d.update(discoveryComplete=False))
    config = fixture.root / 'config.json'
    write_json(config, fixture.config)
    state = fixture.root / 'absent-state'
    result = subprocess.run([os.sys.executable, str(Path(__file__).parents[1] / 'scripts/import-connector-bundle.py'), str(root), '--config', str(config), '--validate-only', '--state', str(state)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert not state.exists()


def test_only_twice_confirmed_api_empty_repository_can_have_null_head(fixture):
    root = fixture.root / 'empty-bundle'
    root.mkdir(mode=0o700)
    entry = dict(metadata=fixture.metadata, head=None, verifiedHead=None, verifiedDefaultBranch='main')
    manifest = dict(schemaVersion=1, source='github-connector', capturedAt='2026-10-21T12:00:00Z', discoveryComplete=True, repositories=[entry])
    write_json(root / 'manifest.json', manifest)
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules)
    entry.update(emptyRepository=True, emptyEvidence=dict(status=409, message='Git Repository is empty.'), verifiedEmptyEvidence=dict(status=404, message='Not Found'))
    write_json(root / 'manifest.json', manifest)
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(root, fixture.rules)
    entry['verifiedEmptyEvidence'] = entry['emptyEvidence'].copy()
    write_json(root / 'manifest.json', manifest)
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'empty-state', 'empty-fresh', include_private_metrics=True)
    assert result['run']['completeness']['complete']
    assert result['private']['repositories'][0]['status'] == 'empty'
    assert result['private']['repositories'][0]['history'] == []


def test_failed_import_does_not_leave_partial_statistics(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    next((root / 'objects' / 'blobs').glob('*.json')).unlink()
    state = fixture.root / 'atomic-state'
    with pytest.raises(ValueError):
        adapter_module().import_bundle(root, fixture.config, state, 'fresh')
    assert not state.exists()
    assert not list(fixture.root.glob('.connector-rebuild-*'))


def test_source_only_rules_skip_data_bytes_and_preserve_binary_blob_semantics(fixture):
    fixture.config['rules'].update(exclude_extensions=['.json', '.jsonc', '.yaml', '.yml', '.xml'], exclude_languages=['JSON', 'YAML', 'XML'])
    fixture.rules = 规则_类(fixture.config['rules'])
    files = {'src/main.py': 'x=1\n# comment\n', 'docs/guide.md': '# Guide\n', 'binary.py': b'\xff\x00original bytes\n'}
    for suffix in ('JSON', 'jsonc', 'yaml', 'yml', 'xml', 'svg'):
        files['src/data.' + suffix] = '{"no":"download"}\n'
    fixture.commit(files)
    bundle = fixture.write_bundle()
    assert len(list((bundle / 'objects/blobs').glob('*.json'))) == 3
    result = sync_bundle(fixture, bundle)
    assert comparable(result) == comparable(native(fixture))
    assert result['history'][0]['metrics'] == dict(code=1, comment=1, blank=0, documentation=1, files=2)
    assert set(result['inventory']) == {'src/main.py', 'docs/guide.md', 'binary.py'}
    assert result['inventory']['binary.py']['metrics'] is None


def test_current_sanitized_private_export_passes_existing_javascript_complete_gate(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    result = adapter_module().import_bundle(fixture.write_bundle(), fixture.config, fixture.root / 'state', 'fresh', include_private_metrics=True)
    output = fixture.root / 'sanitized.json'
    write_json(output, result['private'])
    checker = Path(__file__).parents[1] / 'scripts/metrics.mjs'
    verified = subprocess.run(['node', str(checker), 'validate', str(output), '--complete'], capture_output=True, text=True)
    assert verified.returncode == 0, verified.stderr


def test_cross_scope_tree_reuse_does_not_hide_required_source_blobs(fixture):
    fixture.commit({'vendor/a.py': 'same=1\n', 'src/a.py': 'same=1\n'})
    # Build an ordinary fixture first, then deliberately remove its one required
    # blob. Tree hashes remain genuine and both paths share one subtree SHA.
    bundle = fixture.write_bundle()
    for blob in (bundle / 'objects/blobs').glob('*.json'):
        blob.unlink()
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(bundle, fixture.rules).validate()


@pytest.mark.parametrize('value', [None, True, -1, 0, 1.5, {}, '', '../outside'])
def test_repository_identity_must_be_positive_github_id(fixture, value):
    fixture.commit({'a.py': 'x=1\n'})
    bundle = fixture.write_bundle()
    mutate_json(bundle / 'manifest.json', lambda d: d['repositories'][0]['metadata'].update(id=value))
    with pytest.raises(ValueError):
        adapter_module().ConnectorBundle(bundle, fixture.rules)


def test_private_lineage_replays_all_members_before_daily_export(fixture):
    import shutil
    first = fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    second_root = fixture.root / 'second-source'
    second_root.mkdir()
    second = Fixture(second_root)
    second.metadata.update(id=2, full_name='fixture/derived', archived=True)
    second.commit({'b.py': 'x=1\ny=2\nz=3\n'})
    second_bundle = second.write_bundle()
    shutil.copytree(second_bundle / 'objects', root / 'objects', dirs_exist_ok=True)
    manifest = json.loads((root / 'manifest.json').read_text())
    manifest['repositories'] += json.loads((second_bundle / 'manifest.json').read_text())['repositories']
    write_json(root / 'manifest.json', manifest)
    fixture.config['lineageGroups'] = [dict(id='family', members=['fixture/source', 'fixture/derived'])]
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'group-state', 'fresh', include_private_metrics=True)
    assert result['run']['completeness']['expectedRepositories'] == 2
    assert result['run']['completeness']['scannedRepositories'] == 2
    assert len(result['private']['repositories']) == 1
    group = result['private']['repositories'][0]
    assert group['lineage']['id'] == 'family'
    assert group['history'][-1]['metrics']['code'] == 3
    assert group['status'] == 'active'
    assert first not in json.dumps(result['private'])
    output = fixture.root / 'group-sanitized.json'
    write_json(output, result['private'])
    verified = subprocess.run(['node', str(Path(__file__).parents[1] / 'scripts/metrics.mjs'), 'validate', str(output), '--complete'], capture_output=True, text=True)
    assert verified.returncode == 0, verified.stderr


def test_private_scope_preserves_public_archival_removal_evidence(fixture):
    import hashlib
    fixture.metadata.update(private=False, archived=True)
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    mutate_json(root / 'manifest.json', lambda d: d.update(captureScope='private-only'))
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'state', 'fresh', private_only=True, include_private_metrics=True)
    assert result['private']['repositories'] == []
    assert result['private']['archivedRepositoryKeys'] == [hashlib.sha256(b'poly-tally/repository/1').hexdigest()[:16]]


def test_import_preserves_captured_observation_time_not_import_wall_clock(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    captured = '2025-01-02T03:04:05Z'
    mutate_json(root / 'manifest.json', lambda d: d.update(capturedAt=captured))
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'state', 'fresh', include_private_metrics=True)
    assert result['private']['repositories'][0]['lastSuccessAt'] == captured
    assert result['private']['generatedAt'] == captured
    assert result['run']['finishedAt'] != captured


def test_repository_final_ref_observation_time_overrides_capture_start(fixture):
    fixture.commit({'a.py': 'x=1\n'})
    root = fixture.write_bundle()
    verified = '2026-10-21T12:30:00Z'
    mutate_json(root / 'manifest.json', lambda d: d['repositories'][0].update(verifiedAt=verified))
    result = adapter_module().import_bundle(root, fixture.config, fixture.root / 'state', 'fresh', include_private_metrics=True)
    assert result['private']['repositories'][0]['lastSuccessAt'] == verified
