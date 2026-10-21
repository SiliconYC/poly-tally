#!/usr/bin/env python3
"""Reproducible offline history benchmark; no network or private inputs.

Each measured scenario runs in a fresh interpreter against the selected source
tree. The fixture has genuine content-addressed Git trees/blobs and synthetic
commit metadata. ``local-cold-stage`` copies raw JSON into an empty directory;
it does NOT measure network acquisition or promise a cold OS page cache.
"""
import argparse
import base64
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import tempfile
import time


SCENARIOS = ('local-cold-stage', 'raw-present-stats-empty', 'incremental')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def git_hash(kind, raw):
    return hashlib.sha1(kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded(value))


def build_fixture(root, config, commits, files, group_size, blob_pool):
    """Create once outside measured regions, without checkout or subprocess Git."""
    root.mkdir(mode=0o700)
    bundle = root / 'full'
    bundle.mkdir(mode=0o700)
    objects = bundle / 'objects'
    for kind in ('commits', 'trees', 'blobs'):
        (objects / kind).mkdir(parents=True)
    source_bytes = {}

    def blob(content):
        oid = git_hash('blob', content)
        source_bytes[oid] = len(content)
        write_json(objects / 'blobs' / f'{oid}.json', dict(sha=oid, size=len(content), encoding='base64', content=base64.b64encode(content).decode()))
        return dict(mode='100644', type='blob', sha=oid, size=len(content))

    def tree(entries):
        parts = []
        values = []
        for name, value in entries.items():
            values.append(dict(path=name, **value))
            raw_name = name.encode()
            key = raw_name + (b'/' if value['type'] == 'tree' else b'')
            raw = value['mode'].lstrip('0').encode() + b' ' + raw_name + b'\0' + bytes.fromhex(value['sha'])
            parts.append((key, raw))
        oid = git_hash('tree', b''.join(value for _, value in sorted(parts)))
        write_json(objects / 'trees' / f'{oid}.json', dict(sha=oid, truncated=False, tree=values))
        return dict(mode='040000', type='tree', sha=oid)

    pool = [blob(f'# fixed fixture {index}\ndef value_{index}():\n    return {index}\n'.encode()) for index in range(min(files, blob_pool))]
    packages = {}
    for offset in range(0, files, group_size):
        packages[f'pkg{offset // group_size:04d}'] = tree({f'part{index - offset:04d}.py': pool[index % len(pool)] for index in range(offset, min(offset + group_size, files))})
    previous = None
    heads = []
    for index in range(commits):
        changing = blob(f'# changing fixture\ncurrent = {index}\n'.encode())
        src = tree({**packages, 'current.py': changing})
        top = tree({'src': src})
        moment = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index)
        stamp = moment.isoformat()
        raw_commit = f'tree {top["sha"]}\n' + (f'parent {previous}\n' if previous else '')
        raw_commit += f'author Fixture <fixture@example.invalid> {int(moment.timestamp())} +0000\ncommitter Fixture <fixture@example.invalid> {int(moment.timestamp())} +0000\n\nfixture {index}\n'
        head = git_hash('commit', raw_commit.encode())
        write_json(objects / 'commits' / f'{head}.json', dict(sha=head, tree=dict(sha=top['sha']), parents=[dict(sha=previous)] if previous else [], author=dict(date=stamp), committer=dict(date=stamp)))
        previous = head
        heads.append(head)
    metadata = dict(id=1, full_name='fixture/history-benchmark', default_branch='main', private=False, archived=False, fork=False)

    def manifest(head):
        return dict(schemaVersion=1, source='github-connector', captureScope='all', capturedAt='2026-10-21T00:00:00Z', discoveryComplete=True, repositories=[dict(metadata=metadata, head=head, verifiedHead=head, verifiedDefaultBranch='main')])

    write_json(bundle / 'manifest.json', manifest(heads[-1]))
    prefix = root / 'prefix'
    shutil.copytree(bundle, prefix, copy_function=os.link)
    # Unlink the hard-linked manifest before replacing only the prefix HEAD.
    (prefix / 'manifest.json').unlink()
    write_json(prefix / 'manifest.json', manifest(heads[-2]))
    write_json(root / 'config.json', config)
    counts = {kind: len(list((objects / kind).iterdir())) for kind in ('commits', 'trees', 'blobs')}
    info = dict(kind='synthetic-high-reuse-history', commits=commits, stableFiles=files, filesAtHead=files + 1, groupSize=group_size,
                stableBlobPool=len(pool), uniqueObjects=counts, uniqueSourceBytes=sum(source_bytes.values()),
                rawJsonBytes=sum(path.stat().st_size for path in bundle.rglob('*.json')),
                rulesSha256=hashlib.sha256(encoded(config['rules'])).hexdigest(),
                identity='SHA-1-valid Git tree/blob bytes and deterministic synthetic API commit metadata; not user repository data')
    write_json(root / 'fixture.json', info)
    return info


def state_digest(state):
    # Wall-clock observation time is deliberately not part of equivalence.
    comparable = {key: value for key, value in state.items() if key != 'lastSuccessAt'}
    return hashlib.sha256(encoded(comparable)).hexdigest()


def source_digest(root):
    code_hash = hashlib.sha256()
    for path in sorted((root / 'poly_tally').glob('*.py')):
        code_hash.update(path.name.encode() + b'\0' + path.read_bytes())
    return code_hash.hexdigest()


def worker(args):
    code_digest = source_digest(args.code_root)
    sys.path.insert(0, str(args.code_root.resolve()))
    from poly_tally.connector_bundle import ConnectorBundle
    from poly_tally.engine import 历史引擎_类
    from poly_tally.rules import 规则_类

    root, state = args.fixture, args.state
    if args.worker == 'incremental':
        if not (state / 'stats.sqlite').is_file():
            raise RuntimeError('incremental benchmark requires its prepared prefix database')
    elif state.exists():
        raise RuntimeError('cold/full benchmark requires an absent temporary state target')
    config = json.loads((root / 'config.json').read_text())
    bundle_path = root / ('prefix' if args.worker == 'setup-prefix' else 'full')
    raw_reads, path_checks = Counter(), 0
    original_read = ConnectorBundle._read
    original_language = 规则_类.api_语言

    def counted_read(self, relative):
        raw_reads[str(relative).split('/')[1] if str(relative).startswith('objects/') else 'manifest'] += 1
        return original_read(self, relative)

    def counted_language(self, path):
        nonlocal path_checks
        path_checks += 1
        return original_language(self, path)

    ConnectorBundle._read = counted_read
    规则_类.api_语言 = counted_language
    profile = None
    if args.profile_output:
        import cProfile
        profile = cProfile.Profile()
        profile.enable()
    started = time.perf_counter()
    stage_seconds = 0.0
    if args.worker == 'local-cold-stage':
        local = state.parent / 'staged-raw'
        tick = time.perf_counter()
        shutil.copytree(bundle_path, local)
        stage_seconds = time.perf_counter() - tick
        bundle_path = local
    rules = 规则_类(config['rules'])
    tick = time.perf_counter()
    bundle = ConnectorBundle(bundle_path, rules)
    audit = bundle.validate()
    validation_seconds = time.perf_counter() - tick
    validation_counts = dict(rawReads=dict(raw_reads), pathChecks=path_checks)
    tick = time.perf_counter()
    engine = 历史引擎_类(state, rules)
    try:
        backend = bundle.backend('1')
        result = engine.api_同步(backend.metadata, '', backend.head, arg_对象=backend)
        counters = engine.计数.copy()
        db_counts = {table: engine.数据库.连接.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in ('repositories', 'blobs')}
    finally:
        engine.api_关闭()
    replay_seconds = time.perf_counter() - tick
    total_seconds = time.perf_counter() - started
    if profile:
        profile.disable()
        profile.dump_stats(str(args.profile_output))
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == 'darwin':
        peak_rss /= 1024
    if source_digest(args.code_root) != code_digest:
        raise RuntimeError('source changed during measurement; retry against a stable checkout')
    output = dict(scenario=args.worker, codeSha256=code_digest, timingsSeconds=dict(rawStage=stage_seconds, validation=validation_seconds, replay=replay_seconds, total=total_seconds),
                  peakRssKiB=int(peak_rss), validationCounts=validation_counts, totalCounts=dict(rawReads=dict(raw_reads), pathChecks=path_checks),
                  engineCounters=counters, databaseRows=db_counts, snapshotCount=len(result['history']),
                  outputSha256=state_digest(result), auditCounts={key: audit[key] for key in ('verifiedTrees', 'verifiedBlobs', 'apiCommits')})
    print(json.dumps(output, sort_keys=True))


def command(args, scenario, state, profile_output=None):
    cmd = [sys.executable, str(Path(__file__).resolve()), '--worker', scenario, '--code-root', str(args.code_root.resolve()), '--fixture', str(args.fixture.resolve()), '--state', str(state)]
    if profile_output:
        cmd += ['--profile-output', str(profile_output)]
    completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def controller(args):
    fixture_temporary = tempfile.TemporaryDirectory(prefix='poly-rebuild-fixture-') if args.fixture is None else None
    try:
        if fixture_temporary:
            args.fixture = Path(fixture_temporary.name) / 'fixture'
        if not args.fixture.exists():
            config = json.loads(args.config.read_text())
            build_fixture(args.fixture, config, args.commits, args.files, args.group_size, args.blob_pool)
        info = json.loads((args.fixture / 'fixture.json').read_text())
        measurements = []
        for repeat in range(args.repeats):
            for scenario in args.scenarios:
                with tempfile.TemporaryDirectory(prefix='poly-rebuild-measure-') as temporary:
                    state = Path(temporary) / 'state'
                    if scenario == 'incremental':
                        command(args, 'setup-prefix', state)
                    elif state.exists():
                        raise RuntimeError('fresh-state benchmark target unexpectedly exists')
                    profile_output = None
                    if args.profile_dir:
                        args.profile_dir.mkdir(parents=True, exist_ok=True)
                        profile_output = args.profile_dir / f'{args.label}-{scenario}-{repeat}.prof'
                    measurement = command(args, scenario, state, profile_output)
                    measurement['repeat'] = repeat
                    measurements.append(measurement)
                    print(f'{args.label} {scenario} #{repeat}: {measurement["timingsSeconds"]["total"]:.6f}s', file=sys.stderr)
        digests = {item['outputSha256'] for item in measurements}
        if len(digests) != 1:
            raise RuntimeError('full rebuild and incremental produced different canonical states')
        code_digests = {item['codeSha256'] for item in measurements}
        if len(code_digests) != 1:
            raise RuntimeError('source changed between scenarios; retry against a stable checkout')
        output = dict(label=args.label, fixture=info, python=sys.version.split()[0], codeRoot=str(args.code_root.resolve()), codeSha256=code_digests.pop(),
                      operation='connector validation + engine sync; excludes fixture creation, export/publication, and interpreter startup',
                      caveats=['No network transport measured. True network-cold cost is unknown.',
                               'local-cold-stage copies local raw JSON into an empty directory; OS page cache is not flushed.',
                               'incremental retains prefix statistics, but reopens and revalidates raw inputs in a fresh process; prefix setup is unmeasured.',
                               'Inputs are synthetic high-reuse history, not a claim about all repositories.'],
                      equivalentAcrossScenarios=True, measurements=measurements)
        text = json.dumps(output, indent=2, sort_keys=True) + '\n'
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text)
        print(text, end='')
    finally:
        if fixture_temporary:
            fixture_temporary.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[1] / 'config.json')
    parser.add_argument('--fixture', type=Path, help='Create here if absent; reuse unchanged if present')
    parser.add_argument('--commits', type=int, default=500)
    parser.add_argument('--files', type=int, default=2000)
    parser.add_argument('--group-size', type=int, default=20)
    parser.add_argument('--blob-pool', type=int, default=100)
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--scenarios', choices=SCENARIOS, nargs='+', default=list(SCENARIOS))
    parser.add_argument('--label', default='candidate')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--profile-dir', type=Path, help='Optional cProfile outputs; profiling changes measured timings')
    parser.add_argument('--worker', choices=(*SCENARIOS, 'setup-prefix'), help=argparse.SUPPRESS)
    parser.add_argument('--state', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--profile-output', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not (args.code_root / 'poly_tally' / 'connector_bundle.py').is_file():
        parser.error('code-root must contain poly_tally/connector_bundle.py')
    if args.commits < 2 or min(args.files, args.group_size, args.blob_pool, args.repeats) < 1:
        parser.error('commits must be >= 2; other sizes/repeats must be positive')
    if args.worker:
        if args.fixture is None or args.state is None:
            parser.error('worker requires fixture and state')
        worker(args)
    else:
        controller(args)


if __name__ == '__main__':
    main()
