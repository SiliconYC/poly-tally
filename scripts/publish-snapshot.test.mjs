import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import * as snapshot from './publish-snapshot.mjs';
import {buildSite} from './build-site.mjs';
import {applyDisplayWindow, latestTotals, selectRepositories, stockChange, rankRepositoriesByHistoricalArea, languageTotals, repositoryUpdatedAt, sortRepositories} from '../web/model.mjs';
import {mergePrivateMetrics} from './metrics.mjs';

const root = resolve(import.meta.dirname, '..');
const policy = {datasetEpoch:'test-v1', rulesVersion:'0123456789abcdef', lineageVersion:'fedcba9876543210', collectorVersion:'poly-tally/4;pygments/2.21.0', lineageGroups:[]};
const generatedAt = '2026-10-23T02:00:00Z';
const hash = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const sourceKey = id => createHash('sha256').update(`poly-tally/repository/${id}`).digest('hex').slice(0,16);
const metrics = code => ({code, comment:2, blank:3, documentation:4, files:1});
const point = (timestamp, code) => ({timestamp, metrics:metrics(code), languages:{Python:metrics(code)}});
const proof = n => ({complete:true, discoveryComplete:true, expectedRepositories:n, scannedRepositories:n, missingMembers:0, failed:0});
function fixtures() {
  const publicData = {schemaVersion:1, generatedAt, datasetEpoch:policy.datasetEpoch, rules:{version:policy.rulesVersion, description:'按当前默认分支第一父链与统一规则重建；代码存量，不代表个人贡献。混合行归代码；文档独立。'}, collector:{version:policy.collectorVersion}, lineageVersion:policy.lineageVersion, completeness:proof(1), summary:{...metrics(30), repositories:1, publicRepositories:1, privateRepositories:0, commits:3, snapshots:3}, repositories:[{id:'123',name:'owner/public', url:'https://github.com/owner/public',branch:'main',head:'a'.repeat(40), status:'active',lastSuccessAt:generatedAt,rulesVersion:policy.rulesVersion,historyComplete:true,notice:'',skippedFiles:0,history:[point('2026-09-01T00:00:00Z',10),point('2026-10-01T00:00:00Z',40),point('2026-10-22T00:00:00Z',30)].map((p,i)=>({...p,sha:String(i).repeat(40),committedAt:p.timestamp,authoredAt:p.timestamp}))}],runs:[],publication:{privateRepositories:0,privateUpdatedAt:null,privateSource:null,privateStatus:'not-configured'}};
  const key = sourceKey('456');
  const privateData = {schemaVersion:1, generatedAt,datasetEpoch:policy.datasetEpoch,rulesVersion:policy.rulesVersion,lineageVersion:policy.lineageVersion,completeness:proof(1),source:'local',collection:{repositories:1,failed:0},archivedRepositoryKeys:[],repositories:[{id:`private-${key}`,name:'owner/private',sourceKey:key,visibility:'private',snapshotKind:'daily',url:null,branch:null,head:null,status:'active',lastSuccessAt:generatedAt,rulesVersion:policy.rulesVersion,historyComplete:true,notice:'私有仓库：仅公开按日规模，不公开源码与提交详情。',skippedFiles:0,lastCommitDate:'2026-10-23',history:[point('2026-09-01T23:59:59.999999Z',7),point('2026-10-01T23:59:59.999999Z',11),point(generatedAt,13)]}]};
  return {publicData, privateData};
}
function selected() { const f=fixtures(); return {...f, publicData:snapshot.projectPublicStats(f.publicData,policy)}; }
function assertEquivalent(before, after) {
  for (const display of [undefined,{historyStart:'2026-09-15T00:00:00Z'}]) {
    const a=selectRepositories(applyDisplayWindow(before,display)), b=selectRepositories(applyDisplayWindow(after,display));
    for (const language of ['all','Python']) {
      assert.deepEqual(latestTotals(a,language),latestTotals(b,language));
      for (const metric of ['total','code','comment','blank','documentation','files']) {
        assert.deepEqual(rankRepositoriesByHistoricalArea(a,{language,metric,until:generatedAt}).map(r=>r.id),rankRepositoriesByHistoricalArea(b,{language,metric,until:generatedAt}).map(r=>r.id));
        for (const since of ['2026-10-22T02:00:00Z','2026-10-16T02:00:00Z','2026-09-23T02:00:00Z']) assert.deepEqual(stockChange(a,{since,until:generatedAt,metric,language}),stockChange(b,{since,until:generatedAt,metric,language}));
      }
    }
    assert.deepEqual(languageTotals(a),languageTotals(b));
  }
}

test('projection removes raw metadata without altering any original timestamp, metric or model result', () => {
  assert.equal(typeof snapshot.projectPublicStats,'function');
  const {publicData,privateData}=fixtures(), original=structuredClone(publicData);
  const projected=snapshot.projectPublicStats(publicData,policy);
  assert.deepEqual(publicData,original);
  assert.equal(projected.repositories[0].lastCommitDate,repositoryUpdatedAt(original.repositories[0]));
  assert.deepEqual(projected.repositories[0].history,original.repositories[0].history.map(({timestamp,metrics,languages})=>({timestamp,metrics,languages})));
  for(const field of ['runs','publication','inventory','head','sha','committedAt','authoredAt']) assert.ok(!JSON.stringify(projected).includes(`"${field}":`),field);
  assertEquivalent(mergePrivateMetrics(original,privateData,{privateStatus:'available'}),mergePrivateMetrics(projected,privateData,{privateStatus:'available'}));
  assert.equal(snapshot.validateSnapshotPair(projected,privateData,policy),true);
});

test('strict public schema rejects raw/unknown fields, nested text, invalid metrics, identities, and incomplete facts', () => {
  for(const mutate of [
    d=>d.rawSource='secret', d=>d.runs=[],d=>d.repositories[0].head='a'.repeat(40),d=>d.repositories[0].inventory={},d=>d.repositories[0].history[0].sha='a'.repeat(40),
    d=>d.repositories[0].history[0].metrics.rawPath='secret',d=>d.repositories[0].history[0].metrics.code=-1,d=>d.repositories[0].history[0].metrics.code=1.5,d=>d.repositories[0].history[0].metrics.code=Number.MAX_SAFE_INTEGER+1,
    d=>d.repositories[0].history[0].languages.secret=metrics(1),d=>d.rules.description='secret',d=>d.repositories[0].notice='secret',d=>d.repositories[0].name='owner/../secret',d=>d.repositories[0].url='https://evil.invalid/',
    d=>d.completeness.complete=false,d=>d.completeness.failed=1,d=>d.completeness.discoveryComplete=false,d=>d.completeness.missingMembers=1,d=>d.repositories=[],d=>d.repositories[0].historyComplete=false,d=>d.repositories[0].status='stale',
    d=>d.datasetEpoch='old',d=>d.rules.version='f'.repeat(16),d=>d.lineageVersion='f'.repeat(16),d=>d.collector.version='other',d=>d.summary.code++
  ]) {const {publicData}=selected();mutate(publicData);assert.throws(()=>snapshot.validatePublicSnapshot(publicData,policy),/snapshot|publication/i);}
});

test('private pair rejects unknown fields, old epoch/rules/lineage, missing scope and failed collection',()=>{
  for(const mutate of [d=>d.rawSource='secret',d=>d.repositories[0].history[0].sha='a'.repeat(40),d=>d.repositories[0].head='a'.repeat(40),d=>d.completeness.complete=false,d=>d.completeness.expectedRepositories++,d=>d.repositories=[],d=>d.collection.failed=1,d=>d.datasetEpoch='old',d=>d.rulesVersion='f'.repeat(16),d=>d.lineageVersion='f'.repeat(16)]) {const {publicData,privateData}=selected();mutate(privateData);assert.throws(()=>snapshot.validateSnapshotPair(publicData,privateData,policy));}
});

test('configured lineage must be present exactly once with every configured member',()=>{
  const {publicData,privateData}=selected();
  const expected={...policy,lineageGroups:[{id:'group',members:['owner/private','owner/missing']}]};
  assert.throws(()=>snapshot.validateSnapshotPair(publicData,privateData,expected),/lineage|snapshot/i);
});

test('stage verifies immutable hashes and current durable private selection before replacing data; clears fallbacks',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'tally-snapshot-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(join(workspace,'web/data'),{recursive:true});
  await writeFile(join(workspace,'web/data/stats.json'),'previous');
  for(const name of ['retained-private-baseline.json','rebuilt-private-metrics.json','unselected.json']) await writeFile(join(workspace,'web/data',name),'old');
  const {publicData,privateData}=selected(), publicBytes=Buffer.from(JSON.stringify(publicData)), privateBytes=Buffer.from(JSON.stringify(privateData));
  const options={root:workspace,policy,publicBytes,privateBytes,publicBlobSha:hash(publicBytes),privateBlobSha:hash(privateBytes),currentPrivateBlobSha:hash(privateBytes)};
  await assert.rejects(snapshot.stageSnapshot({...options,publicBlobSha:'0'.repeat(40)}),/SHA/);
  await assert.rejects(snapshot.stageSnapshot({...options,privateBlobSha:'0'.repeat(40)}),/SHA/);
  await assert.rejects(snapshot.stageSnapshot({...options,currentPrivateBlobSha:'0'.repeat(40)}),/current|durable/);
  assert.equal(await readFile(join(workspace,'web/data/stats.json'),'utf8'),'previous');
  await snapshot.stageSnapshot(options);
  assert.deepEqual((await readdir(join(workspace,'web/data'))).sort(),['private-metrics.json','stats.json']);
  assert.deepEqual(await readFile(join(workspace,'web/data/private-metrics.json')),privateBytes);
  await writeFile(join(workspace,'web/favicon.svg'),'<svg/>');
  const result=await buildSite({root:workspace,requirePrivate:true,externalPrivateBlobSha:options.privateBlobSha,logger:{log(){}},bundle:async({site})=>{await mkdir(site,{recursive:true});await writeFile(join(site,'index.html'),'<html/>');}});
  assert.equal(result.publication.privateAttemptStatus,'external-verified');
  assert.equal(result.completeness.complete,true);
  assert.deepEqual(await readdir(join(workspace,'site/data')),['stats.json']);
  await snapshot.verifySite({root:workspace});
  await writeFile(join(workspace,'site/data/private.sqlite'),'secret');
  await assert.rejects(snapshot.verifySite({root:workspace}),/artifact|site/i);
});

test('manual workflow only builds selected sanitized snapshots, sharing a queued non-canceling Pages group',async()=>{
  const manual=await readFile(join(root,'.github/workflows/publish-snapshot.yml'),'utf8'), pages=await readFile(join(root,'.github/workflows/pages.yml'),'utf8');
  assert.match(manual,/workflow_dispatch:/);assert.doesNotMatch(manual,/^  (push|schedule|pull_request):/m);
  for(const text of [manual,pages]) {assert.match(text,/group: poly-tally-publish/);assert.match(text,/cancel-in-progress: false/);assert.match(text,/queue: max/);}
  assert.doesNotMatch(pages,/^  schedule:|cron:/m); // Owner paused automatic collection; do not restore it here.
  assert.doesNotMatch(manual,/poly_tally collect|actions\/cache|state\.mjs|upload-artifact|persist:|setup-python|secrets\./);
  assert.match(manual,/runs-on: ubuntu-latest/);assert.match(manual,/POLY_TALLY_REQUIRE_PRIVATE: 'true'/);assert.match(manual,/POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA:/);
  assert.match(manual,/retention-days: 1/);assert.match(manual,/node scripts\/build-site.mjs/);assert.match(manual,/actions\/upload-pages-artifact@v4/);assert.match(manual,/actions\/deploy-pages@v4/);
});

test('private active rows cannot silently lose their history or scan timestamp',()=>{
  for(const mutate of [d=>d.repositories[0].history=[],d=>d.repositories[0].lastSuccessAt=null,d=>d.repositories[0].lastSuccessAt='2026-10-24T00:00:00Z']) {
    const {publicData,privateData}=selected();mutate(privateData);
    assert.throws(()=>snapshot.validateSnapshotPair(publicData,privateData,policy));
  }
});

test('full-scope and mixed-lineage proofs count represented sources, not folded display rows',()=>{
  const {publicData,privateData}=selected();privateData.completeness=proof(2);
  assert.equal(snapshot.validateSnapshotPair(publicData,privateData,policy),true);
  const group={id:'mixed',members:['owner/private','owner/public-member','owner/archived-member']};
  const r=privateData.repositories[0], key=sourceKey('lineage:mixed');
  r.id=`private-${key}`;r.sourceKey=key;r.lineage={id:'mixed',version:policy.lineageVersion,members:group.members.map((name,i)=>({name,sourceKey:sourceKey(`member-${i}`)})),dominantMember:'owner/private',representativeMember:'owner/private'};
  privateData.completeness=proof(4);publicData.completeness=proof(2);
  const expected={...policy,lineageGroups:[group]};
  assert.equal(snapshot.validateSnapshotPair(publicData,privateData,expected),true);
  privateData.completeness=proof(3); // Private-only also scans the public group member.
  assert.equal(snapshot.validateSnapshotPair(publicData,privateData,expected),true);
  for(const mutate of [p=>p.repositories[0].lineage.members.pop(),p=>p.completeness=proof(5),p=>p.repositories[0].lineage.members[1].name='owner/unknown']) {const wrong=structuredClone(privateData);mutate(wrong);assert.throws(()=>snapshot.validateSnapshotPair(publicData,wrong,expected));}
});

async function remoteFixture(t) {
  const workspace=await mkdtemp(join(tmpdir(),'tally-remote-snapshot-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(join(workspace,'scripts'));await mkdir(join(workspace,'web/data'),{recursive:true});
  const config=JSON.stringify({datasetEpoch:policy.datasetEpoch,lineageGroups:[]});
  await writeFile(join(workspace,'config.json'),config);
  const {lineageGroups,...fixed}=policy;
  await writeFile(join(workspace,'scripts/snapshot-policy.json'),JSON.stringify({...fixed,configSha256:createHash('sha256').update(config).digest('hex')}));
  await writeFile(join(workspace,'web/data/stats.json'),'untouched');
  const {publicData,privateData}=selected(), a=Buffer.from(JSON.stringify(publicData)),b=Buffer.from(JSON.stringify(privateData));
  const env={GITHUB_REPOSITORY:'owner/repository',GH_TOKEN:'test-token',SNAPSHOT_COMMIT:'a'.repeat(40),PUBLIC_STATS_BLOB_SHA:hash(a),PRIVATE_METRICS_BLOB_SHA:hash(b)};
  const tree=entries=>({truncated:false,tree:entries.map(([path,sha])=>({path,sha,type:'blob',mode:'100644'}))});
  const routes={
    [`/git/commits/${env.SNAPSHOT_COMMIT}`]:{sha:env.SNAPSHOT_COMMIT,tree:{sha:'b'.repeat(40)}},
    [`/git/trees/${'b'.repeat(40)}`]:tree([['public-stats.json',hash(a)],['private-metrics.json',hash(b)]]),
    [`/git/blobs/${hash(a)}`]:{sha:hash(a),encoding:'base64',size:a.length,content:a.toString('base64')},
    [`/git/blobs/${hash(b)}`]:{sha:hash(b),encoding:'base64',size:b.length,content:b.toString('base64')},
    '/git/ref/heads/tally-state':{object:{sha:'c'.repeat(40)}},
    [`/git/commits/${'c'.repeat(40)}`]:{tree:{sha:'d'.repeat(40)}},
    [`/git/trees/${'d'.repeat(40)}`]:tree([['private-metrics.json',hash(b)]])
  };
  const calls=[];
  const fetcher=async(url,options)=>{const path=url.replace('https://api.github.com/repos/owner/repository','');calls.push(path);assert.equal(options.method,undefined,'read-only GET');assert.equal(options.headers.Authorization,'Bearer test-token');assert.ok(Object.hasOwn(routes,path),`unexpected request ${path}`);return {ok:true,status:200,json:async()=>structuredClone(routes[path])};};
  return {root:workspace,env,fetcher,routes,calls};
}

test('download selects only the two commit-bound blobs and checks current durable state without fetching checkpoint',async t=>{
  const f=await remoteFixture(t);await snapshot.downloadAndStage(f);
  assert.equal(JSON.parse(await readFile(join(f.root,'web/data/stats.json'))).repositories.length,1);
  assert.equal(f.calls.filter(p=>p.startsWith('/git/blobs/')).length,2);
  assert.ok(f.calls.every(p=>!p.includes('checkpoint')));
  await snapshot.checkCurrentPrivate(f);
  f.routes[`/git/trees/${'d'.repeat(40)}`].tree[0].sha='0'.repeat(40);
  await assert.rejects(snapshot.checkCurrentPrivate(f),/current durable/);
});

test('download rejects unbound commits, changed bytes, superseded durable state and modified policy before staging',async t=>{
  for(const mutate of [
    f=>f.env.PUBLIC_STATS_BLOB_SHA='../raw',
    f=>f.routes[`/git/trees/${'b'.repeat(40)}`].tree[0].sha='0'.repeat(40),
    f=>f.routes[`/git/trees/${'b'.repeat(40)}`].truncated=true,
    f=>f.routes[`/git/blobs/${f.env.PUBLIC_STATS_BLOB_SHA}`].content=Buffer.from('secret').toString('base64'),
    f=>f.routes[`/git/trees/${'d'.repeat(40)}`].tree[0].sha='0'.repeat(40),
    async f=>writeFile(join(f.root,'config.json'),'{}')
  ]) {const f=await remoteFixture(t);await mutate(f);await assert.rejects(snapshot.downloadAndStage(f));assert.equal(await readFile(join(f.root,'web/data/stats.json'),'utf8'),'untouched');}
});


test('selected sanitized inputs build the unchanged production React site and publish only one safe JSON',async t=>{
  const f=await remoteFixture(t);
  await cp(join(root,'web'),join(f.root,'web'),{recursive:true});
  await cp(join(root,'vite.config.ts'),join(f.root,'vite.config.ts'));
  await writeFile(join(f.root,'package.json'),'{"type":"module"}');
  await symlink(join(root,'node_modules'),join(f.root,'node_modules'),'dir');
  await snapshot.downloadAndStage(f);
  await buildSite({root:f.root,requirePrivate:true,externalPrivateBlobSha:f.env.PRIVATE_METRICS_BLOB_SHA,logger:{log(){}}});
  assert.equal(await snapshot.verifySite({root:f.root}),true);
  assert.deepEqual((await readdir(join(f.root,'site'))).sort(),['.nojekyll','assets','data','favicon.svg','index.html']);
  assert.deepEqual(await readdir(join(f.root,'site/data')),['stats.json']);
  const data=JSON.parse(await readFile(join(f.root,'site/data/stats.json')));
  assert.deepEqual(latestTotals(selectRepositories(data)),latestTotals(selectRepositories(mergePrivateMetrics(fixtures().publicData,fixtures().privateData,{privateStatus:'available'}))));
});


test('public same-day update precision and original updated ordering survive projection',()=>{
  const {publicData}=fixtures();
  const first=publicData.repositories[0];first.name='owner/z-earlier';first.url=`https://github.com/${first.name}`;
  first.history.at(-1).committedAt='2026-10-22T09:00:00+08:00';
  const second=structuredClone(first);second.id='124';second.name='owner/a-later';second.url=`https://github.com/${second.name}`;second.history.at(-1).committedAt='2026-10-22T02:00:00Z';
  publicData.repositories.push(second);publicData.completeness=proof(2);
  for(const key of Object.keys(publicData.summary)) publicData.summary[key]*=2;
  const projected=snapshot.projectPublicStats(publicData,policy);
  assert.deepEqual(projected.repositories.map(repositoryUpdatedAt),publicData.repositories.map(repositoryUpdatedAt));
  for(const direction of ['asc','desc']) assert.deepEqual(sortRepositories(projected.repositories,{key:'updated',direction}).map(r=>r.id),sortRepositories(publicData.repositories,{key:'updated',direction}).map(r=>r.id));
});

test('malformed primitive public/private payloads never escape with input text in errors',()=>{
  const marker='SYNTHETIC_PRIVATE_CONTENT';
  for(const target of ['public','private']) for(const mutate of [d=>marker,d=>null,d=>({...d,repositories:[marker]}),d=>({...d,repositories:[null]}),d=>{d.repositories[0].history=[marker];return d;},d=>{d.repositories[0].history=[null];return d;},d=>{d.repositories[0].lineage=marker;return d;}]) {
    const {publicData,privateData}=selected();
    assert.throws(()=>snapshot.validateSnapshotPair(target==='public'?mutate(publicData):publicData,target==='private'?mutate(privateData):privateData,policy),error=>{assert.ok(!error.message.includes(marker),error.message);return true;});
  }
  for(const mutate of [d=>({...d,repositories:[marker]}),d=>({...d,repositories:[null]}),d=>{d.repositories[0].history=[marker];return d;},d=>{d.repositories[0].history=[null];return d;}]) assert.throws(()=>snapshot.projectPublicStats(mutate(fixtures().publicData),policy),error=>{assert.ok(!error.message.includes(marker),error.message);return true;});
});


test('CLI never prints unexpected error input or path contents',()=>{
  const marker='SYNTHETIC_PRIVATE_CONTENT';
  const result=spawnSync(process.execPath,[join(root,'scripts/publish-snapshot.mjs'),'project',`/tmp/${marker}/missing.json`,'/tmp/not-written.json'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.ok(!result.stderr.includes(marker));
  assert.match(result.stderr,/Snapshot publication failed/);
});
