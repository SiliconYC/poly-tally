"""Read-only transport measurements use real Git objects, not fake metrics."""
import base64
import importlib.util
import json
from pathlib import Path

import pytest

from test_connector_bundle import Fixture, mutate_json, write_json


def benchmark_module():
    path = Path(__file__).resolve().parents[1] / 'scripts/bench-history-transport.py'
    assert path.is_file(), 'offline transport benchmark is not implemented'
    spec = importlib.util.spec_from_file_location('history_transport_benchmark', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_bundle(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.commit({'src/a.py': 'x=1\n', 'vendor/a.py': 'x=1\n'})
    fixture.commit({'src/a.py': 'x=2\n'})
    root = fixture.write_bundle()
    # The shared fixture writer deduplicates tree SHA before evaluating its
    # path. The old src subtree was first seen under vendor at the latest HEAD;
    # fill its legitimate eligible blob from the real Git object, not a mock.
    oid = fixture.git('rev-parse', 'HEAD~1:src/a.py').decode().strip()
    write_json(root / 'objects/blobs' / f'{oid}.json',
               dict(sha=oid, encoding='base64', content=base64.b64encode(fixture.git('cat-file', 'blob', oid)).decode()))
    return fixture, root


def test_shared_history_dedup_and_path_rules(tmp_path):
    fixture, root = make_bundle(tmp_path)
    manifest = json.loads((root / 'manifest.json').read_text())
    clone = json.loads(json.dumps(manifest['repositories'][0]))
    clone['metadata'].update(id=2, full_name='fixture/descendant')
    manifest['repositories'].append(clone)
    write_json(root / 'manifest.json', manifest)
    module = benchmark_module()
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    coverage = report['coverage']
    assert coverage['repository_count'] == 2
    assert coverage['complete_first_parent_chains'] == 2
    assert coverage['fully_materialized_repositories'] == 2
    reuse = report['reuse']
    assert reuse['commits'] == {'per_repository_sum': 4, 'global_unique': 2, 'saved': 2}
    assert reuse['eligible_blobs'] == {'per_repository_sum': 4, 'global_unique': 2, 'saved': 2}
    # Same content under vendor must not be counted as an eligible path.
    assert report['naive_snapshot_work']['eligible_blob_occurrences'] == 4
    assert report['objects']['blobs']['count'] == 2


def test_corrupt_blob_is_rejected(tmp_path):
    fixture, root = make_bundle(tmp_path)
    blob = next((root / 'objects/blobs').glob('*.json'))
    mutate_json(blob, lambda item: item.update(content='eD05Cg=='))
    module = benchmark_module()
    with pytest.raises(ValueError, match='SHA|size'):
        module.run_benchmark(module.freeze_capture(root), fixture.config)


def test_missing_blob_is_partial_not_complete(tmp_path):
    fixture, root = make_bundle(tmp_path)
    next((root / 'objects/blobs').glob('*.json')).unlink()
    module = benchmark_module()
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    assert report['coverage']['missing_eligible_blob_objects'] == 1
    assert report['coverage']['fully_materialized_repositories'] == 0
    assert report['coverage']['capture_complete'] is False


def test_freeze_does_not_read_new_objects_or_write_capture(tmp_path):
    fixture, root = make_bundle(tmp_path)
    module = benchmark_module()
    frozen = module.freeze_capture(root)
    old_count = len(frozen['files'])
    extra = root / 'objects/blobs' / ('f' * 40 + '.json')
    write_json(extra, {'sha': 'f' * 40, 'invalid': True})
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    report = module.run_benchmark(frozen, fixture.config)
    assert report['snapshot']['file_count'] == old_count
    assert report['objects']['blobs']['count'] == 2
    assert before == {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}


def test_pack_roundtrips_only_real_tree_and_blob_objects(tmp_path):
    fixture, root = make_bundle(tmp_path)
    module = benchmark_module()
    report = module.run_benchmark(module.freeze_capture(root), fixture.config, pack=True)
    packed = report['pack']
    assert packed['verified_roundtrip'] is True
    assert packed['object_count'] == report['objects']['trees']['count'] + report['objects']['blobs']['count']
    assert packed['raw_commit_objects'] == 0
    assert packed['pack_bytes'] > 0
    assert packed['complete_clone'] is False


def test_symlink_input_is_rejected(tmp_path):
    fixture, root = make_bundle(tmp_path)
    victim = next((root / 'objects/blobs').glob('*.json'))
    outside = tmp_path / 'outside.json'
    outside.write_bytes(victim.read_bytes())
    victim.unlink()
    victim.symlink_to(outside)
    module = benchmark_module()
    with pytest.raises(ValueError, match='symlink'):
        module.freeze_capture(root)


def test_timing_intervals_separate_activity_from_unobserved_gaps(tmp_path):
    module = benchmark_module()
    records = [[
        {'kind': 'blob', 'startedAt': '2026-10-21T12:00:00Z', 'finishedAt': '2026-10-21T12:00:01Z'},
        {'kind': 'tree', 'startedAt': '2026-10-21T12:00:00Z', 'finishedAt': '2026-10-21T12:00:02Z'},
    ], [
        {'kind': 'blob', 'startedAt': '2026-10-21T12:00:05Z', 'finishedAt': '2026-10-21T12:00:06Z'},
    ]]
    result = module.summarize_timing(records)
    assert result['observed_wall_span_seconds'] == 6
    assert result['tool_activity_union_seconds'] == 3
    assert result['unobserved_gap_seconds'] == 3
    assert result['summed_tool_seconds'] == 4
    assert result['by_kind']['blob']['count'] == 2


def test_proposed_pruning_is_path_sensitive_and_not_active(tmp_path):
    fixture, root = make_bundle(tmp_path)
    module = benchmark_module()
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    proposal = report['proposed_exclusion_pruning']
    assert proposal['active'] is False
    # vendor's tree also appears as src in an older commit: cannot omit it.
    assert proposal['known_unique_trees_saved'] == 0
    fixture.commit({'vendor/private.py': 'unique=1\n'})
    root = fixture.write_bundle('more')
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    assert report['proposed_exclusion_pruning']['known_unique_trees_saved'] == 1
    fixture.config['rules']['exclude'] = ['**/vendor/*']
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    assert report['proposed_exclusion_pruning']['known_unique_trees_saved'] == 0


def test_report_never_exports_private_timing_labels_or_object_identities(tmp_path):
    fixture, root = make_bundle(tmp_path)
    write_json(root / 'timing/batch.json', [dict(kind='fixture/source-private-path',
               startedAt='2026-10-21T12:00:00Z', finishedAt='2026-10-21T12:00:01Z')])
    module = benchmark_module()
    report = module.run_benchmark(module.freeze_capture(root), fixture.config)
    serialized = json.dumps(report)
    assert 'fixture/source' not in serialized
    assert 'src/a.py' not in serialized
    assert report['timing']['by_kind']['other']['count'] == 1
    for path in (root / 'objects').rglob('*.json'):
        assert path.stem not in serialized
