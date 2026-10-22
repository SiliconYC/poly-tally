import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePrivateMetrics, validatePrivateMetricsReplacement, validateCompletePrivateMetrics, validateRebuiltPrivateMetrics, validatePrivateSnapshotBlob} from './metrics.mjs';

function privateData(bytes, complete = false) {
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
    validatePrivateMetrics(data);
  } catch {
    throw new Error('Refusing invalid sanitized private metrics');
  }
  if (complete) validateCompletePrivateMetrics(data);
  return data;
}
function publicData(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.repositories) || data.repositories.some(repository => repository.private !== false)) throw new Error('Refusing invalid or private checkpoint');
  return data;
}
function privateFingerprint(data) {
  const copy = structuredClone(data);
  delete copy.generatedAt;
  for (const repository of copy.repositories) {
    delete repository.lastSuccessAt;
    for (const snapshot of repository.history) snapshot.timestamp = snapshot.timestamp.slice(0, 10);
  }
  return JSON.stringify(copy);
}

function localCredential(repository, env) {
  try {
    const output = execFileSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: {...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'}});
    const password = output.split('\n').find(line => line.startsWith('password='))?.slice('password='.length);
    if (!password) throw new Error('Credential helper returned no password');
    return password;
  } catch {
    throw new Error('Unable to read a GitHub credential from the local helper');
  }
}

export async function runState(command, filename, privateFilename, {env = process.env, fetcher = fetch, logger = console, gitCredential = false, credentialReader = localCredential} = {}) {
  const epoch = env.POLY_TALLY_DATASET_EPOCH;
  const externalSha = command === 'restore' ? env.POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA : undefined;
  if (epoch && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(epoch)) throw new Error('Invalid dataset epoch');
  if (externalSha && (!/^[a-f0-9]{40}$/.test(externalSha) || !epoch || !privateFilename)) throw new Error('External private snapshot requires a valid blob SHA, dataset epoch and destination.');
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required');
  if (!['restore', 'save', 'save-private', 'save-rebuilt-private'].includes(command) || !filename || (['save-private', 'save-rebuilt-private'].includes(command) && privateFilename)) throw new Error('Usage: state.mjs restore|save checkpoint [sanitized-private-file] | save-private|save-rebuilt-private sanitized-private-file');
  const token = env.GH_TOKEN || (gitCredential ? credentialReader(repository, env) : undefined);
  if (command !== 'restore' && !token) throw new Error('GH_TOKEN or explicit --git-credential is required to save durable state');
  const files = [];
  if (command === 'save-rebuilt-private') {
    const bytes = await readFile(filename);
    const data = privateData(bytes);
    validateRebuiltPrivateMetrics(data);
    files.push({path:'rebuilt-private-metrics.json', bytes, data});
  } else if (command === 'save-private') {
    const bytes = await readFile(filename);
    files.push({path: 'private-metrics.json', bytes, data: privateData(bytes, true)});
  } else if (command === 'save') {
    const bytes = await readFile(filename);
    const data = publicData(bytes);
    files.push({path: 'checkpoint.json', bytes, data});
    if (privateFilename) {
      const bytes = await readFile(privateFilename);
      files.push({path: 'private-metrics.json', bytes, data: privateData(bytes, true)});
    }
  }
  if (epoch && files.some(file => file.data.datasetEpoch !== epoch)) throw new Error('Dataset epoch mismatch; refusing durable publication.');
  const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  if (token) headers.Authorization = `Bearer ${token}`;
  async function api(path, method = 'GET', body, allowMissing = false) {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {method, headers, body: body ? JSON.stringify(body) : undefined});
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`GitHub durable state request failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const ref = await api('/git/ref/heads/tally-state', 'GET', undefined, true);
  const commit = ref ? await api(`/git/commits/${ref.object.sha}`) : null;
  const tree = commit ? await api(`/git/trees/${commit.tree.sha}`) : null;
  const entryFor = path => tree?.tree.find(item => item.path === path && (!item.type || item.type === 'blob'));
  async function readBlob(entry) {
    const blob = await api(`/git/blobs/${entry.sha}`);
    return Buffer.from(blob.content, 'base64');
  }
  if (command === 'restore') {
    const checkpoint = entryFor('checkpoint.json');
    const metrics = entryFor('private-metrics.json');
    if (externalSha && !metrics) throw new Error('Selected external private snapshot is missing from durable state.');
    if (ref && !checkpoint && !metrics) throw new Error('Durable state branch has no checkpoint; refusing to lose collected history');
    const restore = [];
    const rebuiltFilename = privateFilename ? `${dirname(privateFilename)}/rebuilt-private-metrics.json` : undefined;
    let publicCurrent = false;
    let privateCurrent = false;
    if (checkpoint) {
      const bytes = await readBlob(checkpoint);
      const data = publicData(bytes);
      if (!epoch || data.datasetEpoch === epoch) {
        restore.push({filename, bytes});
        publicCurrent = true;
      }
    }
    if (metrics && privateFilename) {
      const bytes = await readBlob(metrics);
      const data = externalSha ? validatePrivateSnapshotBlob(bytes, externalSha) : privateData(bytes, true);
      if (externalSha && data.datasetEpoch !== epoch) throw new Error('External private snapshot dataset epoch mismatch.');
      // Explicit byte selection may bootstrap a reset before public collection;
      // build-site still checks its rules and lineage against the new public run.
      if (!epoch || (data.datasetEpoch === epoch && (publicCurrent || externalSha))) {
        restore.push({filename: privateFilename, bytes});
        privateCurrent = true;
      }
    }
    const rebuiltEntry = entryFor('rebuilt-private-metrics.json');
    let rebuiltCurrent = false;
    if (!privateCurrent && rebuiltEntry && rebuiltFilename) {
      const bytes = await readBlob(rebuiltEntry);
      const data = privateData(bytes);
      validateRebuiltPrivateMetrics(data);
      if (data.datasetEpoch === epoch && publicCurrent) {
        restore.push({filename:rebuiltFilename, bytes});
        rebuiltCurrent = true;
      }
    }
    // Remove only local generated inputs, never the durable branch or Git history.
    // A bundled/cache snapshot cannot impersonate the newly requested baseline.
    if (epoch) {
      if (!publicCurrent) await rm(filename, {force: true});
      if (!privateCurrent && privateFilename) await rm(privateFilename, {force: true});
      if (!rebuiltCurrent && rebuiltFilename) await rm(rebuiltFilename, {force:true});
    }
    for (const item of restore) {
      await mkdir(dirname(item.filename), {recursive: true});
      await writeFile(item.filename, item.bytes);
    }
    logger.log(epoch && !publicCurrent ? 'New dataset epoch: public rebuild required; prior snapshots are excluded.' : 'Restored available durable public checkpoint and sanitized private metrics.');
    return {resetRequired: Boolean(epoch && !publicCurrent), privatePending: Boolean(epoch && !privateCurrent && !rebuiltCurrent)};
  }
  let checkpoint = files.find(item => item.path === 'checkpoint.json')?.data;
  const checkpointEntry = entryFor('checkpoint.json');
  const previousCheckpoint = checkpointEntry ? publicData(await readBlob(checkpointEntry)) : undefined;
  checkpoint ??= previousCheckpoint;
  if (epoch) {
    if (checkpoint?.datasetEpoch !== epoch) throw new Error('Current public dataset epoch is required before private publication.');
    if (previousCheckpoint?.datasetEpoch !== epoch && (checkpoint.collection?.failed !== 0 || (checkpoint.lineageVersion && checkpoint.collection?.completeness?.complete !== true))) throw new Error('A complete public rebuild is required to initialize the new dataset epoch.');
  }
  const rebuiltFile = files.find(file => file.path === 'rebuilt-private-metrics.json');
  if (rebuiltFile) {
    const baselineEntries = [entryFor('private-metrics.json'), entryFor('rebuilt-private-metrics.json')].filter(Boolean);
    if (!baselineEntries.length) throw new Error('Offline rebuilt publication requires an existing private scope baseline.');
    for (const entry of baselineEntries) {
      const previous = privateData(await readBlob(entry));
      validatePrivateMetricsReplacement(previous, rebuiltFile.data, {rules:{version:rebuiltFile.data.rulesVersion}, lineageVersion:checkpoint.lineageVersion, repositories:checkpoint.repositories}, {resetEpoch:epoch, preserveScope:true, allowRebuilt:true});
    }
  }
  const changed = [];
  let privateBlobSha;
  for (const file of files) {
    const entry = entryFor(file.path);
    if (file.path === 'private-metrics.json') privateBlobSha = entry?.sha;
    const sha = createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex');
    if (entry?.sha === sha) continue;
    if (entry && file.path === 'private-metrics.json') {
      const previous = privateData(await readBlob(entry), true);
      const publicStats = checkpoint ? {rules: {version: file.data.rulesVersion}, lineageVersion: checkpoint.lineageVersion, repositories: checkpoint.repositories} : undefined;
      validatePrivateMetricsReplacement(previous, file.data, publicStats, {resetEpoch: epoch, preserveScope:true});
      const rebuiltEntry = entryFor('rebuilt-private-metrics.json');
      if (rebuiltEntry) validatePrivateMetricsReplacement(privateData(await readBlob(rebuiltEntry)), file.data, publicStats, {resetEpoch:epoch, preserveScope:true});
      // 采集时刻变化不产生数据提交；发布页面仍使用本次实际收到的快照时间。
      if (privateFingerprint(previous) === privateFingerprint(file.data)) continue;
    }
    changed.push(file);
  }
  if (!changed.length) {
    logger.log('No inventory/history/status change; no data commit created.');
    return privateBlobSha ? {privateBlobSha} : {};
  }
  const entries = [];
  for (const file of changed) {
    const blob = await api('/git/blobs', 'POST', {content: file.bytes.toString('base64'), encoding: 'base64'});
    if (file.path === 'private-metrics.json') privateBlobSha = blob.sha;
    entries.push({path: file.path, mode: '100644', type: 'blob', sha: blob.sha});
  }
  const nextTree = await api('/git/trees', 'POST', {...(commit ? {base_tree: commit.tree.sha} : {}), tree: entries});
  const nextCommit = await api('/git/commits', 'POST', {message: ['save-private', 'save-rebuilt-private'].includes(command) ? 'data: update sanitized private repository metrics' : 'data: update repository metrics state', tree: nextTree.sha, parents: ref ? [ref.object.sha] : []});
  if (ref) await api('/git/refs/heads/tally-state', 'PATCH', {sha: nextCommit.sha, force: false});
  else await api('/git/refs', 'POST', {ref: 'refs/heads/tally-state', sha: nextCommit.sha});
  logger.log('Saved durable public checkpoint and/or sanitized private metrics.');
  return privateBlobSha ? {privateBlobSha} : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arguments_ = process.argv.slice(2);
    const gitCredential = arguments_.includes('--git-credential');
    const [command, filename, privateFilename, ...extra] = arguments_.filter(argument => argument !== '--git-credential');
    if (extra.length) throw new Error('Unexpected state arguments');
    const result = await runState(command, filename, privateFilename, {gitCredential});
    if (result?.privateBlobSha) console.log(`private-blob-sha=${result.privateBlobSha}`);
    if (command === 'restore' && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `reset-required=${result.resetRequired}\nprivate-pending=${result.privatePending}\n`);
    }
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Required state input file is missing.' : error.message);
    process.exitCode = 1;
  }
}
