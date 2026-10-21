import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const [command, filename] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required');
if (!['restore', 'save'].includes(command) || !filename) throw new Error('Usage: state.mjs restore|save path');
const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
async function api(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {method, headers, body: body ? JSON.stringify(body) : undefined});
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub state ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const ref = await api('/git/ref/heads/tally-state', 'GET', undefined, true);
const commit = ref ? await api(`/git/commits/${ref.object.sha}`) : null;
const tree = commit ? await api(`/git/trees/${commit.tree.sha}`) : null;
const entry = tree?.tree.find(item => item.path === 'checkpoint.json');
if (command === 'restore') {
  if (!ref) {
    console.log('No durable state branch yet; first collection.');
  } else {
    if (!entry) throw new Error('Durable state branch has no checkpoint; refusing to lose collected history');
    const blob = await api(`/git/blobs/${entry.sha}`);
    const bytes = Buffer.from(blob.content, 'base64');
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.repositories)) throw new Error('Invalid durable checkpoint');
    if (data.repositories.some(repo => repo.private !== false)) throw new Error('Public state contains private records');
    await mkdir(dirname(filename), {recursive: true});
    await writeFile(filename, bytes);
    console.log(`Restored ${data.repositories.length} public repository records from durable state.`);
  }
} else {
  const bytes = await readFile(filename);
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.repositories) || data.repositories.some(repo => repo.private !== false)) throw new Error('Refusing invalid or private checkpoint');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (entry?.sha === sha) {
    console.log('No inventory/history/status change; no data commit created.');
  } else {
    const blob = await api('/git/blobs', 'POST', {content: bytes.toString('base64'), encoding: 'base64'});
    const nextTree = await api('/git/trees', 'POST', {...(commit ? {base_tree: commit.tree.sha} : {}), tree: [{path: 'checkpoint.json', mode: '100644', type: 'blob', sha: blob.sha}]});
    const nextCommit = await api('/git/commits', 'POST', {message: 'data: update public code inventory checkpoint', tree: nextTree.sha, parents: ref ? [ref.object.sha] : []});
    if (ref) await api('/git/refs/heads/tally-state', 'PATCH', {sha: nextCommit.sha, force: false});
    else await api('/git/refs', 'POST', {ref: 'refs/heads/tally-state', sha: nextCommit.sha});
    console.log('Saved durable public checkpoint.');
  }
}
