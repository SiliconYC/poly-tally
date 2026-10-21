"""Deterministic lineage replay, before any privacy/day downsampling.

Configuration is explicit; names never imply a relationship. Replay uses the
current default first-parent histories only, and never persists winner state.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import re
from itertools import groupby

from poly_tally.metrics import 行统计_类

ALGORITHM = 'strict-code-high-watermark-v1'
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}\Z')


def validate_groups(groups):
    if not isinstance(groups, list):
        raise ValueError('lineageGroups must be a list')
    ids, names, result = set(), set(), []
    for group in groups:
        if not isinstance(group, dict) or set(group) != {'id', 'members'}:
            raise ValueError('lineage group requires only id and members')
        key, members = group['id'], group['members']
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', key) or key in ids:
            raise ValueError('invalid or duplicate lineage id')
        if not isinstance(members, list) or not members:
            raise ValueError('lineage group requires members')
        ids.add(key)
        for name in members:
            if not isinstance(name, str) or not NAME.fullmatch(name) or name.split('/')[1] in {'.', '..'} or name.casefold() in names:
                raise ValueError('invalid or repeated lineage member')
            names.add(name.casefold())
        result.append({'id': key, 'members': sorted(members, key=str.casefold)})
    return sorted(result, key=lambda group: group['id'])


def lineage_version(groups):
    return hashlib.sha256(json.dumps({'algorithm': ALGORITHM, 'groups': validate_groups(groups)}, sort_keys=True).encode()).hexdigest()[:16]


def member_names(groups):
    return {name.casefold() for group in validate_groups(groups) for name in group['members']}


def _time(value):
    date = datetime.fromisoformat(value)
    if date.tzinfo is None:
        raise ValueError('lineage timestamp requires timezone')
    return date.astimezone(timezone.utc)


def last_commit_date(repository):
    # Real commit dates only. Invalid legacy fixtures cannot invent dates from scans.
    dates = []
    for point in repository['history']:
        try:
            dates.append(_time(point.get('committedAt', point['timestamp'])))
        except (ValueError, TypeError):
            continue
    return max(dates).date().isoformat() if dates else None


def _metrics(snapshot):
    keys = 行统计_类.api_空指标()
    for metrics in [snapshot.get('metrics'), *snapshot.get('languages', {}).values()]:
        if not isinstance(metrics, dict) or any(type(metrics.get(key)) is not int or metrics[key] < 0 for key in keys):
            raise ValueError('invalid lineage metrics; missing is not zero')
    if not isinstance(snapshot.get('languages'), dict):
        raise ValueError('invalid lineage languages')


def collapse_repositories(repositories, groups, rules_version):
    groups = validate_groups(groups)
    configured = member_names(groups)
    result = [deepcopy(repo) for repo in repositories if repo['name'].casefold() not in configured]
    by_name = {repo['name'].casefold(): repo for repo in repositories}
    for group in groups:
        missing = [name for name in group['members'] if name.casefold() not in by_name]
        if missing:
            raise ValueError('lineage members missing; complete collection required')
        members = sorted((by_name[name.casefold()] for name in group['members']), key=lambda repo: (str(repo['id']), repo['name'].casefold()))
        if any(repo['rulesVersion'] != rules_version or repo['historyComplete'] is not True or repo['status'] not in {'active', 'empty', 'archived', 'cold'} or (repo['status'] != 'empty' and not repo['history']) for repo in members):
            raise ValueError('lineage histories incomplete or stale')
        events, real_commits = [], []
        for rank, repo in enumerate(members):
            for index, point in enumerate(repo['history']):
                _metrics(point)
                events.append((_time(point['timestamp']), rank, index, point))
                real_commits.append((_time(point['committedAt']), rank))
        events.sort(key=lambda event: event[:3])
        # Same instant is atomic across repositories. First-parent order chooses
        # each final stock, while all intermediate peaks remain in the threshold.
        peaks, current, winner, history = {}, {}, None, []
        for time, batch in groupby(events, key=lambda event: event[0]):
            batch_peaks = {}
            for _, rank, index, point in batch:
                current[rank] = point
                batch_peaks[rank] = max(batch_peaks.get(rank, 0), point['metrics']['code'])
                peaks[rank] = max(peaks.get(rank, 0), point['metrics']['code'])
            if winner is None:
                winner = min(batch_peaks)
            candidates = [rank for rank in batch_peaks if rank != winner and batch_peaks[rank] > peaks[winner]]
            if candidates:
                winner = min(candidates, key=lambda rank: (-batch_peaks[rank], rank))
            chosen = current[winner]
            history.append({'timestamp': time.isoformat().replace('+00:00', 'Z'), 'metrics': deepcopy(chosen['metrics']), 'languages': deepcopy(chosen['languages'])})
        # Latest actual commit; canonical member order breaks ties. Never scans.
        representative = min(real_commits, key=lambda event: (-event[0].timestamp(), event[1]))[1] if real_commits else 0
        base = deepcopy(members[representative])
        source_key = lambda id: hashlib.sha256(f'poly-tally/repository/{id}'.encode()).hexdigest()[:16]
        base.update({'id': 'lineage:' + group['id'], 'name': members[representative]['name'], 'private': any(repo['private'] for repo in members), 'status': 'active' if history else 'empty', 'history': history, 'head': None, 'branch': None, 'inventory': {}, 'url': None, 'lastSuccessAt': min((repo['lastSuccessAt'] for repo in members if repo['lastSuccessAt']), default=None), 'lastCommitDate': max((item[0] for item in real_commits), default=None).date().isoformat() if real_commits else None, 'skippedFiles': members[winner]['skippedFiles'] if winner is not None else 0, 'lineage': {'id': group['id'], 'version': lineage_version(groups), 'members': [{'name': repo['name'], 'sourceKey': source_key(repo['id'])} for repo in members], 'dominantMember': members[winner]['name'] if winner is not None else None, 'representativeMember': members[representative]['name']}})
        result.append(base)
    return result


def export_repositories(database, rules_version):
    """Never export an incomplete group or leak its raw public subset."""
    repositories = database.api_仓库列表()
    groups = getattr(database, 'lineage_groups', [])
    if not groups:
        return repositories
    configured = member_names(groups)
    standalone = [repo for repo in repositories if repo['name'].casefold() not in configured]
    for group in groups:
        try:
            collapsed = collapse_repositories([repo for repo in repositories if repo['name'].casefold() in {name.casefold() for name in group['members']}], [group], rules_version)
            # Version is global so a membership change invalidates the whole epoch.
            for repo in collapsed:
                repo['lineage']['version'] = lineage_version(groups)
            standalone.extend(collapsed)
        except ValueError:
            # Collection carries explicit missing/incomplete evidence. No partial
            # group is published while waiting for permissions or a full replay.
            continue
    return standalone
