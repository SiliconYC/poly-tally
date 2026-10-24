"""Native Git collection with an external, read-only credential boundary.

Inventory is metadata only, exported from an existing authorized discovery channel.
This module never opens a secret file or invokes `git credential fill`.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import requests

from poly_tally.collector import 采集器_类
from poly_tally.git import Git对象_类, 缓存对象_类
from poly_tally.lock import 运行锁_类
from poly_tally.export import 公开导出_类
from poly_tally.private_metrics import 私有规模导出_类
from poly_tally.gateway import gateway_config


def safe_environment():
    # A real PAT must stay in the external helper, never in this process.
    if any(k in os.environ for k in ('POLY_TALLY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN')):
        raise RuntimeError('Token environment is unsupported; use the external read-only helper')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_CONFIG_', 'GIT_TRACE', 'GIT_CURL_VERBOSE'))}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    return env


def run_git(args):
    result = subprocess.run(['git', '-c', 'credential.helper=', *args], env=safe_environment(), capture_output=True, timeout=300)
    if result.returncode:
        raise RuntimeError(f'Anonymous Git operation failed ({result.returncode})')
    return result.stdout.decode()


class NativeDiscovery:
    def __init__(self, manifest, wrapper=None, public_only=False):
        if manifest.get('schemaVersion') != 1 or manifest.get('complete') is not True:
            raise ValueError('Complete metadata inventory is required')
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(manifest['generatedAt'].replace('Z', '+00:00'))).total_seconds()
        if not 0 <= age <= 24 * 3600:
            raise ValueError('Inventory must be refreshed within 24 hours')
        self.owners = manifest['owners']
        self.rows = manifest['repositories']
        self.wrapper = wrapper
        self.public_only = public_only
        ids, names = set(), set()
        for row in self.rows:
            for key in ('id', 'full_name', 'clone_url', 'default_branch', 'private', 'archived', 'fork', 'size', 'owner'):
                if key not in row:
                    raise ValueError('Inventory is missing required repository metadata')
            name = row['full_name']
            if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', name):
                raise ValueError('Invalid repository name')
            if row['owner']['login'].casefold() not in {x.casefold() for x in self.owners}:
                raise ValueError('Repository owner outside inventory scope')
            if row['clone_url'] != f'https://github.com/{name}.git':
                raise ValueError('Only canonical GitHub HTTPS repositories are supported')
            if str(row['id']) in ids or name.casefold() in names:
                raise ValueError('Duplicate repository in inventory')
            ids.add(str(row['id'])); names.add(name.casefold())

    def api_发现(self, owners):
        if {x.casefold() for x in owners} != {x.casefold() for x in self.owners}:
            raise ValueError('Inventory owner scope does not match configuration')
        return [x.copy() for x in self.rows if not self.public_only or not x['private']]

    def api_读取仓库(self, name):
        for row in self.rows:
            if row['full_name'].casefold() == name.casefold():
                return row.copy()
        raise requests.RequestException('Repository not present in complete authorized inventory')

    def wrapper_call(self, action, row):
        if self.wrapper is None:
            raise RuntimeError('Private repository requires external read-only Git wrapper')
        result = subprocess.run([sys.executable, str(self.wrapper), action, row['full_name'].split('/')[1]], env=safe_environment(), capture_output=True, timeout=1800)
        if result.returncode:
            raise RuntimeError(f'Read-only Git wrapper failed ({result.returncode})')
        try:
            receipt = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise RuntimeError('Invalid read-only Git receipt') from None
        if receipt.get('repository') != row['full_name']:
            raise RuntimeError('Read-only Git receipt repository mismatch')
        head = receipt.get('head')
        if head is not None and not re.fullmatch('[0-9a-f]{40}', head):
            raise RuntimeError('Invalid native Git HEAD')
        return receipt

    def api_读取默认分支(self, row):
        if row['private']:
            receipt = self.wrapper_call('ls-remote', row)
            head, branch = receipt['head'], receipt['defaultBranch']
        else:
            output = run_git(['ls-remote', '--symref', row['clone_url']])
            if not output.strip():
                head, branch = None, None
            else:
                branch = head = None
                for line in output.splitlines():
                    if line.startswith('ref: refs/heads/') and line.endswith('\tHEAD'):
                        branch = line.split('\t')[0][len('ref: refs/heads/'):]
                    elif line.endswith('\tHEAD'):
                        head = line.split('\t')[0]
                if not head or not branch:
                    raise RuntimeError('Nonempty repository has unresolved default branch')
        if head is not None and branch != row['default_branch']:
            raise RuntimeError('Default branch changed; refresh metadata inventory before collection')
        row['default_branch'] = branch
        return head

    def object_factory(self, row, path):
        if not row['private']:
            obj = Git对象_类(path)
            obj.环境 = safe_environment()
            obj.环境['GIT_CONFIG_COUNT'] = '1'
            obj.环境['GIT_CONFIG_KEY_0'] = 'credential.helper'
            obj.环境['GIT_CONFIG_VALUE_0'] = ''
            return obj
        return WrappedObjects(self, row)


class WrappedObjects:
    def __init__(self, discovery, row):
        self.discovery, self.row, self.inner = discovery, row, None

    def api_更新(self, source, branch):
        receipt = self.discovery.wrapper_call('fetch', self.row)
        if receipt.get('defaultBranch') != branch or not receipt.get('head'):
            raise RuntimeError('Default branch changed during fetch')
        self.inner = 缓存对象_类(Path(receipt['path']), receipt['head'])
        self.inner.环境 = {**safe_environment(), 'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': ''}
        return self.inner.api_更新(source, branch)

    def __getattr__(self, name):
        if self.inner is None:
            raise RuntimeError('Git objects not fetched')
        return getattr(self.inner, name)

    def api_关闭(self):
        if self.inner is not None:
            self.inner.api_关闭()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('config.json'))
    parser.add_argument('--inventory', type=Path)
    parser.add_argument('--gateway', action='store_true', help='Require the token-free gateway; never fall back to a credential helper')
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--wrapper', type=Path)
    parser.add_argument('--public-only', action='store_true')
    parser.add_argument('--restore-public-checkpoint', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--export-dir', type=Path, help='Sanitized local outputs, only after a complete unified collection')
    args = parser.parse_args()
    safe_environment()
    if args.gateway:
        if gateway_config() is None:
            parser.error('--gateway requires URL and proxy password')
        if args.inventory or args.wrapper:
            parser.error('--gateway performs fresh gateway discovery; inventory/wrapper cannot be mixed')
    elif args.inventory is None:
        parser.error('--inventory is required without --gateway')
    if args.export_dir and args.public_only:
        parser.error('--export-dir requires unified public and private collection')
    if args.export_dir and args.export_dir.exists() and any(args.export_dir.iterdir()):
        parser.error('--export-dir must be a fresh empty batch directory; do not reuse old publication inputs')
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    discovery = None if args.gateway else NativeDiscovery(json.loads(args.inventory.read_text()), args.wrapper, args.public_only)
    with 运行锁_类(args.cache / '.native.lock'), 运行锁_类(args.state / '.native.lock'):
        collector = 采集器_类(config, args.state, None, args.public_only, arg_数据批次=config['datasetEpoch'], arg_缓存目录=args.cache)
        if discovery is not None:
            collector.发现器 = discovery
            collector.引擎.对象工厂 = discovery.object_factory
        try:
            if args.restore_public_checkpoint:
                collector.api_恢复检查点(args.restore_public_checkpoint)
            result = collector.api_采集()
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2))
            complete = result.get('failed') == 0 and result.get('completeness', {}).get('complete') is True
            if args.export_dir and complete:
                args.export_dir.mkdir(parents=True, exist_ok=True)
                collector.api_保存检查点(args.export_dir / 'checkpoint.json', arg_仅公开=True)
                公开导出_类.api_原子写入(args.export_dir / 'public-stats.json', 公开导出_类(collector.引擎.数据库, collector.规则).api_构建())
                公开导出_类.api_原子写入(args.export_dir / 'private-metrics.json', 私有规模导出_类(collector.引擎.数据库, collector.规则).api_构建())
            # Deliberately does not publish. The normal sanitized publication gate
            # must independently validate the full public AND private batch.
            return 0 if complete else 2
        finally:
            collector.引擎.api_关闭()

if __name__ == '__main__':
    raise SystemExit(main())
