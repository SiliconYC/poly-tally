import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePrivateMetrics, validatePrivateMetricsReplacement} from './metrics.mjs';

function privateData(bytes, complete = false) {
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
    validatePrivateMetrics(data);
  } catch {
    throw new Error('Refusing invalid sanitized private metrics');
  }
  if (complete && data.collection.failed > 0) throw new Error('Private collection incomplete; retaining durable sanitized metrics');
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
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required');
  if (!['restore', 'save', 'save-private'].includes(command) || !filename || (command === 'save-private' && privateFilename)) throw new Error('Usage: state.mjs restore|save checkpoint [sanitized-private-file] | save-private sanitized-private-file');
  const token = env.GH_TOKEN || (gitCredential ? credentialReader(repository, env) : undefined);
  if (command !== 'restore' && !token) throw new Error('GH_TOKEN or explicit --git-credential is required to save durable state');
  const files = [];
  if (command === 'save-private') {
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
    if (!ref) {
      logger.log('No durable state branch yet; retaining bundled sanitized metrics.');
      return;
    }
    const checkpoint = entryFor('checkpoint.json');
    const metrics = entryFor('private-metrics.json');
    if (!checkpoint && !metrics) throw new Error('Durable state branch has no checkpoint; refusing to lose collected history');
    const restore = [];
    if (checkpoint) {
      const bytes = await readBlob(checkpoint);
      publicData(bytes);
      restore.push({filename, bytes});
    }
    if (metrics && privateFilename) {
      const bytes = await readBlob(metrics);
      privateData(bytes, true);
      restore.push({filename: privateFilename, bytes});
    }
    for (const item of restore) {
      await mkdir(dirname(item.filename), {recursive: true});
      await writeFile(item.filename, item.bytes);
    }
    logger.log('Restored available durable public checkpoint and sanitized private metrics.');
    return;
  }
  const changed = [];
  for (const file of files) {
    const entry = entryFor(file.path);
    const sha = createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex');
    if (entry?.sha === sha) continue;
    if (entry && file.path === 'private-metrics.json') {
      const previous = privateData(await readBlob(entry), true);
      let checkpoint = files.find(item => item.path === 'checkpoint.json')?.data;
      const checkpointEntry = entryFor('checkpoint.json');
      if (!checkpoint && checkpointEntry) checkpoint = publicData(await readBlob(checkpointEntry));
      const publicStats = checkpoint ? {rules: {version: file.data.rulesVersion}, repositories: checkpoint.repositories} : undefined;
      validatePrivateMetricsReplacement(previous, file.data, publicStats);
      // 采集时刻变化不产生数据提交；发布页面仍使用本次实际收到的快照时间。
      if (privateFingerprint(previous) === privateFingerprint(file.data)) continue;
    }
    changed.push(file);
  }
  if (!changed.length) {
    logger.log('No inventory/history/status change; no data commit created.');
    return;
  }
  const entries = [];
  for (const file of changed) {
    const blob = await api('/git/blobs', 'POST', {content: file.bytes.toString('base64'), encoding: 'base64'});
    entries.push({path: file.path, mode: '100644', type: 'blob', sha: blob.sha});
  }
  const nextTree = await api('/git/trees', 'POST', {...(commit ? {base_tree: commit.tree.sha} : {}), tree: entries});
  const nextCommit = await api('/git/commits', 'POST', {message: command === 'save-private' ? 'data: update sanitized private repository metrics' : 'data: update repository metrics state', tree: nextTree.sha, parents: ref ? [ref.object.sha] : []});
  if (ref) await api('/git/refs/heads/tally-state', 'PATCH', {sha: nextCommit.sha, force: false});
  else await api('/git/refs', 'POST', {ref: 'refs/heads/tally-state', sha: nextCommit.sha});
  logger.log('Saved durable public checkpoint and/or sanitized private metrics.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arguments_ = process.argv.slice(2);
    const gitCredential = arguments_.includes('--git-credential');
    const [command, filename, privateFilename, ...extra] = arguments_.filter(argument => argument !== '--git-credential');
    if (extra.length) throw new Error('Unexpected state arguments');
    await runState(command, filename, privateFilename, {gitCredential});
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Required state input file is missing.' : error.message);
    process.exitCode = 1;
  }
}
