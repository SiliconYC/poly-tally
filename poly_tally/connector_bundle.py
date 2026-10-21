"""Read-only Git object adapter for locally captured authorized connector data.

No network, credential lookup, fabricated commits, checkout, or Git refs are
involved. Blob bytes and reconstructed non-recursive tree bytes are SHA-1
verified. Commit identities, parents and dates are trusted GitHub API metadata:
API JSON cannot prove the SHA of an original signed/raw Git commit.

A bundle is a private directory containing manifest.json and global,
content-addressed objects/{commits,trees,blobs}/<40-lowercase-hex-sha>.json.
The manifest records the pinned default HEAD and an equal post-capture HEAD /
default-branch recheck. Object receipts/fetch-log.jsonl may be retained locally;
none of these raw inputs are copied into publication artifacts.
"""
import base64
import binascii
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time

from poly_tally.rules import 规则_类

SHA = re.compile(r'[0-9a-f]{40}\Z')
COMMIT_VERIFICATION = 'github-api-identity-and-first-parent-continuity; not raw-commit-sha-verification'


def _sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('bundle contains an invalid Git SHA-1 identity')
    return value


def _date(value):
    if not isinstance(value, str):
        raise ValueError('bundle timestamp must be an ISO-8601 string')
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError('bundle contains an invalid timestamp') from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('bundle timestamp requires an explicit timezone')
    return value


def _hash(kind, data):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key in connector bundle')
        result[key] = value
    return result


class ConnectorBundle:
    """Validate a frozen capture against the exact active collection rules."""

    def __init__(self, root: Path, rules: 规则_类):
        self.root = Path(root).resolve()
        self.rules = rules
        self._commits = {}
        self._trees = {}
        self._tree_indexes = {}
        self._validated_tree_contexts = set()
        self._flat = OrderedDict()
        self._sizes = {}
        self._verified_blobs = set()
        self._backends = {}
        self.manifest = self._read('manifest.json')
        manifest = self.manifest
        if manifest.get('schemaVersion') != 1 or manifest.get('source') != 'github-connector':
            raise ValueError('unsupported connector bundle schema/source')
        _date(manifest.get('capturedAt'))
        if type(manifest.get('discoveryComplete')) is not bool or not isinstance(manifest.get('repositories'), list):
            raise ValueError('bundle requires repository inventory and discovery completeness')
        self.capture_scope = manifest.get('captureScope', 'all')
        if self.capture_scope not in {'all', 'public-only', 'private-only'}:
            raise ValueError('invalid connector capture scope')
        self.repositories = {}
        names = set()
        for item in manifest['repositories']:
            if not isinstance(item, dict) or not isinstance(item.get('metadata'), dict):
                raise ValueError('invalid bundle repository metadata')
            meta = item['metadata']
            identity = meta.get('id')
            if type(identity) not in {int, str} or not re.fullmatch(r'[1-9][0-9]*', str(identity)):
                raise ValueError('repository identity must be a positive GitHub numeric ID')
            key = str(identity)
            name = meta.get('full_name')
            branch = meta.get('default_branch')
            if not key or key in self.repositories or not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9-]+/[A-Za-z0-9_.-]+', name) or name.casefold() in names or not isinstance(branch, str) or not branch:
                raise ValueError('invalid or duplicate bundle repository identity')
            if any(type(meta.get(field)) is not bool for field in ('private', 'archived', 'fork')):
                raise ValueError('bundle requires explicit repository visibility/archive/fork metadata')
            if 'head' not in item or 'verifiedHead' not in item:
                raise ValueError('bundle requires pinned and verified HEAD fields')
            if item['head'] is not None:
                _sha(item['head'])
            elif item.get('emptyRepository') is not True or any(
                    not isinstance(item.get(field), dict)
                    or item[field].get('status') != 409
                    or not isinstance(item[field].get('message'), str)
                    or 'git repository is empty' not in item[field]['message'].casefold()
                    for field in ('emptyEvidence', 'verifiedEmptyEvidence')):
                raise ValueError('null HEAD requires two explicit GitHub API empty-repository confirmations; 404/size=0 are not evidence')
            self.repositories[key] = item
            names.add(name.casefold())
        if any(item['metadata']['private'] for item in self.repositories.values()) and self.root.stat().st_mode & 0o077:
            raise ValueError('private connector bundle root permissions must be 0700')

    def _read(self, relative):
        path = self.root / relative
        # Object addresses come only from validated SHA values. Also reject
        # symlinked parents, so private capture files cannot escape the bundle.
        if path.is_symlink() or not path.resolve().is_relative_to(self.root) or any(parent.is_symlink() for parent in path.parents if parent != self.root and parent.is_relative_to(self.root)):
            raise ValueError('bundle object path must remain within the private bundle')
        try:
            with path.open(encoding='utf-8') as stream:
                value = json.load(stream, object_pairs_hook=_no_duplicate_keys)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('missing or malformed connector bundle object') from exc
        if not isinstance(value, dict):
            raise ValueError('bundle object must be a JSON object')
        return value

    def commit(self, sha):
        sha = _sha(sha)
        if sha not in self._commits:
            item = self._read(f'objects/commits/{sha}.json')
            if item.get('sha') != sha or not isinstance(item.get('parents'), list) or not isinstance(item.get('tree'), dict):
                raise ValueError('commit identity/tree/explicit parent list is missing')
            _sha(item['tree'].get('sha'))
            parents = []
            for parent in item['parents']:
                if not isinstance(parent, dict):
                    raise ValueError('invalid commit parent')
                parents.append(_sha(parent.get('sha')))
            if len(set(parents)) != len(parents):
                raise ValueError('duplicate commit parent')
            for who in ('author', 'committer'):
                if not isinstance(item.get(who), dict):
                    raise ValueError('commit author/committer metadata is missing')
                _date(item[who].get('date'))
            self._commits[sha] = item
        return self._commits[sha]

    def tree(self, sha):
        sha = _sha(sha)
        if sha not in self._trees:
            item = self._read(f'objects/trees/{sha}.json')
            if item.get('sha') != sha or item.get('truncated') is not False or not isinstance(item.get('tree'), list):
                raise ValueError('missing, truncated or mismatched non-recursive tree')
            names, encoded = set(), []
            for entry in item['tree']:
                if not isinstance(entry, dict):
                    raise ValueError('invalid Git tree entry')
                name, mode, kind = entry.get('path'), entry.get('mode'), entry.get('type')
                if not isinstance(name, str) or name in {'', '.', '..'} or '/' in name or '\0' in name or name in names:
                    raise ValueError('tree must contain unique immediate child names, not recursive paths')
                try:
                    raw_name = name.encode('utf-8')
                except UnicodeError as exc:
                    raise ValueError('GitHub tree path cannot losslessly encode Git bytes') from exc
                expected = {'040000': 'tree', '100644': 'blob', '100755': 'blob', '120000': 'blob', '160000': 'commit'}
                if mode not in expected or kind != expected[mode]:
                    raise ValueError('invalid Git tree mode/type combination')
                oid = _sha(entry.get('sha'))
                if 'size' in entry:
                    size = entry['size']
                    if type(size) is not int or size < 0:
                        raise ValueError('invalid GitHub tree object size')
                    if kind == 'blob':
                        if oid in self._sizes and self._sizes[oid] != size:
                            raise ValueError('inconsistent GitHub API blob size')
                        self._sizes[oid] = size
                names.add(name)
                encoded.append((raw_name + (b'/' if kind == 'tree' else b''), mode.lstrip('0').encode() + b' ' + raw_name + b'\0' + bytes.fromhex(oid)))
            raw = b''.join(value for _, value in sorted(encoded))
            if _hash('tree', raw) != sha:
                raise ValueError('Git tree SHA mismatch: incomplete or corrupted tree')
            self._trees[sha] = item['tree']
        return self._trees[sha]

    def flat_tree(self, sha):
        sha = _sha(sha)
        if sha in self._flat:
            self._flat.move_to_end(sha)
            return self._flat[sha]
        result = {}
        stack = [(sha, '', frozenset())]
        while stack:
            current, prefix, ancestors = stack.pop()
            if current in ancestors:
                raise ValueError('cyclic Git tree graph')
            for entry in self.tree(current):
                path = prefix + entry['path']
                if entry['type'] == 'tree':
                    stack.append((entry['sha'], path + '/', ancestors | {current}))
                else:
                    result[path] = (entry['mode'], entry['sha'])
        self._flat[sha] = result
        if len(self._flat) > 8:
            self._flat.popitem(last=False)
        return result

    def validate_tree_context(self, sha, prefix=''):
        """Verify every unique tree at every distinct full-path context once.

        A tree SHA alone is not a rules-cache key: the same tree can occur in
        both vendor/ and src/. Raw tree verification remains SHA-addressed in
        tree(), while eligibility is memoized by (tree SHA, path prefix).
        Mark contexts only after all descendants pass, so a failed validation
        cannot turn a later retry into a false success.
        """
        stack = [(sha, prefix, frozenset(), False)]
        while stack:
            current, current_prefix, ancestors, complete = stack.pop()
            key = (current, current_prefix)
            if key in self._validated_tree_contexts:
                continue
            if complete:
                self._validated_tree_contexts.add(key)
                continue
            if current in ancestors:
                raise ValueError('cyclic Git tree graph')
            stack.append((current, current_prefix, ancestors, True))
            for entry in self.tree(current):
                path = current_prefix + entry['path']
                if entry['type'] == 'tree':
                    stack.append((entry['sha'], path + '/', ancestors | {current}, False))
                elif entry['mode'] in {'100644', '100755'} and self.rules.api_语言(path) is not None:
                    oid = entry['sha']
                    if oid not in self._sizes:
                        raise ValueError('eligible blob is missing its API tree size')
                    if oid not in self._verified_blobs:
                        self.blob(oid, self.rules.配置['max_blob_bytes'])

    def tree_index(self, sha):
        if sha is None:
            return {}
        if sha not in self._tree_indexes:
            self._tree_indexes[sha] = {entry['path']: entry for entry in self.tree(sha)}
        return self._tree_indexes[sha]

    def diff_trees(self, before, after):
        """Merkle diff: equal subtree identities need no path expansion.

        Additions/deletions still enumerate the affected subtree. Directory ↔
        non-directory replacements emit both the old leaf removals and new
        leaf additions, including symlinks/gitlinks for the engine to discard.
        """
        result, stack = [], [(before, after, '')]
        while stack:
            left_sha, right_sha, prefix = stack.pop()
            if left_sha == right_sha:
                continue
            left, right = self.tree_index(left_sha), self.tree_index(right_sha)
            for name in left.keys() | right.keys():
                old, new = left.get(name), right.get(name)
                if old is not None and new is not None and (old['mode'], old['sha']) == (new['mode'], new['sha']):
                    continue
                path = prefix + name
                old_tree = old is not None and old['type'] == 'tree'
                new_tree = new is not None and new['type'] == 'tree'
                if old_tree or new_tree:
                    stack.append((old['sha'] if old_tree else None, new['sha'] if new_tree else None, path + '/'))
                if new is not None and not new_tree:
                    result.append((path, new['mode'], new['sha']))
                elif old is not None and not old_tree:
                    result.append((path, '000000', '0' * 40))
        return sorted(result)

    def blob(self, sha, limit):
        sha = _sha(sha)
        if sha not in self._sizes:
            raise ValueError('eligible blob has no trusted API tree size; cannot silently skip')
        size = self._sizes[sha]
        if size > limit:
            return None
        item = self._read(f'objects/blobs/{sha}.json')
        if item.get('sha') != sha or item.get('encoding') != 'base64' or not isinstance(item.get('content'), str):
            raise ValueError('eligible blob requires lossless base64 data and matching identity')
        if 'size' in item and (type(item['size']) is not int or item['size'] != size):
            raise ValueError('blob API/tree size disagreement')
        try:
            # GitHub adds ASCII line breaks. Do not accept arbitrary garbage
            # that permissive b64decode() would otherwise silently discard.
            content = base64.b64decode(re.sub(r'[ \t\r\n]', '', item['content']), validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError('invalid lossless blob base64 content') from exc
        if len(content) != size or _hash('blob', content) != sha:
            raise ValueError('Git blob size/SHA mismatch or truncated content')
        self._verified_blobs.add(sha)
        return content

    def backend(self, repository_id):
        key = str(repository_id)
        if key not in self.repositories:
            raise ValueError('repository is not in connector capture inventory')
        if key not in self._backends:
            self._backends[key] = ConnectorGitObjects(self, self.repositories[key])
        return self._backends[key]

    def validate(self, repository_ids=None):
        for key in self.repositories if repository_ids is None else repository_ids:
            self.backend(key).validate()
        return self.audit()

    def audit(self):
        return dict(source='github-connector', captureScope=self.capture_scope, capturedAt=self.manifest['capturedAt'], rulesVersion=self.rules.版本,
                    manifestSha256=hashlib.sha256(json.dumps(self.manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                    commitVerification=COMMIT_VERIFICATION, treeVerification='raw-git-tree-sha1', blobVerification='raw-git-blob-sha1',
                    verifiedTrees=len(self._trees), verifiedBlobs=len(self._verified_blobs), apiCommits=len(self._commits))


class ConnectorGitObjects:
    """The engine's existing Git object contract, with strictly offline reads."""

    def __init__(self, bundle, item):
        self.bundle = bundle
        self.metadata = item['metadata'].copy()
        self.head = item['head']
        # Partial capture inspection may select one completed repository while
        # other inventory entries still await their final reference recheck.
        if self.head != item['verifiedHead'] or self.metadata['default_branch'] != item.get('verifiedDefaultBranch'):
            raise ValueError('default branch/HEAD changed during capture or was not rechecked')
        if 'verifiedAt' in item:
            _date(item['verifiedAt'])
        self._history = None
        self._validated = False

    def validate(self):
        if self._validated:
            return
        for entry in self.api_历史(self.head):
            self.bundle.validate_tree_context(self.bundle.commit(entry['sha'])['tree']['sha'])
        self._validated = True

    def api_更新(self, arg_源, arg_分支):
        if arg_分支 != self.metadata['default_branch']:
            raise ValueError('requested default branch does not match frozen connector capture')
        self.validate()
        return self.head

    def api_历史(self, arg_HEAD):
        if arg_HEAD != self.head:
            raise ValueError('requested HEAD does not match frozen connector capture')
        if self._history is None:
            chain, seen, current = [], set(), self.head
            while current is not None:
                if current in seen:
                    raise ValueError('cyclic first-parent commit chain')
                seen.add(current)
                item = self.bundle.commit(current)
                chain.append(dict(sha=current, committedAt=item['committer']['date'], authoredAt=item['author']['date']))
                current = item['parents'][0]['sha'] if item['parents'] else None
            self._history = list(reversed(chain))
        return [entry.copy() for entry in self._history]

    def api_文件树(self, arg_SHA):
        return self.bundle.flat_tree(self.bundle.commit(arg_SHA)['tree']['sha']).copy()

    def api_变动(self, arg_前提交, arg_提交):
        return self.bundle.diff_trees(self.bundle.commit(arg_前提交)['tree']['sha'], self.bundle.commit(arg_提交)['tree']['sha'])

    def api_读取blob(self, arg_OID, arg_上限):
        return self.bundle.blob(arg_OID, arg_上限)

    def api_关闭(self):
        pass


def import_bundle(bundle_root, config, state, epoch, *, expected_inventory=None,
                  public_only=False, private_only=False, include_private_metrics=False):
    """Atomically rebuild an EMPTY state from captured objects; never fetch.

    ``state`` is the exact epoch directory (the CLI appends epochs/<epoch>).
    Returns sanitized publication data plus a local audit, not raw facts.
    ``expected_inventory`` is fresh connector discovery metadata, never stats.
    """
    from poly_tally.collector import 采集器_类
    from poly_tally.export import 公开导出_类
    from poly_tally.lineage import collapse_repositories, member_names, validate_groups
    from poly_tally.lock import 运行锁_类
    from poly_tally.private_metrics import 私有规模导出_类

    if not isinstance(epoch, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', epoch):
        raise ValueError('connector import requires a fresh explicit dataset epoch')
    if public_only and private_only:
        raise ValueError('public-only and private-only are mutually exclusive')
    rules = 规则_类(config['rules'])
    bundle = ConnectorBundle(bundle_root, rules)
    requested_scope = 'public-only' if public_only else 'private-only' if private_only else 'all'
    if bundle.capture_scope != requested_scope:
        raise ValueError('connector capture scope differs from requested collection scope')
    if bundle.manifest['discoveryComplete'] is not True:
        raise ValueError('incomplete connector discovery cannot publish a full rebuild')
    groups = validate_groups(config.get('lineageGroups', []))
    members = member_names(groups)
    all_names = {item['metadata']['full_name'].casefold() for item in bundle.repositories.values()}
    if not public_only and members - all_names:
        raise ValueError('connector bundle is missing an explicit lineage member')

    state = Path(state)
    if state.is_symlink() or (state.exists() and (not state.is_dir() or any(state.iterdir()))):
        raise ValueError('connector rebuild requires an empty/fresh state; old statistics cannot be imported')
    state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with 运行锁_类(state.parent / ('.' + state.name + '.connector-import.lock')):
        if state.exists() and any(state.iterdir()):
            raise ValueError('connector rebuild requires an empty/fresh state')
        stage = Path(tempfile.mkdtemp(prefix='.connector-rebuild-', dir=state.parent))
        os.chmod(stage, 0o700)
        collector = None
        try:
            # Construction only binds the exact existing rules/lineage/epoch
            # contract. No discovery or network method is ever invoked.
            collector = 采集器_类(config, stage, None, public_only, private_only, epoch, expected_inventory)
            engine, database = collector.引擎, collector.引擎.数据库
            selected, archived = [], []
            for key, item in bundle.repositories.items():
                meta = item['metadata']
                is_member = meta['full_name'].casefold() in members
                # Match the normal collector: archival removal evidence is
                # required even after a private repository becomes public.
                if meta['archived'] and not is_member:
                    archived.append(meta)
                    continue
                if public_only and meta['private']:
                    continue
                if private_only and not meta['private'] and not is_member:
                    continue
                if collector._纳入(meta):
                    selected.append(key)
            if expected_inventory is not None:
                expected = {item['id']: item for item in collector.预期清单 if
                    (not item['archived'] or item['name'].casefold() in members)
                    and (collector._名称在范围(item['name']) or item['name'].casefold() in members)
                    and (not public_only or item['visibility'] == 'public')
                    and (not private_only or item['visibility'] == 'private' or item['name'].casefold() in members)}
                if set(expected) != set(selected):
                    raise ValueError('fresh expected repository inventory does not match complete capture scope')
                for key, expected_meta in expected.items():
                    meta = bundle.repositories[key]['metadata']
                    if expected_meta['name'].casefold() != meta['full_name'].casefold() or (expected_meta['visibility'] == 'private') != meta['private'] or expected_meta['archived'] != meta['archived']:
                        raise ValueError('expected repository metadata changed during connector capture')
            if any(bundle.repositories[key].get('captureStatus', 'complete') != 'complete' for key in selected):
                raise ValueError('selected repository capture is not complete')
            started = time.monotonic()
            bundle.validate(selected)  # All required objects before ANY metric parsing.
            public_counts = {key: 0 for key in engine.计数}
            for key in selected:
                backend = bundle.backend(key)
                meta = backend.metadata
                baseline = engine.计数.copy()
                if backend.head is None:
                    repository_state = collector._空状态(meta)
                else:
                    repository_state = engine.api_同步({**meta, 'archived': False} if meta['full_name'].casefold() in members else meta,
                                                      '', backend.head, arg_对象=backend)
                # Re-parsing an older offline capture is not a new observation
                # of the remote HEAD. Keep capture freshness separate from run.
                repository_state['lastSuccessAt'] = bundle.repositories[key].get('verifiedAt', bundle.manifest['capturedAt'])
                database.api_保存仓库(repository_state)
                if not meta['private']:
                    for count in public_counts:
                        public_counts[count] += engine.计数[count] - baseline[count]
            for meta in archived:
                collector._排除归档(meta)
            if not public_only:
                collapse_repositories(engine.api_仓库列表(), groups, rules.版本)
            finished = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            completeness = dict(complete=True, discoveryComplete=True, expectedRepositories=len(selected), scannedRepositories=len(selected), missingMembers=0, failed=0)
            public_number = sum(not bundle.repositories[key]['metadata']['private'] for key in selected)
            public_run = dict(finishedAt=finished, durationSeconds=round(time.monotonic() - started, 3), repositories=public_number,
                              failed=0, **public_counts, completeness={**completeness, 'expectedRepositories': public_number, 'scannedRepositories': public_number})
            run = dict(public_run, repositories=len(selected), **{key: value for key, value in engine.计数.items()})
            run.update(completeness=completeness, publicRun=public_run, captureScope=bundle.capture_scope)
            database.api_记录运行(run)
            audit = bundle.audit()
            with database.连接:
                database.连接.execute("INSERT OR REPLACE INTO metadata VALUES('connectorBundleAudit', ?)", (json.dumps(audit, sort_keys=True),))
            result = dict(run=run, audit=audit, public=公开导出_类(database, rules, include_private_metrics).api_构建(),
                          private=私有规模导出_类(database, rules).api_构建() if include_private_metrics else None)
            collector.api_关闭()
            collector = None
            os.replace(stage, state)
            return result
        finally:
            if collector is not None:
                collector.api_关闭()
            if stage.exists():
                shutil.rmtree(stage)
