import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const metricKeys = ['code', 'comment', 'blank', 'documentation', 'files'];
const statuses = new Set(['active', 'archived', 'empty', 'cold', 'excluded', 'inaccessible', 'stale']);
const languages = new Set(['Python', 'Cython', 'JavaScript', 'TypeScript', 'TSX', 'C', 'C++', 'CUDA', 'C#', 'Java', 'Kotlin', 'Swift', 'Go', 'Rust', 'Ruby', 'PHP', 'Vue', 'Svelte', 'HTML', 'CSS', 'SCSS', 'Less', 'Bash', 'PowerShell', 'Batchfile', 'SQL', 'R', 'Lua', 'Dart', 'JSON', 'YAML', 'TOML', 'INI', 'XML', 'Protocol Buffer', 'QML', 'CMake', 'Makefile', 'Dockerfile', 'Markdown', 'reStructuredText', 'Text', 'TeX']);
const notice = '私有仓库：仅公开按日规模，不公开源码与提交详情。';
const anonymousKey = id => createHash('sha256').update(`poly-tally/repository/${id}`).digest('hex').slice(0, 16);
const repositoryKeys = ['id', 'name', 'sourceKey', 'visibility', 'snapshotKind', 'url', 'branch', 'head', 'status', 'lastSuccessAt', 'rulesVersion', 'historyComplete', 'notice', 'skippedFiles', 'history'];
const hexKey = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const fullName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) && !['.', '..'].includes(name.split('/')[1]);
const repositoryName = repository => repository.name === `私有仓库 · ${repository.sourceKey.slice(0, 6)}` || fullName(repository.name);
const timeKey = value => value.replace(/(?:\.(\d+))?Z$/, (_match, fraction = '') => `.${fraction.padEnd(6, '0')}Z`);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = () => { throw new Error('Invalid sanitized private metrics; refusing publication.'); };
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) reject();
}
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
}
function validateMetrics(value) {
  exactKeys(value, metricKeys);
  if (!metricKeys.every(key => integer(value[key]))) reject();
}

function calendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateLineage(repository, version) {
  const lineage = repository.lineage;
  exactKeys(lineage, ['id', 'version', 'members', 'dominantMember', 'representativeMember']);
  if (typeof lineage.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(lineage.id) || !hexKey(lineage.version) || lineage.version !== version || repository.sourceKey !== anonymousKey(`lineage:${lineage.id}`) || !Array.isArray(lineage.members) || lineage.members.length < 1) reject();
  const names = new Set(), keys = new Set();
  for (const member of lineage.members) {
    exactKeys(member, ['name', 'sourceKey']);
    if (!fullName(member.name) || !hexKey(member.sourceKey) || names.has(member.name.toLowerCase()) || keys.has(member.sourceKey)) reject();
    names.add(member.name.toLowerCase()); keys.add(member.sourceKey);
  }
  if (!lineage.members.some(member => member.name === lineage.representativeMember) || repository.name !== lineage.representativeMember || (lineage.dominantMember !== null && !lineage.members.some(member => member.name === lineage.dominantMember))) reject();
}
const representedKeys = repository => repository.lineage?.members?.map(member => member.sourceKey) ?? [repository.sourceKey ?? anonymousKey(repository.id)];
function completeCollection(envelope) {
  if (envelope.collection.failed > 0) return false;
  if ('lineageVersion' in envelope || 'completeness' in envelope) return envelope.completeness?.complete === true;
  return true; // Legacy snapshots keep their existing validation contract.
}
function requireComplete(envelope) {
  if (!completeCollection(envelope)) throw new Error('Private collection incomplete; retaining durable sanitized metrics');
}
function validateCompletenessProof(proof) {
  exactKeys(proof, ['complete', 'discoveryComplete', 'expectedRepositories', 'scannedRepositories', 'missingMembers', 'failed']);
  if (typeof proof.complete !== 'boolean' || typeof proof.discoveryComplete !== 'boolean' || !['expectedRepositories', 'scannedRepositories', 'missingMembers', 'failed'].every(key => integer(proof[key])) || proof.scannedRepositories > proof.expectedRepositories) reject();
  if (proof.complete && (!proof.discoveryComplete || proof.expectedRepositories !== proof.scannedRepositories || proof.missingMembers !== 0 || proof.failed !== 0)) reject();
}
function matchingLineage(publicStats, envelope) {
  if (publicStats.lineageVersion !== undefined || envelope.lineageVersion !== undefined) {
    if (!hexKey(publicStats.lineageVersion) || publicStats.lineageVersion !== envelope.lineageVersion) throw new Error('Lineage version mismatch; fresh sources must use the same configuration.');
  }
}

export function validatePrivateMetrics(envelope) {
  exactKeys(envelope, ['schemaVersion', 'generatedAt', 'rulesVersion', 'source', 'collection', 'repositories', ...('datasetEpoch' in envelope ? ['datasetEpoch'] : []), ...('archivedRepositoryKeys' in envelope ? ['archivedRepositoryKeys'] : []), ...('lineageVersion' in envelope ? ['lineageVersion'] : []), ...('completeness' in envelope ? ['completeness'] : [])]);
  if ('lineageVersion' in envelope && !hexKey(envelope.lineageVersion)) reject();
  if ('datasetEpoch' in envelope && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(envelope.datasetEpoch)) reject();
  if ('archivedRepositoryKeys' in envelope && (!Array.isArray(envelope.archivedRepositoryKeys) || !envelope.archivedRepositoryKeys.every(hexKey) || new Set(envelope.archivedRepositoryKeys).size !== envelope.archivedRepositoryKeys.length)) reject();
  exactKeys(envelope.collection, ['repositories', 'failed']);
  if (envelope.schemaVersion !== 1 || !iso(envelope.generatedAt) || !hexKey(envelope.rulesVersion) || !['local', 'github-actions'].includes(envelope.source) || !Array.isArray(envelope.repositories) || !integer(envelope.collection.repositories) || envelope.collection.repositories !== envelope.repositories.length || !integer(envelope.collection.failed) || envelope.collection.failed > envelope.collection.repositories) reject();
  const seen = new Set(), represented = new Set();
  for (const repository of envelope.repositories) {
    exactKeys(repository, [...repositoryKeys, ...('lastCommitDate' in repository ? ['lastCommitDate'] : []), ...('lineage' in repository ? ['lineage'] : [])]);
    if ('lastCommitDate' in repository && repository.lastCommitDate !== null && !calendarDate(repository.lastCommitDate)) reject();
    if ('lineage' in repository) validateLineage(repository, envelope.lineageVersion);
    if (!hexKey(repository.sourceKey) || repository.id !== `private-${repository.sourceKey}` || !repositoryName(repository) || seen.has(repository.sourceKey) || repository.visibility !== 'private' || repository.snapshotKind !== 'daily' || repository.url !== null || repository.branch !== null || repository.head !== null || !statuses.has(repository.status) || (repository.lastSuccessAt !== null && !iso(repository.lastSuccessAt)) || !hexKey(repository.rulesVersion) || typeof repository.historyComplete !== 'boolean' || repository.notice !== notice || !integer(repository.skippedFiles) || !Array.isArray(repository.history)) reject();
    if (envelope.archivedRepositoryKeys?.includes(repository.sourceKey)) reject();
    seen.add(repository.sourceKey);
    for (const key of representedKeys(repository)) {
      if (represented.has(key) || envelope.archivedRepositoryKeys?.includes(key)) reject();
      represented.add(key);
    }
    let previousDay = '';
    for (const snapshot of repository.history) {
      exactKeys(snapshot, ['timestamp', 'metrics', 'languages']);
      if (!iso(snapshot.timestamp)) reject();
      const day = snapshot.timestamp.slice(0, 10);
      // 日末或本次扫描时刻是唯一允许的精度，防止真实提交时间穿过字段白名单。
      if (day <= previousDay || day > envelope.generatedAt.slice(0, 10) || (day === envelope.generatedAt.slice(0, 10) ? snapshot.timestamp !== envelope.generatedAt : snapshot.timestamp !== `${day}T23:59:59.999999Z`)) reject();
      previousDay = day;
      validateMetrics(snapshot.metrics);
      if (!object(snapshot.languages)) reject();
      for (const [name, metrics] of Object.entries(snapshot.languages)) {
        if (!languages.has(name)) reject();
        validateMetrics(metrics);
      }
    }
  }
  if (envelope.collection.failed !== envelope.repositories.filter(repository => ['stale', 'inaccessible'].includes(repository.status)).length) reject();
  if ('completeness' in envelope) {
    const proof = envelope.completeness;
    validateCompletenessProof(proof);
    if (proof.complete && (envelope.collection.failed !== 0 || envelope.repositories.some(repository => !repository.historyComplete || repository.rulesVersion !== envelope.rulesVersion || !['active', 'empty'].includes(repository.status)))) reject();
  }
  return true;
}

export function validateCompletePrivateMetrics(envelope) {
  validatePrivateMetrics(envelope);
  requireComplete(envelope);
  return true;
}

export function validateRebuiltPrivateMetrics(envelope) {
  validatePrivateMetrics(envelope);
  const proof = envelope.completeness;
  if (!envelope.datasetEpoch || !hexKey(envelope.lineageVersion) || !proof || proof.complete !== false || proof.discoveryComplete !== false || proof.expectedRepositories < 1 || proof.expectedRepositories !== proof.scannedRepositories || proof.missingMembers !== 0 || proof.failed !== 0 || envelope.collection.failed !== 0 || envelope.repositories.length === 0 || envelope.repositories.some(repository => !repository.historyComplete || repository.rulesVersion !== envelope.rulesVersion || !['active', 'empty'].includes(repository.status) || (repository.status === 'active' && repository.history.length === 0))) throw new Error('Invalid offline rebuilt private snapshot; preserve the existing display.');
  return true;
}

// An external collection is selected explicitly by its sanitized Git blob, not
// by scan time or by the presence of a previously successful durable snapshot.
export function validatePrivateSnapshotBlob(bytes, expectedBlobSha) {
  if (typeof expectedBlobSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedBlobSha) || !(Buffer.isBuffer(bytes) || typeof bytes === 'string')) throw new Error('Invalid external private snapshot blob selection.');
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const actual = createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
  if (actual !== expectedBlobSha) throw new Error('External private snapshot blob SHA mismatch.');
  let data;
  try { data = JSON.parse(value.toString('utf8')); } catch { throw new Error('Invalid external private snapshot.'); }
  validateCompletePrivateMetrics(data);
  if (!data.datasetEpoch || !hexKey(data.lineageVersion) || data.completeness?.complete !== true) throw new Error('External private snapshot requires a complete lineage epoch.');
  return data;
}

export function validateExternalPrivateMetrics(bytes, publicStats, expectedBlobSha) {
  const data = validatePrivateSnapshotBlob(bytes, expectedBlobSha);
  if (!publicStats.datasetEpoch || data.datasetEpoch !== publicStats.datasetEpoch) throw new Error('External private snapshot dataset epoch mismatch.');
  matchingLineage(publicStats, data);
  if (data.rulesVersion !== publicStats.rules?.version) throw new Error('External private snapshot rules version mismatch.');
  return data;
}

// This is an explicit transition, never an epoch relabel or a fresh collection.
// The checked-in scope contains only hashed identities verified via GitHub metadata.
export function validateRetainedPrivateBaseline(baseline, targetEpoch) {
  exactKeys(baseline, ['mode', 'targetEpoch', 'sourceEpoch', 'sourceSnapshotSha256', 'sourceStateCommit', 'retainedSnapshotSha256', 'scope', 'metrics']);
  validatePrivateMetrics(baseline.metrics);
  exactKeys(baseline.scope, ['source', 'verifiedAt', 'activeRepositoryKeys', 'archivedRepositoryKeys']);
  const {metrics, scope} = baseline;
  const keys = values => Array.isArray(values) && values.every(hexKey) && new Set(values).size === values.length;
  if (baseline.mode !== 'retained-private-baseline' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(baseline.targetEpoch)
    || (targetEpoch !== undefined && targetEpoch !== baseline.targetEpoch)
    || baseline.sourceEpoch !== (metrics.datasetEpoch ?? null) || baseline.sourceEpoch === baseline.targetEpoch
    || !/^[a-f0-9]{64}$/.test(baseline.sourceSnapshotSha256) || !/^[a-f0-9]{40}$/.test(baseline.sourceStateCommit)
    || baseline.retainedSnapshotSha256 !== createHash('sha256').update(JSON.stringify(metrics)).digest('hex')
    || scope.source !== 'github-connector/list_repositories' || !iso(scope.verifiedAt) || timeKey(scope.verifiedAt) < timeKey(metrics.generatedAt)
    || !keys(scope.activeRepositoryKeys) || !keys(scope.archivedRepositoryKeys)
    || scope.activeRepositoryKeys.some(key => scope.archivedRepositoryKeys.includes(key))
    || metrics.collection.failed !== 0 || metrics.repositories.length !== scope.activeRepositoryKeys.length
    || metrics.repositories.some(repository => !scope.activeRepositoryKeys.includes(repository.sourceKey) || !['active', 'empty'].includes(repository.status))) reject();
  return true;
}

export function mergePrivateMetrics(publicStats, envelope, {retainedBaseline, privateStatus, externalPrivateBlobSha, privateBytes} = {}) {
  if (privateStatus !== undefined && !['available', 'stale', 'not-configured'].includes(privateStatus)) throw new Error('Invalid current private attempt status');
  // A newly scoped lineage snapshot is not evidence of a current attempt just
  // because a caller found it on disk. Legacy pre-lineage reads remain compatible.
  if (privateStatus === undefined && (publicStats?.lineageVersion !== undefined || envelope?.lineageVersion !== undefined)) privateStatus = 'not-configured';
  if (externalPrivateBlobSha) {
    const verified = validateExternalPrivateMetrics(privateBytes, publicStats, externalPrivateBlobSha);
    if (JSON.stringify(verified) !== JSON.stringify(envelope) || retainedBaseline) throw new Error('External private snapshot does not match merge input.');
    privateStatus = 'external-verified';
  }
  const currentAttemptUnproven = privateStatus !== undefined && !['available', 'external-verified'].includes(privateStatus);
  validatePrivateMetrics(envelope);
  if (publicStats?.schemaVersion !== 1 || !Array.isArray(publicStats.repositories) || typeof publicStats.rules?.version !== 'string') throw new Error('Invalid public dataset');
  matchingLineage(publicStats, envelope);
  if (retainedBaseline && (publicStats.lineageVersion !== undefined || envelope.lineageVersion !== undefined)) throw new Error('Lineage rebuild cannot adopt retained legacy metrics.');
  if (retainedBaseline) {
    validateRetainedPrivateBaseline(retainedBaseline, publicStats.datasetEpoch);
    if (!publicStats.datasetEpoch || JSON.stringify(envelope) !== JSON.stringify(retainedBaseline.metrics)) reject();
  } else if (publicStats.datasetEpoch !== envelope.datasetEpoch) throw new Error('Dataset epoch mismatch; old private metrics cannot enter the rebuilt dataset.');
  const data = structuredClone(publicStats);
  const privateData = structuredClone(envelope);
  if (!Number.isFinite(Date.parse(data.generatedAt)) || Date.parse(envelope.generatedAt) > Date.parse(data.generatedAt)) data.generatedAt = envelope.generatedAt;
  if (retainedBaseline) for (const repository of privateData.repositories) repository.dataFreshness = 'retained-private';
  const current = repository => repository.status === 'active' && (repository.rulesVersion === data.rules.version || (repository.visibility === 'private' && repository.dataFreshness === 'retained-private'));
  const archivedKeys = new Set([...(envelope.archivedRepositoryKeys ?? []), ...(retainedBaseline?.scope.archivedRepositoryKeys ?? [])]);
  const groupKeys = new Set(privateData.repositories.filter(repository => repository.lineage && repository.status !== 'archived').flatMap(repository => [repository.sourceKey, ...representedKeys(repository)]));
  const publicRepositories = data.repositories.filter(repository => repository.status !== 'archived' && !groupKeys.has(anonymousKey(repository.id)) && !representedKeys(repository).some(key => groupKeys.has(key)) && !archivedKeys.has(anonymousKey(repository.id)) && repository.visibility !== 'private' && !repository.id.startsWith('private-'));
  const publicKeys = new Set(publicRepositories.filter(current).flatMap(repository => [anonymousKey(repository.id), ...representedKeys(repository)]));
  const privateRepositories = privateData.repositories.filter(repository => repository.status !== 'archived' && !publicKeys.has(repository.sourceKey));
  const privateKeys = new Set(privateRepositories.map(repository => repository.sourceKey));
  data.repositories = [...publicRepositories.filter(repository => !privateKeys.has(anonymousKey(repository.id))), ...privateRepositories];
  const counted = data.repositories.filter(repository => current(repository) && repository.history.length > 0);
  const total = Object.fromEntries(metricKeys.map(metric => [metric, 0]));
  for (const repository of counted) {
    const latest = repository.history.reduce((last, item) => Date.parse(item.timestamp) >= Date.parse(last.timestamp) ? item : last);
    for (const metric of metricKeys) total[metric] += latest.metrics[metric];
  }
  const privateCount = counted.filter(repository => repository.visibility === 'private').length;
  const snapshots = counted.reduce((sum, repository) => sum + repository.history.length, 0);
  data.summary = {...total, repositories: counted.length, publicRepositories: counted.length - privateCount, privateRepositories: privateCount, commits: snapshots, snapshots};
  data.publication = {privateRepositories: privateRepositories.length, privateUpdatedAt: envelope.generatedAt, privateSource: envelope.source, privateStatus: currentAttemptUnproven || !completeCollection(envelope) || privateRepositories.some(repository => repository.rulesVersion !== data.rules.version || ['stale', 'inaccessible'].includes(repository.status)) ? 'stale' : 'available'};
  if (data.lineageVersion !== undefined || data.completeness !== undefined || envelope.completeness !== undefined) {
    const publicProof = data.completeness ?? null;
    const snapshotProof = privateData.completeness ?? null;
    // A durable snapshot proves its own successful run, never a later failed,
    // canceled, unavailable or rejected attempt. Keep its proof as provenance;
    // unknown current scans are null rather than invented zero-error counts.
    const privateProof = currentAttemptUnproven ? null : snapshotProof;
    data.publication.privateSnapshotCompleteness = snapshotProof;
    if (publicProof !== null) validateCompletenessProof(publicProof);
    data.publication.publicCompleteness = publicProof;
    data.publication.privateCompleteness = privateProof;
    // These are source-scan tasks, not unique repository or folded-group counts:
    // public members scanned by both jobs intentionally contribute twice.
    data.completeness = {
      complete: publicProof?.complete === true && privateProof?.complete === true,
      discoveryComplete: publicProof?.discoveryComplete === true && privateProof?.discoveryComplete === true,
      ...Object.fromEntries(['expectedRepositories', 'scannedRepositories', 'missingMembers', 'failed'].map(key => [key, (publicProof?.[key] ?? 0) + (privateProof?.[key] ?? 0)])),
    };
  }
  if (privateStatus !== undefined) data.publication.privateAttemptStatus = privateStatus;
  if (externalPrivateBlobSha) data.publication.privateSnapshotBlobSha = externalPrivateBlobSha;
  if (retainedBaseline) Object.assign(data.publication, {
    privateStatus: 'retained', privateDatasetEpoch: retainedBaseline.sourceEpoch,
    privateRulesVersion: envelope.rulesVersion, privateScopeVerifiedAt: retainedBaseline.scope.verifiedAt,
    privateProvenance: {mode: retainedBaseline.mode, sourceStateCommit: retainedBaseline.sourceStateCommit,
      sourceSnapshotSha256: retainedBaseline.sourceSnapshotSha256, retainedSnapshotSha256: retainedBaseline.retainedSnapshotSha256},
  });
  return data;
}

export function validatePrivateMetricsReplacement(previous, next, publicStats, {resetEpoch, preserveScope = false, allowRebuilt = false} = {}) {
  validatePrivateMetrics(previous);
  validatePrivateMetrics(next);
  if (allowRebuilt) validateRebuiltPrivateMetrics(next);
  else requireComplete(next);
  if (publicStats) matchingLineage(publicStats, next);
  if (previous.lineageVersion !== next.lineageVersion && previous.datasetEpoch === next.datasetEpoch) throw new Error('Lineage configuration changed; a new dataset epoch is required.');
  if (previous.datasetEpoch !== next.datasetEpoch) {
    if (!resetEpoch || resetEpoch !== next.datasetEpoch) throw new Error('Dataset epoch mismatch; explicit reset required.');
    if (!preserveScope) return true;
  }
  if (timeKey(next.generatedAt) < timeKey(previous.generatedAt)) throw new Error('Private snapshot is older than durable metrics; retaining previous sanitized metrics.');
  const nextByKey = new Map(next.repositories.map(repository => [repository.sourceKey, repository]));
  for (const repository of previous.repositories) {
    const replacement = nextByKey.get(repository.sourceKey);
    if (replacement && repository.lastSuccessAt !== null && (replacement.lastSuccessAt === null || timeKey(replacement.lastSuccessAt) < timeKey(repository.lastSuccessAt))) throw new Error('Private repository success time is older than durable metrics; retaining previous sanitized metrics.');
  }
  const available = new Set(next.repositories.flatMap(representedKeys));
  const publicKeys = new Set((publicStats?.repositories ?? []).filter(repository => repository.visibility !== 'private' && !String(repository.id).startsWith('private-') && repository.status === 'active' && repository.rulesVersion === next.rulesVersion && repository.rulesVersion === publicStats.rules?.version).flatMap(repository => [anonymousKey(repository.id), ...representedKeys(repository)]));
  // 无状态 CI 无法区分权限缩小和仓库消失；只有已证实转公开时才能移除匿名记录。
  if (previous.repositories.flatMap(representedKeys).some(key => !available.has(key) && !publicKeys.has(key) && !next.archivedRepositoryKeys?.includes(key))) throw new Error('Private repository scope decreased; retaining previous sanitized metrics.');
  return true;
}

export async function adoptPrivateMetrics(filename, candidateFilename, publicFilename) {
  const bytes = await readFile(candidateFilename, 'utf8');
  const next = JSON.parse(bytes);
  validatePrivateMetrics(next);
  requireComplete(next);
  const publicStats = JSON.parse(await readFile(publicFilename, 'utf8'));
  matchingLineage(publicStats, next);
  if (publicStats.datasetEpoch !== next.datasetEpoch) throw new Error('Dataset epoch mismatch; refusing private adoption.');
  let previousBytes;
  try {
    previousBytes = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previousBytes !== undefined) validatePrivateMetricsReplacement(JSON.parse(previousBytes), next, publicStats, {resetEpoch: publicStats.datasetEpoch});
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, {force: true});
  }
}

export function privatePublicationStatus({jobResult, scanStatus, available, downloadOutcome, adoptStatus}) {
  if (jobResult !== 'success' || scanStatus === 'stale') return 'stale';
  if (available !== 'true') return 'not-configured';
  return downloadOutcome === 'success' && adoptStatus === 'available' ? 'available' : 'stale';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, filename, argument, publicFilename, ...extra] = process.argv.slice(2);
    if (command === 'status' && !filename) {
      console.log(privatePublicationStatus({jobResult: process.env.PRIVATE_JOB_RESULT, scanStatus: process.env.PRIVATE_SCAN_STATUS, available: process.env.PRIVATE_CANDIDATE_AVAILABLE, downloadOutcome: process.env.PRIVATE_DOWNLOAD_OUTCOME, adoptStatus: process.env.PRIVATE_ADOPT_STATUS}));
    } else if (extra.length || !filename) throw new Error('Invalid metrics arguments');
    else if (command === 'adopt' && argument && publicFilename) {
      await adoptPrivateMetrics(filename, argument, publicFilename);
      console.log('Adopted complete sanitized private metrics.');
    } else {
      if (command !== 'validate' || publicFilename || (argument && argument !== '--complete')) throw new Error('Invalid metrics arguments');
      const data = JSON.parse(await readFile(filename, 'utf8'));
      validatePrivateMetrics(data);
      if (argument === '--complete') requireComplete(data);
      console.log('Validated sanitized private metrics.');
    }
  } catch {
    console.error('Private metrics are invalid, incomplete, older or have reduced scope; previous sanitized snapshot must be retained.');
    process.exitCode = 1;
  }
}
