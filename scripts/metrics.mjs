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
const repositoryName = repository => repository.name === `私有仓库 · ${repository.sourceKey.slice(0, 6)}` || (typeof repository.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.name) && !['.', '..'].includes(repository.name.split('/')[1]));
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

export function validatePrivateMetrics(envelope) {
  exactKeys(envelope, ['schemaVersion', 'generatedAt', 'rulesVersion', 'source', 'collection', 'repositories', ...('datasetEpoch' in envelope ? ['datasetEpoch'] : []), ...('archivedRepositoryKeys' in envelope ? ['archivedRepositoryKeys'] : [])]);
  if ('datasetEpoch' in envelope && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(envelope.datasetEpoch)) reject();
  if ('archivedRepositoryKeys' in envelope && (!Array.isArray(envelope.archivedRepositoryKeys) || !envelope.archivedRepositoryKeys.every(hexKey) || new Set(envelope.archivedRepositoryKeys).size !== envelope.archivedRepositoryKeys.length)) reject();
  exactKeys(envelope.collection, ['repositories', 'failed']);
  if (envelope.schemaVersion !== 1 || !iso(envelope.generatedAt) || !hexKey(envelope.rulesVersion) || !['local', 'github-actions'].includes(envelope.source) || !Array.isArray(envelope.repositories) || !integer(envelope.collection.repositories) || envelope.collection.repositories !== envelope.repositories.length || !integer(envelope.collection.failed) || envelope.collection.failed > envelope.collection.repositories) reject();
  const seen = new Set();
  for (const repository of envelope.repositories) {
    exactKeys(repository, repositoryKeys);
    if (!hexKey(repository.sourceKey) || repository.id !== `private-${repository.sourceKey}` || !repositoryName(repository) || seen.has(repository.sourceKey) || repository.visibility !== 'private' || repository.snapshotKind !== 'daily' || repository.url !== null || repository.branch !== null || repository.head !== null || !statuses.has(repository.status) || (repository.lastSuccessAt !== null && !iso(repository.lastSuccessAt)) || !hexKey(repository.rulesVersion) || typeof repository.historyComplete !== 'boolean' || repository.notice !== notice || !integer(repository.skippedFiles) || !Array.isArray(repository.history)) reject();
    if (envelope.archivedRepositoryKeys?.includes(repository.sourceKey)) reject();
    seen.add(repository.sourceKey);
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
  return true;
}

export function mergePrivateMetrics(publicStats, envelope) {
  validatePrivateMetrics(envelope);
  if (publicStats?.schemaVersion !== 1 || !Array.isArray(publicStats.repositories) || typeof publicStats.rules?.version !== 'string') throw new Error('Invalid public dataset');
  if (publicStats.datasetEpoch !== envelope.datasetEpoch) throw new Error('Dataset epoch mismatch; old private metrics cannot enter the rebuilt dataset.');
  const data = structuredClone(publicStats);
  const privateData = structuredClone(envelope);
  if (!Number.isFinite(Date.parse(data.generatedAt)) || Date.parse(envelope.generatedAt) > Date.parse(data.generatedAt)) data.generatedAt = envelope.generatedAt;
  const current = repository => repository.status === 'active' && repository.rulesVersion === data.rules.version;
  const publicRepositories = data.repositories.filter(repository => repository.status !== 'archived' && repository.visibility !== 'private' && !repository.id.startsWith('private-'));
  const publicKeys = new Set(publicRepositories.filter(current).map(repository => anonymousKey(repository.id)));
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
  data.publication = {privateRepositories: privateRepositories.length, privateUpdatedAt: envelope.generatedAt, privateSource: envelope.source, privateStatus: envelope.collection.failed > 0 || privateRepositories.some(repository => repository.rulesVersion !== data.rules.version || ['stale', 'inaccessible'].includes(repository.status)) ? 'stale' : 'available'};
  return data;
}

export function validatePrivateMetricsReplacement(previous, next, publicStats, {resetEpoch} = {}) {
  validatePrivateMetrics(previous);
  validatePrivateMetrics(next);
  if (next.collection.failed > 0) throw new Error('Private collection incomplete; retaining durable sanitized metrics');
  if (previous.datasetEpoch !== next.datasetEpoch) {
    if (resetEpoch && resetEpoch === next.datasetEpoch) return true;
    throw new Error('Dataset epoch mismatch; explicit reset required.');
  }
  if (timeKey(next.generatedAt) < timeKey(previous.generatedAt)) throw new Error('Private snapshot is older than durable metrics; retaining previous sanitized metrics.');
  const nextByKey = new Map(next.repositories.map(repository => [repository.sourceKey, repository]));
  for (const repository of previous.repositories) {
    const replacement = nextByKey.get(repository.sourceKey);
    if (replacement && repository.lastSuccessAt !== null && (replacement.lastSuccessAt === null || timeKey(replacement.lastSuccessAt) < timeKey(repository.lastSuccessAt))) throw new Error('Private repository success time is older than durable metrics; retaining previous sanitized metrics.');
  }
  const available = new Set(next.repositories.map(repository => repository.sourceKey));
  const publicKeys = new Set((publicStats?.repositories ?? []).filter(repository => repository.visibility !== 'private' && !String(repository.id).startsWith('private-') && repository.status === 'active' && repository.rulesVersion === next.rulesVersion && repository.rulesVersion === publicStats.rules?.version).map(repository => anonymousKey(repository.id)));
  // 无状态 CI 无法区分权限缩小和仓库消失；只有已证实转公开时才能移除匿名记录。
  if (previous.repositories.some(repository => !available.has(repository.sourceKey) && !publicKeys.has(repository.sourceKey) && !next.archivedRepositoryKeys?.includes(repository.sourceKey))) throw new Error('Private repository scope decreased; retaining previous sanitized metrics.');
  return true;
}

export async function adoptPrivateMetrics(filename, candidateFilename, publicFilename) {
  const bytes = await readFile(candidateFilename, 'utf8');
  const next = JSON.parse(bytes);
  validatePrivateMetrics(next);
  if (next.collection.failed > 0) throw new Error('Private collection incomplete; retaining durable sanitized metrics');
  const publicStats = JSON.parse(await readFile(publicFilename, 'utf8'));
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
      if (argument === '--complete' && data.collection.failed > 0) throw new Error('Private collection incomplete');
      console.log('Validated sanitized private metrics.');
    }
  } catch {
    console.error('Private metrics are invalid, incomplete, older or have reduced scope; previous sanitized snapshot must be retained.');
    process.exitCode = 1;
  }
}
