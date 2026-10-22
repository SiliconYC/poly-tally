import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {validatePrivateMetrics} from './metrics.mjs';

const envelope = {schemaVersion: 1, generatedAt: '2026-10-21T04:00:00Z', rulesVersion: '0123456789abcdef', source: 'local', collection: {repositories: 0, failed: 0}, repositories: []};
const checkpoint = {schemaVersion: 1, repositories: [{id: '1', private: false}]};
const bytes = data => Buffer.from(JSON.stringify(data));
const gitBlobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function github(files = {}, {missing = false} = {}) {
  const requests = [];
  return {requests, fetcher: async (url, options) => {
    const path = new URL(url).pathname.replace('/repos/owner/project', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({path, method: options.method, body, headers: options.headers});
    let result;
    if (path === '/git/ref/heads/tally-state') {
      if (missing) return new Response('{}', {status: 404});
      result = {object: {sha: 'existing-commit'}};
    } else if (path === '/git/commits/existing-commit') result = {tree: {sha: 'existing-tree'}};
    else if (path === '/git/trees/existing-tree') result = {tree: Object.keys(files).map(name => ({path: name, sha: gitBlobSha(bytes(files[name])), type: 'blob'}))};
    else if (path.startsWith('/git/blobs/') && options.method === 'GET') {
      const name = Object.keys(files).find(name => gitBlobSha(bytes(files[name])) === path.slice('/git/blobs/'.length));
      result = {content: bytes(files[name]).toString('base64'), encoding: 'base64'};
    } else if (path === '/git/blobs' && options.method === 'POST') result = {sha: gitBlobSha(Buffer.from(body.content, 'base64'))};
    else if (path === '/git/trees' && options.method === 'POST') result = {sha: 'new-tree'};
    else if (path === '/git/commits' && options.method === 'POST') result = {sha: 'new-commit'};
    else if (path.startsWith('/git/refs')) result = {};
    else throw new Error(`Unexpected test request ${options.method} ${path}`);
    return Response.json(result);
  }};
}
async function run(t, command, firstData, secondData, remote = {}, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tally-state-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = join(directory, 'first.json');
  const privateFilename = join(directory, 'private.json');
  if (firstData) await writeFile(filename, bytes(firstData));
  if (secondData) await writeFile(privateFilename, bytes(secondData));
  const api = github(remote, extra);
  const logs = [];
  const {runState} = await import('./state.mjs');
  const outcome = await runState(command, filename, extra.noPrivate ? undefined : privateFilename, {env: {GITHUB_REPOSITORY: 'owner/project', GH_TOKEN: 'secret-token', ...extra.env}, fetcher: api.fetcher, logger: {log: text => logs.push(text)}});
  return {filename, privateFilename, logs, outcome, ...api};
}

test('restore keeps bundled private fallback when no durable branch or private file exists', async t => {
  const result = await run(t, 'restore', null, envelope, {}, {missing: true});
  assert.deepEqual(JSON.parse(await readFile(result.privateFilename)), envelope);
  const existingPublic = await run(t, 'restore', null, envelope, {'checkpoint.json': checkpoint});
  assert.deepEqual(JSON.parse(await readFile(existingPublic.filename)), checkpoint);
  assert.deepEqual(JSON.parse(await readFile(existingPublic.privateFilename)), envelope);
});

test('restore validates and writes private metrics alongside the public checkpoint', async t => {
  const result = await run(t, 'restore', null, null, {'checkpoint.json': checkpoint, 'private-metrics.json': envelope});
  assert.deepEqual(JSON.parse(await readFile(result.filename)), checkpoint);
  assert.deepEqual(JSON.parse(await readFile(result.privateFilename)), envelope);
  const privateOnly = await run(t, 'restore', null, null, {'private-metrics.json': envelope});
  assert.deepEqual(JSON.parse(await readFile(privateOnly.privateFilename)), envelope);
});

test('local save-private updates only the sanitized blob while preserving the checkpoint tree', async t => {
  const result = await run(t, 'save-private', envelope, null, {'checkpoint.json': checkpoint}, {noPrivate: true});
  const tree = result.requests.find(request => request.path === '/git/trees' && request.method === 'POST').body;
  assert.equal(tree.base_tree, 'existing-tree');
  assert.deepEqual(tree.tree.map(entry => entry.path), ['private-metrics.json']);
  const blobs = result.requests.filter(request => request.path === '/git/blobs' && request.method === 'POST');
  assert.deepEqual(JSON.parse(Buffer.from(blobs[0].body.content, 'base64')), envelope);
  assert.equal(result.requests[0].headers.Authorization, 'Bearer secret-token');
  assert.ok(result.logs.every(log => !log.includes('secret-token')));
});

test('combined save writes both whitelisted state filenames and refuses raw private checkpoint records', async t => {
  const result = await run(t, 'save', checkpoint, envelope, {});
  const tree = result.requests.find(request => request.path === '/git/trees' && request.method === 'POST').body;
  assert.deepEqual(tree.tree.map(entry => entry.path), ['checkpoint.json', 'private-metrics.json']);
  await assert.rejects(run(t, 'save', {schemaVersion: 1, repositories: [{private: true}]}, envelope, {}), /private checkpoint/);
});

test('invalid or partial private snapshots cannot replace durable metrics', async t => {
  const unsafe = {...envelope, privatePath: 'SENSITIVE-secret/path'};
  await assert.rejects(run(t, 'save-private', unsafe, null, {'private-metrics.json': envelope}, {noPrivate: true}), error => !error.message.includes('SENSITIVE'));
  const key = 'fedcba9876543210';
  const partial = {...envelope, collection: {repositories: 1, failed: 1}, repositories: [{id: `private-${key}`, sourceKey: key, name: `私有仓库 · ${key.slice(0, 6)}`, visibility: 'private', snapshotKind: 'daily', url: null, branch: null, head: null, status: 'inaccessible', lastSuccessAt: null, rulesVersion: envelope.rulesVersion, historyComplete: false, notice: '私有仓库：仅公开按日规模，不公开源码与提交详情。', skippedFiles: 0, history: []}]};
  assert.equal(validatePrivateMetrics(partial), true);
  await assert.rejects(run(t, 'save-private', partial, null, {'private-metrics.json': envelope}, {noPrivate: true}), /incomplete/);
});

test('identical semantic private metrics do not create scan-only data commits', async t => {
  const newer = {...envelope, generatedAt: '2026-10-21T05:00:00Z'};
  const result = await run(t, 'save-private', newer, null, {'private-metrics.json': envelope}, {noPrivate: true});
  assert.equal(result.requests.filter(request => request.method !== 'GET').length, 0);
});

test('publishing reads a local helper only with the explicit credential option', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tally-credential-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filename = join(directory, 'private.json');
  await writeFile(filename, bytes(envelope));
  const {runState} = await import('./state.mjs');
  const api = github({}, {missing: true});
  let reads = 0;
  const credentialReader = () => { reads++; return 'helper-secret'; };
  const options = {env: {GITHUB_REPOSITORY: 'owner/project'}, fetcher: api.fetcher, logger: {log() {}}, credentialReader};
  await assert.rejects(runState('save-private', filename, undefined, options), /GH_TOKEN/);
  assert.equal(reads, 0);
  await runState('save-private', filename, undefined, {...options, gitCredential: true});
  assert.equal(reads, 1);
  assert.equal(api.requests[0].headers.Authorization, 'Bearer helper-secret');
});

test('durable publication refuses a smaller token scope even when the scan reports zero failures', async t => {
  const previous = {...envelope, collection: {repositories: 1, failed: 0}, repositories: [{id: 'private-fedcba9876543210', sourceKey: 'fedcba9876543210', name: '私有仓库 · fedcba', visibility: 'private', snapshotKind: 'daily', url: null, branch: null, head: null, status: 'active', lastSuccessAt: null, rulesVersion: envelope.rulesVersion, historyComplete: true, notice: '私有仓库：仅公开按日规模，不公开源码与提交详情。', skippedFiles: 0, history: []}]};
  await assert.rejects(run(t, 'save-private', envelope, null, {'private-metrics.json': previous, 'checkpoint.json': checkpoint}, {noPrivate: true}), /scope/);
  await assert.rejects(run(t, 'save', checkpoint, envelope, {'private-metrics.json': previous}), /scope/);
});

test('local and combined durable publication reject a complete scan older than the stored snapshot', async t => {
  const older = {...envelope, generatedAt: '2026-10-20T04:00:00Z'};
  await assert.rejects(run(t, 'save-private', older, null, {'private-metrics.json': envelope}, {noPrivate: true}), /older/);
  await assert.rejects(run(t, 'save', checkpoint, older, {'private-metrics.json': envelope}), /older/);
});


const epoch = 'reset-test-v2';
const currentCheckpoint = {...checkpoint, datasetEpoch: epoch, collection: {failed: 0, repositories: 1, recomputedCommits: 2}};
const currentPrivate = {...envelope, datasetEpoch: epoch, archivedRepositoryKeys: []};
const epochEnv = {POLY_TALLY_DATASET_EPOCH: epoch};

test('epoch restore never revives old checkpoint or bundled private fallback', async t => {
  const result = await run(t, 'restore', checkpoint, envelope, {'checkpoint.json': checkpoint, 'private-metrics.json': envelope}, {env: epochEnv});
  assert.equal(result.outcome.resetRequired, true);
  assert.equal(result.outcome.privatePending, true);
  await assert.rejects(readFile(result.filename), {code: 'ENOENT'});
  await assert.rejects(readFile(result.privateFilename), {code: 'ENOENT'});
  const absent = await run(t, 'restore', checkpoint, envelope, {}, {env: epochEnv, missing: true});
  assert.equal(absent.outcome.resetRequired, true);
  await assert.rejects(readFile(absent.privateFilename), {code: 'ENOENT'});
});

test('successful public reset enables future incremental restore but private remains pending', async t => {
  const result = await run(t, 'restore', null, envelope, {'checkpoint.json': currentCheckpoint, 'private-metrics.json': envelope}, {env: epochEnv});
  assert.equal(result.outcome.resetRequired, false);
  assert.equal(result.outcome.privatePending, true);
  assert.deepEqual(JSON.parse(await readFile(result.filename)), currentCheckpoint);
  await assert.rejects(readFile(result.privateFilename), {code: 'ENOENT'});
});

test('reset save requires current epoch and a fully successful new public scan before any writes', async t => {
  await assert.rejects(run(t, 'save', checkpoint, null, {}, {env: epochEnv, noPrivate: true}), /epoch/i);
  await assert.rejects(run(t, 'save', {...currentCheckpoint, collection: {failed: 1}}, null, {'checkpoint.json': checkpoint}, {env: epochEnv, noPrivate: true}), /complete/i);
  const result = await run(t, 'save', currentCheckpoint, null, {'checkpoint.json': checkpoint, 'private-metrics.json': envelope}, {env: epochEnv, noPrivate: true});
  const tree = result.requests.find(request => request.path === '/git/trees' && request.method === 'POST').body;
  assert.deepEqual(tree.tree.map(entry => entry.path), ['checkpoint.json']);
  assert.equal(tree.base_tree, 'existing-tree');
});

test('fresh private epoch can replace legacy scope only alongside a completed current public baseline', async t => {
  const result = await run(t, 'save-private', currentPrivate, null, {'checkpoint.json': currentCheckpoint, 'private-metrics.json': envelope}, {env: epochEnv, noPrivate: true});
  assert.equal(result.requests.filter(request => request.path === '/git/commits' && request.method === 'POST').length, 1);
  await assert.rejects(run(t, 'save-private', currentPrivate, null, {'checkpoint.json': checkpoint, 'private-metrics.json': envelope}, {env: epochEnv, noPrivate: true}), /epoch/i);
});

test('deploy collection drops derived state on reset while reusing the separate public object cache', async t => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const step = workflow.split('- name: Collect public repositories')[1].split('      - name:')[0];
  const script = step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
  const root = await mkdtemp(join(tmpdir(), 'tally-workflow-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.poly-tally'));
  await writeFile(join(root, '.poly-tally/remote-checkpoint.json'), '{}');
  for (const reset of ['true', 'false']) {
    const capture = join(root, `args-${reset}`);
    execFileSync('bash', ['-e', '-c', 'python() { printf "%s\\n" "$@" > "$CAPTURE"; }\n' + script], {
      cwd: root, env: {...process.env, RESET_REQUIRED: reset, RUNNER_TEMP: root, CAPTURE: capture},
    });
    const args = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.equal(args[args.indexOf('--cache') + 1], '.poly-tally/cache');
    assert.equal(args[args.indexOf('--state') + 1], reset === 'true' ? join(root, 'public-reset') : '.poly-tally');
    assert.equal(args.includes('--allow-partial'), reset === 'false');
    assert.equal(args.includes('--authoritative-checkpoint'), reset === 'false');
    assert.ok(args.includes('--public-only'));
  }
});

test('durable private publication rejects unproved lineage scans even if visible failures are zero', async t => {
  const candidate = {...envelope, lineageVersion:'abcdef0123456789', completeness:{complete:false, discoveryComplete:false, expectedRepositories:0, scannedRepositories:0, missingMembers:0, failed:0}};
  await assert.rejects(run(t, 'save-private', candidate, null, {'checkpoint.json': checkpoint}, {noPrivate:true}), /incomplete/i);
});

test('explicit rebuilt snapshot preserves scope and restores separately from fresh metrics', async t => {
  const proof = {complete:false,discoveryComplete:false,expectedRepositories:1,scannedRepositories:1,missingMembers:0,failed:0};
  const key = 'abcdef0123456789';
  const row = {id:`private-${key}`,sourceKey:key,name:'owner/private',visibility:'private',snapshotKind:'daily',url:null,branch:null,head:null,status:'active',lastSuccessAt:envelope.generatedAt,rulesVersion:envelope.rulesVersion,historyComplete:true,notice:'私有仓库：仅公开按日规模，不公开源码与提交详情。',skippedFiles:0,history:[{timestamp:envelope.generatedAt,metrics:{code:10,comment:0,blank:0,documentation:0,files:1},languages:{}}]};
  const rebuilt = {...currentPrivate,lineageVersion:'abcdef0123456789',completeness:proof,collection:{repositories:1,failed:0},repositories:[row]};
  const old = {...rebuilt,datasetEpoch:'old-v1',completeness:{...proof,complete:true,discoveryComplete:true}};
  const publicCheckpoint = {...currentCheckpoint,lineageVersion:rebuilt.lineageVersion};
  const saved = await run(t,'save-rebuilt-private',rebuilt,null,{'checkpoint.json':publicCheckpoint,'private-metrics.json':old},{env:epochEnv,noPrivate:true});
  const tree = saved.requests.find(request=>request.path==='/git/trees'&&request.method==='POST').body;
  assert.deepEqual(tree.tree.map(entry=>entry.path),['rebuilt-private-metrics.json']);
  const restored = await run(t,'restore',null,null,{'checkpoint.json':publicCheckpoint,'private-metrics.json':old,'rebuilt-private-metrics.json':rebuilt},{env:epochEnv});
  assert.equal(restored.outcome.privatePending,false);
  assert.deepEqual(JSON.parse(await readFile(join(restored.privateFilename,'../rebuilt-private-metrics.json'))),rebuilt);
  await assert.rejects(readFile(restored.privateFilename),{code:'ENOENT'});
  const shrunk = {...rebuilt,collection:{repositories:0,failed:0},repositories:[]};
  await assert.rejects(run(t,'save-rebuilt-private',shrunk,null,{'checkpoint.json':publicCheckpoint,'private-metrics.json':old},{env:epochEnv,noPrivate:true}), /scope|rebuilt/i);
});

test('workflow and collector share the explicit lineage rebuild epoch', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  assert.ok(workflow.includes(`POLY_TALLY_DATASET_EPOCH: ${config.datasetEpoch}`));
  assert.equal(config.lineageGroups[0].members.length, 3);
});

const externalProof = {complete:true,discoveryComplete:true,expectedRepositories:0,scannedRepositories:0,missingMembers:0,failed:0};
const externalSnapshot = {...currentPrivate,lineageVersion:'abcdef0123456789',completeness:externalProof};
async function externalSha(data) {
  const {createHash} = await import('node:crypto');
  const value = bytes(data);
  return createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
}
test('explicit external SHA restores exact new-epoch snapshot before public reset finishes', async t => {
  const sha = await externalSha(externalSnapshot);
  const result = await run(t,'restore',checkpoint,envelope,{'checkpoint.json':checkpoint,'private-metrics.json':externalSnapshot},{env:{...epochEnv,POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA:sha}});
  assert.equal(result.outcome.resetRequired,true);
  assert.equal(result.outcome.privatePending,false);
  assert.deepEqual(JSON.parse(await readFile(result.privateFilename)),externalSnapshot);
  await assert.rejects(readFile(result.filename),{code:'ENOENT'});
});

test('external restore hard-rejects wrong SHA, missing blob, old epoch and unproved inventory', async t => {
  const sha = await externalSha(externalSnapshot);
  const options = {env:{...epochEnv,POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA:sha}};
  await assert.rejects(run(t,'restore',checkpoint,envelope,{'checkpoint.json':checkpoint,'private-metrics.json':{...externalSnapshot,generatedAt:'2026-10-21T05:00:00Z'}},options), /blob|external/i);
  await assert.rejects(run(t,'restore',checkpoint,envelope,{'checkpoint.json':checkpoint},options), /missing|external/i);
  await assert.rejects(run(t,'restore',checkpoint,envelope,{}, {...options,missing:true}), /missing|external/i);
  for (const candidate of [{...externalSnapshot,datasetEpoch:'old-epoch'},envelope,{...externalSnapshot,completeness:{...externalProof,complete:false}}]) {
    await assert.rejects(run(t,'restore',checkpoint,envelope,{'private-metrics.json':candidate},{env:{...epochEnv,POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA:await externalSha(candidate)}}), /epoch|incomplete|lineage/i);
  }
});

test('external dispatch selection is scoped to restore/build, not inherited by unrelated fixture tests', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8');
  assert.doesNotMatch(workflow.split('\njobs:')[0], /POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA/);
  const restore = workflow.split('id: restore-state')[1].split('- name:')[0];
  const build = workflow.split('- name: Build dashboard')[1].split('- name:')[0];
  for (const step of [restore,build]) assert.match(step,/POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.external_private_blob_sha \|\| '' \}\}/);
});

test('save-private returns the actual durable SHA for new, unchanged and scan-only snapshots', async t => {
  const changed = {...envelope,archivedRepositoryKeys:['abcdef0123456789']};
  const newlyWritten = await run(t,'save-private',changed,null,{'private-metrics.json':envelope},{noPrivate:true});
  assert.equal(newlyWritten.outcome?.privateBlobSha,gitBlobSha(bytes(changed)));
  const identical = await run(t,'save-private',envelope,null,{'private-metrics.json':envelope},{noPrivate:true});
  assert.equal(identical.outcome?.privateBlobSha,gitBlobSha(bytes(envelope)));
  const scanOnly = {...envelope,generatedAt:'2026-10-21T05:00:00Z'};
  const retained = await run(t,'save-private',scanOnly,null,{'private-metrics.json':envelope},{noPrivate:true});
  assert.equal(retained.outcome?.privateBlobSha,gitBlobSha(bytes(envelope)));
  assert.notEqual(retained.outcome?.privateBlobSha,gitBlobSha(bytes(scanOnly)),'never attest to bytes skipped by semantic deduplication');
  assert.equal(retained.requests.filter(request => request.method !== 'GET').length,0);
});
