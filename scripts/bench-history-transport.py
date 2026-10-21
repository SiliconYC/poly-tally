#!/usr/bin/env python3
"""Offline, aggregate-only benchmark of a frozen connector capture.

Never fetches, mutates a capture, reads credentials, or creates fake commits.
Optional real tree/blob packs exist only in a private temporary directory.
This is a partial-object transport probe, NOT an import or clone validator.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from functools import cache
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import tempfile
import time
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from poly_tally.connector_bundle import ConnectorBundle, _hash, _no_duplicate_keys
from poly_tally.rules import 规则_类


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def freeze_capture(root):
    """Freeze a manifest and enumerated immutable files; ignore later arrivals.

    This is a recorded observation window, not an atomic database snapshot.
    No capture database, terminal, source file, or remote is touched.
    """
    started, observed = time.perf_counter(), utc_now()
    root = Path(root)
    if root.is_symlink():
        raise ValueError('capture root must not be a symlink')
    root = root.resolve()
    files = {}
    inventory = [root / 'manifest.json']
    for kind in ('commits', 'trees', 'blobs'):
        directory = root / 'objects' / kind
        if directory.is_symlink() or directory.parent.is_symlink():
            raise ValueError('capture object directories must not be symlinks')
        inventory.extend(sorted(directory.glob('*.json')))
    timing = root / 'timing'
    if timing.is_symlink():
        raise ValueError('timing directory must not be a symlink')
    inventory.extend(sorted(timing.glob('*.json')))
    for path in inventory:
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('capture file must not be a symlink or escape root')
        relative = path.relative_to(root).as_posix()
        if relative.startswith('objects/') and not re.fullmatch(r'[0-9a-f]{40}\.json', path.name):
            raise ValueError('invalid object filename')
        with path.open('rb') as stream:
            before = os.fstat(stream.fileno())
            raw = stream.read()
            after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('capture file changed while freezing')
        files[relative] = raw
    inventory_digest = hashlib.sha256()
    for name, raw in sorted(files.items()):
        inventory_digest.update(name.encode() + b'\0' + hashlib.sha256(raw).digest())
    return dict(root=root, files=files, observed_at=observed, frozen_at=utc_now(),
                sha256=inventory_digest.hexdigest(), seconds=time.perf_counter() - started)


class FrozenBundle(ConnectorBundle):
    def __init__(self, frozen, rules):
        self.frozen = frozen
        super().__init__(frozen['root'], rules)

    def _read(self, relative):
        try:
            item = json.loads(self.frozen['files'][relative], object_pairs_hook=_no_duplicate_keys)
        except (KeyError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('missing or malformed frozen object') from exc
        if not isinstance(item, dict):
            raise ValueError('frozen object must be a JSON object')
        return item


def summarize_timing(batches):
    intervals, by_kind = [], defaultdict(list)
    for batch in batches:
        for item in batch:
            begin = datetime.fromisoformat(item['startedAt'].replace('Z', '+00:00')).timestamp()
            end = datetime.fromisoformat(item['finishedAt'].replace('Z', '+00:00')).timestamp()
            if end < begin:
                raise ValueError('negative recorded tool duration')
            intervals.append((begin, end))
            kind = item['kind']
            # Timing labels are input too: never export arbitrary raw strings.
            if kind not in {'metadata', 'head', 'commit', 'commits', 'tree', 'tree_recursive',
                            'blob', 'verify_head', 'verify_metadata', 'inventory'}:
                kind = 'other'
            by_kind[kind].append(end - begin)
    if not intervals:
        return {'sample_count': 0}
    intervals.sort()
    left, right = intervals[0]
    active = 0.0
    for begin, end in intervals[1:]:
        if begin > right:
            active += right - left
            left, right = begin, end
        else:
            right = max(right, end)
    active += right - left
    span = max(end for _, end in intervals) - intervals[0][0]
    return dict(sample_count=len(intervals), observed_wall_span_seconds=span,
                tool_activity_union_seconds=active, unobserved_gap_seconds=span - active,
                summed_tool_seconds=sum(end - begin for begin, end in intervals),
                by_kind={kind: dict(count=len(values), mean_seconds=sum(values) / len(values),
                                   p50_seconds=sorted(values)[math.ceil(len(values) * .5) - 1],
                                   p95_seconds=sorted(values)[math.ceil(len(values) * .95) - 1])
                         for kind, values in sorted(by_kind.items())})


def tree_bytes(entries):
    encoded = []
    for entry in entries:
        name = entry['path'].encode('utf-8')
        encoded.append((name + (b'/' if entry['type'] == 'tree' else b''),
                        entry['mode'].lstrip('0').encode() + b' ' + name + b'\0' + bytes.fromhex(entry['sha'])))
    return b''.join(data for _, data in sorted(encoded))


def pack_objects(objects):
    """Round-trip only verified tree/blob bytes, without refs or raw commits."""
    if not objects:
        return dict(object_count=0, raw_commit_objects=0, pack_bytes=0,
                    verified_roundtrip=True, complete_clone=False)
    # Prevent inherited repository/config variables from redirecting local Git.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    def git(repository, *args, data=None):
        return subprocess.run(['git', '--git-dir=' + str(repository), *args], input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, env=env).stdout
    cpu_start = resource.getrusage(resource.RUSAGE_CHILDREN)
    with tempfile.TemporaryDirectory(prefix='poly-transport-', ignore_cleanup_errors=False) as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        repository, replay = root / 'objects.git', root / 'replay.git'
        git(repository, 'init', '--bare', '--quiet')
        git(replay, 'init', '--bare', '--quiet')
        started = time.perf_counter()
        loose_bytes = 0
        for oid, (kind, raw) in objects.items():
            if kind not in {'tree', 'blob'} or _hash(kind, raw) != oid:
                raise ValueError('pack input must be a verified real tree/blob object')
            target = repository / 'objects' / oid[:2] / oid[2:]
            target.parent.mkdir(exist_ok=True)
            compressed = zlib.compress(kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw)
            target.write_bytes(compressed)
            loose_bytes += len(compressed)
        loose_seconds = time.perf_counter() - started
        object_list = ''.join(oid + '\n' for oid in sorted(objects)).encode()
        started = time.perf_counter()
        packed = git(repository, 'pack-objects', '--stdout', '--delta-base-offset',
                     '--window=10', '--depth=50', '--threads=1', data=object_list)
        pack_seconds = time.perf_counter() - started
        started = time.perf_counter()
        git(replay, 'index-pack', '--stdin', data=packed)
        index_seconds = time.perf_counter() - started
        started = time.perf_counter()
        output = io.BytesIO(git(replay, 'cat-file', '--batch', data=object_list))
        for expected in sorted(objects):
            oid, kind, size = output.readline().decode('ascii').rstrip('\n').split()
            content = output.read(int(size))
            if output.read(1) != b'\n' or oid != expected or _hash(kind, content) != oid:
                raise ValueError('packed object round-trip failed')
            if objects[oid] != (kind, content):
                raise ValueError('packed object bytes changed')
        if output.read():
            raise ValueError('unexpected trailing packed output')
        replay_seconds = time.perf_counter() - started
    cpu_end = resource.getrusage(resource.RUSAGE_CHILDREN)
    return dict(object_count=len(objects), raw_commit_objects=0, pack_bytes=len(packed),
                loose_zlib_bytes=loose_bytes, prepare_loose_seconds=loose_seconds,
                pack_seconds=pack_seconds, index_seconds=index_seconds,
                replay_verify_seconds=replay_seconds, verified_roundtrip=True,
                git_child_cpu_seconds=(cpu_end.ru_utime + cpu_end.ru_stime - cpu_start.ru_utime - cpu_start.ru_stime),
                complete_clone=False, window=10, depth=50, threads=1)


def reuse_summary(rows, key):
    unique = set().union(*(row[key] for row in rows)) if rows else set()
    total = sum(len(row[key]) for row in rows)
    return dict(per_repository_sum=total, global_unique=len(unique), saved=total - len(unique))


def run_benchmark(frozen, config, *, pack=False):
    wall, cpu = time.perf_counter(), time.process_time()
    rules = 规则_类(config['rules'])
    bundle = FrozenBundle(frozen, rules)
    identities = {kind: sorted(name.split('/')[-1][:-5] for name in frozen['files']
                              if name.startswith(f'objects/{kind}/'))
                  for kind in ('commits', 'trees', 'blobs')}
    objects = {}
    for oid in identities['commits']:
        bundle.commit(oid)  # Metadata/parent/date identity, NOT raw commit SHA.
    for oid in identities['trees']:
        objects[oid] = ('tree', tree_bytes(bundle.tree(oid)))
    for oid in identities['blobs']:
        objects[oid] = ('blob', bundle.blob(oid, sys.maxsize))
    validated_seconds = time.perf_counter() - wall
    trees, commits, present_blobs = bundle._trees, bundle._commits, set(identities['blobs'])

    @cache
    def tree_closure(oid):
        reachable, visits = {oid}, 1
        for entry in trees.get(oid, []):
            if entry['type'] == 'tree':
                descendants, count = tree_closure(entry['sha'])
                reachable.update(descendants)
                visits += count
        return frozenset(reachable), visits

    @cache
    def eligible(oid, prefix):
        blobs, occurrences, unknown_sizes = set(), 0, set()
        for entry in trees.get(oid, []):
            path = prefix + entry['path']
            if entry['type'] == 'tree':
                descendants, count, unknown = eligible(entry['sha'], path + '/')
                blobs.update(descendants)
                occurrences += count
                unknown_sizes.update(unknown)
            elif entry['mode'] in {'100644', '100755'} and rules.api_语言(path) is not None:
                size = bundle._sizes.get(entry['sha'])
                if size is None:
                    unknown_sizes.add(entry['sha'])
                elif size <= rules.配置['max_blob_bytes']:
                    blobs.add(entry['sha'])
                    occurrences += 1
        return frozenset(blobs), occurrences, frozenset(unknown_sizes)

    exclusion_prefixes = [pattern[:-3] for pattern in rules.配置['exclude'] if pattern.endswith('/**')]

    @cache
    def proposed_required_trees(oid, prefix):
        required = {oid}
        for entry in trees.get(oid, []):
            if entry['type'] != 'tree':
                continue
            directory = prefix + entry['path']
            # Only this suffix has a proof that EVERY descendant is excluded.
            # Never apply artifact/source_preserve or arbitrary glob pruning.
            if not any(rules.api_匹配(directory, pattern) for pattern in exclusion_prefixes):
                required.update(proposed_required_trees(entry['sha'], directory + '/'))
        return frozenset(required)

    rows, roots, head_trees, missing_commits, naive_trees, naive_blobs = [], set(), set(), set(), 0, 0
    for item in bundle.repositories.values():
        row = dict(name=item['metadata']['full_name'].casefold(), commits=set(), trees=set(), eligible_blobs=set(), unknown_sizes=set(), chain_complete=True)
        current, seen = item['head'], set()
        while current is not None:
            if current in seen:
                raise ValueError('cyclic first-parent chain')
            seen.add(current)
            if current not in commits:
                missing_commits.add(current)
                row['chain_complete'] = False
                break
            row['commits'].add(current)
            root = commits[current]['tree']['sha']
            roots.add(root)
            reachable, count = tree_closure(root)
            if current == item['head']:
                head_trees.update(reachable)
            row['trees'].update(reachable)
            naive_trees += count
            blobs, count, unknown = eligible(root, '')
            row['eligible_blobs'].update(blobs)
            row['unknown_sizes'].update(unknown)
            naive_blobs += count
            parents = commits[current]['parents']
            current = parents[0]['sha'] if parents else None
        row['missing_trees'] = row['trees'] - trees.keys()
        row['missing_blobs'] = row['eligible_blobs'] - present_blobs
        row['materialized'] = row['chain_complete'] and not (row['missing_trees'] or row['missing_blobs'] or row['unknown_sizes'])
        row['declared_complete'] = (item.get('captureStatus', 'complete') == 'complete'
                                    and item['head'] == item['verifiedHead']
                                    and item['metadata']['default_branch'] == item.get('verifiedDefaultBranch'))
        rows.append(row)
    union = lambda key: set().union(*(row[key] for row in rows)) if rows else set()
    proposed_trees = set().union(*(proposed_required_trees(root, '') for root in roots)) if roots else set()
    known_pruned = (union('trees') - proposed_trees) & trees.keys()
    complete = (bundle.manifest['discoveryComplete'] and all(row['materialized'] and row['declared_complete'] for row in rows))
    report = dict(schema_version=1,
                  snapshot=dict(observed_at=frozen['observed_at'], frozen_at=frozen['frozen_at'],
                                inventory_sha256=frozen['sha256'], file_count=len(frozen['files']),
                                freeze_read_seconds=frozen['seconds'],
                                capture_manifest_observed_at=bundle.manifest['capturedAt'],
                                observation_is_atomic=False),
                  verification=dict(blob='raw-git-sha1', tree='raw-git-sha1', commit='API identity and parent continuity; no raw commit bytes'),
                  coverage=dict(repository_count=len(rows), capture_complete=complete,
                                manifest_discovery_complete=bundle.manifest['discoveryComplete'],
                                declared_complete_repositories=sum(row['declared_complete'] for row in rows),
                                complete_first_parent_chains=sum(row['chain_complete'] for row in rows),
                                fully_materialized_repositories=sum(row['materialized'] for row in rows),
                                missing_commit_objects=len(missing_commits), missing_tree_objects=len(union('missing_trees')),
                                missing_eligible_blob_objects=len(union('missing_blobs')), unknown_size_objects=len(union('unknown_sizes'))),
                  objects={kind: dict(count=len(identities[kind]), json_bytes=sum(len(raw) for name, raw in frozen['files'].items() if name.startswith(f'objects/{kind}/')),
                                      **({'raw_bytes': sum(len(objects[oid][1]) for oid in identities[kind])} if kind != 'commits' else {}))
                           for kind in identities},
                  reuse={key: reuse_summary(rows, key) for key in ('commits', 'trees', 'eligible_blobs')},
                  lineage_groups=[dict(member_count=len(selected), reuse={key: reuse_summary(selected, key) for key in ('commits', 'trees', 'eligible_blobs')})
                                  for group in config.get('lineageGroups', [])
                                  for selected in [[row for row in rows if row['name'] in {name.casefold() for name in group['members']}]]],
                  naive_snapshot_work=dict(tree_occurrences=naive_trees, eligible_blob_occurrences=naive_blobs,
                                           scope='known reachable objects only; missing subtrees hide further work'),
                  proposed_exclusion_pruning=dict(active=False, contract='statistics-required closure, not full raw tree audit',
                                                 known_unique_trees_saved=len(known_pruned),
                                                 known_tree_raw_bytes_saved=sum(len(objects[oid][1]) for oid in known_pruned),
                                                 known_tree_json_bytes_saved=sum(len(frozen['files'][f'objects/trees/{oid}.json']) for oid in known_pruned),
                                                 observed_missing_frontier_trees_avoided=len(union('missing_trees') - proposed_trees),
                                                 required_tree_identities_in_observed_graph=len(proposed_trees)),
                  tree_strategy=dict(unique_commit_roots=len(roots), trees_in_pinned_heads=len(head_trees),
                                     trees_across_history=len(union('trees')), known_trees=len(trees),
                                     commit_pages_100_information_floor=sum(math.ceil(len(row['commits']) / 100) for row in rows)),
                  timing=summarize_timing([json.loads(raw) for name, raw in frozen['files'].items() if name.startswith('timing/')]),
                  local=dict(validate_objects_seconds=validated_seconds, analyze_wall_seconds=time.perf_counter() - wall,
                             analyze_cpu_seconds=time.process_time() - cpu, cache_state='OS cache uncontrolled; in-memory frozen input'))
    # A compressed metadata sidecar is not equivalent to original commit objects.
    metadata = b'\n'.join(frozen['files'][f'objects/commits/{oid}.json'] for oid in identities['commits'])
    report['objects']['commits']['zlib_metadata_bytes'] = len(zlib.compress(metadata))
    if pack:
        report['pack'] = pack_objects(objects)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--pack', action='store_true', help='Benchmark real partial tree/blob pack in disposable private scratch')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    report = run_benchmark(freeze_capture(args.capture), config, pack=args.pack)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        # No source paths, object IDs, stderr or source bytes in public output.
        print(f'Transport benchmark refused: {type(exc).__name__}', file=sys.stderr)
        raise SystemExit(1)
