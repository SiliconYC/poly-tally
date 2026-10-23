// Publication boundary only: never reads collector state, objects, or source files.
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, lstat, rm, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateCompletePrivateMetrics, validateExternalPrivateMetrics} from './metrics.mjs';
import {repositoryUpdatedAt} from '../web/model.mjs';

const metrics = ['code','comment','blank','documentation','files'];
const languages = new Set(['Python','Cython','JavaScript','TypeScript','TSX','C','C++','CUDA','C#','Java','Kotlin','Swift','Go','Rust','Ruby','PHP','Vue','Svelte','HTML','CSS','SCSS','Less','Bash','PowerShell','Batchfile','SQL','R','Lua','Dart','JSON','YAML','TOML','INI','XML','Protocol Buffer','QML','CMake','Makefile','Dockerfile','Markdown','reStructuredText','Text','TeX']);
const topKeys = ['schemaVersion','generatedAt','datasetEpoch','rules','collector','lineageVersion','completeness','summary','repositories'];
const repositoryKeys = ['id','name','url','branch','status','lastSuccessAt','rulesVersion','historyComplete','notice','skippedFiles','lastCommitDate','history'];
const description = '按当前默认分支第一父链与统一规则重建；代码存量，不代表个人贡献。混合行归代码；文档独立。';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hex = (v,n) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const fullName = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(v) && !['.','..'].includes(v.split('/')[1]);
class PublicationError extends Error {}
const fail = message => { throw new PublicationError(`Invalid publication snapshot: ${message}.`); };
function exactKeys(v,keys) { if(!object(v) || Object.keys(v).length !== keys.length || !keys.every(k=>Object.hasOwn(v,k))) fail('unexpected schema'); }
function iso(v) { return typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,19)===v.slice(0,19); }
function publicTime(v) { return typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v) && Number.isFinite(Date.parse(v)) && Number.isFinite(Date.parse(v.slice(0,19)+'Z')) && new Date(v.slice(0,19)+'Z').toISOString().slice(0,19)===v.slice(0,19); }
function calendar(v) { return typeof v==='string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v; }
function validateMetrics(v) { exactKeys(v,metrics); if(!metrics.every(k=>integer(v[k]))) fail('unsafe metric'); }
function validatePoint(p) {
  exactKeys(p,['timestamp','metrics','languages']);
  if(!iso(p.timestamp)||!object(p.languages)) fail('history schema');
  validateMetrics(p.metrics);
  for(const [language,value] of Object.entries(p.languages)) { if(!languages.has(language)) fail('unknown language'); validateMetrics(value); }
}
function validateProof(p) {
  exactKeys(p,['complete','discoveryComplete','expectedRepositories','scannedRepositories','missingMembers','failed']);
  if(p.complete!==true || p.discoveryComplete!==true || !['expectedRepositories','scannedRepositories','missingMembers','failed'].every(k=>integer(p[k])) || p.expectedRepositories!==p.scannedRepositories || p.missingMembers!==0 || p.failed!==0) fail('incomplete collection');
}
const anonymousKey = id => createHash('sha256').update(`poly-tally/repository/${id}`).digest('hex').slice(0,16);
const represented = r => r.lineage?.members.map(m=>m.sourceKey) ?? [r.sourceKey ?? anonymousKey(r.id)];
function validateLineage(r,policy) {
  const g=r.lineage;
  exactKeys(g,['id','version','members','dominantMember','representativeMember']);
  const configured=policy.lineageGroups.find(item=>item.id===g.id);
  if(!configured || g.version!==policy.lineageVersion || !Array.isArray(g.members) || g.members.length!==configured.members.length) fail('lineage configuration');
  const names=new Set(), keys=new Set();
  for(const m of g.members) {
    exactKeys(m,['name','sourceKey']);
    if(!fullName(m.name)||!hex(m.sourceKey,16)||names.has(m.name.toLowerCase())||keys.has(m.sourceKey)) fail('lineage member');
    names.add(m.name.toLowerCase()); keys.add(m.sourceKey);
  }
  if(!configured.members.every(n=>names.has(n.toLowerCase())) || !g.members.some(m=>m.name===g.representativeMember) || r.name!==g.representativeMember || (g.dominantMember!==null && !g.members.some(m=>m.name===g.dominantMember))) fail('lineage membership');
  if(r.visibility!=='private' && r.id!==`lineage:${g.id}`) fail('lineage identity');
}

export async function loadSnapshotPolicy(root=resolve(import.meta.dirname,'..')) {
  const policy=JSON.parse(await readFile(resolve(root,'scripts/snapshot-policy.json'),'utf8'));
  exactKeys(policy,['datasetEpoch','rulesVersion','lineageVersion','collectorVersion','configSha256']);
  const configBytes=await readFile(resolve(root,'config.json'));
  if(createHash('sha256').update(configBytes).digest('hex')!==policy.configSha256) fail('configuration changed; review publication policy');
  const config=JSON.parse(configBytes);
  if(config.datasetEpoch!==policy.datasetEpoch || !hex(policy.rulesVersion,16) || !hex(policy.lineageVersion,16) || policy.collectorVersion!=='poly-tally/4;pygments/2.21.0') fail('policy mismatch');
  return {...policy,lineageGroups:config.lineageGroups};
}

export function validatePublicSnapshot(data,policy) {
  exactKeys(data,topKeys);
  exactKeys(data.rules,['version','description']); exactKeys(data.collector,['version']);
  if(data.schemaVersion!==1 || !iso(data.generatedAt) || data.datasetEpoch!==policy.datasetEpoch || data.rules.version!==policy.rulesVersion || data.rules.description!==description || data.lineageVersion!==policy.lineageVersion || data.collector.version!==policy.collectorVersion || !Array.isArray(data.repositories)) fail('epoch, rules, lineage or collector mismatch');
  validateProof(data.completeness);
  const ids=new Set(), names=new Set();
  for(const r of data.repositories) {
    if(!object(r)) fail('repository must be an object');
    exactKeys(r,[...repositoryKeys,...('lineage' in r?['lineage']:[])]);
    if(typeof r.id!=='string'||(!/^[1-9]\d*$/.test(r.id)&&!r.id.startsWith('lineage:'))||!fullName(r.name)||ids.has(r.id)||names.has(r.name.toLowerCase())||r.url!==`https://github.com/${r.name}`||!(r.branch===null||(typeof r.branch==='string'&&r.branch.length>0&&r.branch.length<=255&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(r.branch)))||!['active','empty'].includes(r.status)||!iso(r.lastSuccessAt)||Date.parse(r.lastSuccessAt)>Date.parse(data.generatedAt)||r.rulesVersion!==policy.rulesVersion||r.historyComplete!==true||r.notice!==(r.status==='empty'?'等待首个提交':'')||!integer(r.skippedFiles)||!(r.lastCommitDate===null||calendar(r.lastCommitDate)||publicTime(r.lastCommitDate))||!Array.isArray(r.history)||(r.status==='active'&&!r.history.length)||(r.status==='empty'&&r.history.length)) fail('repository schema or incomplete history');
    ids.add(r.id);names.add(r.name.toLowerCase());
    if('lineage' in r) validateLineage(r,policy);
    else if(r.id.startsWith('lineage:')) fail('missing lineage');
    let previous=-Infinity;
    for(const p of r.history) {validatePoint(p); const time=Date.parse(p.timestamp);if(time<previous) fail('unordered history'); previous=time;}
  }
  exactKeys(data.summary,[...metrics,'repositories','publicRepositories','privateRepositories','commits','snapshots']);
  if(!Object.values(data.summary).every(integer)) fail('unsafe summary');
  const active=data.repositories.filter(r=>r.status==='active'), expected=Object.fromEntries(metrics.map(k=>[k,active.reduce((sum,r)=>sum+r.history.at(-1).metrics[k],0)]));
  const snapshots=active.reduce((sum,r)=>sum+r.history.length,0);
  Object.assign(expected,{repositories:active.length,publicRepositories:active.length,privateRepositories:0,commits:snapshots,snapshots});
  if(!Object.entries(expected).every(([k,v])=>integer(v)&&data.summary[k]===v)) fail('summary mismatch');
  return true;
}

// Run locally on the ORIGINAL public exporter result, before uploading anything.
// Detailed run records are discarded, never interpreted or printed.
export function projectPublicStats(raw,policy) {
  exactKeys(raw,[...topKeys,'runs','publication']);
  if(!Array.isArray(raw.runs)||!object(raw.publication)||!Array.isArray(raw.repositories)) fail('public exporter schema');
  const data=Object.fromEntries(topKeys.map(k=>[k,structuredClone(raw[k])]));
  data.repositories=raw.repositories.map(r=>{
    if(!object(r)||!Array.isArray(r.history)) fail('public exporter repository');
    exactKeys(r,[...repositoryKeys.filter(k=>k!=='lastCommitDate'),'head',...('lastCommitDate' in r?['lastCommitDate']:[]),...('lineage' in r?['lineage']:[])]);
    if(!(r.head===null||hex(r.head,40))||!(r.url===null||r.url===`https://github.com/${r.name}`)) fail('public exporter identity');
    const history=r.history.map(p=>{
      if(!object(p)) fail('public exporter history');
      const metadata=['sha','committedAt','authoredAt'].filter(k=>k in p);
      exactKeys(p,['timestamp','metrics','languages',...metadata]);
      if('sha' in p && !hex(p.sha,40)) fail('public exporter commit');
      for(const k of ['committedAt','authoredAt']) if(k in p && !publicTime(p[k])) fail('public exporter time');
      return structuredClone({timestamp:p.timestamp,metrics:p.metrics,languages:p.languages});
    });
    const lastCommitDate=repositoryUpdatedAt(r);
    return {...Object.fromEntries(repositoryKeys.filter(k=>!['history','lastCommitDate','url'].includes(k)).map(k=>[k,structuredClone(r[k])])),url:`https://github.com/${r.name}`,lastCommitDate,history,...('lineage' in r?{lineage:structuredClone(r.lineage)}:{})};
  });
  validatePublicSnapshot(data,policy);
  return data;
}

export function validateSnapshotPair(publicData,privateData,policy) {
  validatePublicSnapshot(publicData,policy);
  // The original validator predates this untrusted boundary; never expose its
  // unexpected TypeError text (which can include a malformed input primitive).
  try {validateCompletePrivateMetrics(privateData);} catch {fail('invalid sanitized private metrics');}
  validateProof(privateData.completeness);
  if(privateData.datasetEpoch!==policy.datasetEpoch||privateData.rulesVersion!==policy.rulesVersion||privateData.lineageVersion!==policy.lineageVersion||!privateData.repositories.length) fail('private epoch, rules or lineage mismatch');
  for(const r of privateData.repositories) if(!iso(r.lastSuccessAt)||Date.parse(r.lastSuccessAt)>Date.parse(privateData.generatedAt)||(r.status==='active'&&!r.history.length)||(r.status==='empty'&&r.history.length)) fail('incomplete private history');
  const all=[...publicData.repositories,...privateData.repositories], keys=new Set(), names=new Set(), groups=new Set();
  for(const r of all) {
    if(r.lineage) {validateLineage(r,policy);if(groups.has(r.lineage.id)) fail('duplicate lineage');groups.add(r.lineage.id);}
    for(const name of r.lineage?.members.map(m=>m.name)??[r.name]) {if(names.has(name.toLowerCase())) fail('duplicate represented name');names.add(name.toLowerCase());}
    for(const key of represented(r)) {if(keys.has(key)||privateData.archivedRepositoryKeys?.includes(key)) fail('duplicate or archived represented source');keys.add(key);}
  }
  if(!policy.lineageGroups.every(g=>groups.has(g.id))) fail('missing configured lineage');
  const publicCount=publicData.repositories.reduce((n,r)=>n+represented(r).length,0), privateCount=keys.size-publicCount;
  const publicProof=publicData.completeness.scannedRepositories, privateProof=privateData.completeness.scannedRepositories;
  // Original full-scope export attaches the complete joint run to private metrics.
  // Original separate public/private runs instead carry their own source counts.
  const maxPublicGroupOverlap=privateData.repositories.filter(r=>r.lineage).reduce((n,r)=>n+r.lineage.members.length-1,0);
  const publicScopeValid=publicProof>=publicCount && publicProof<=publicCount+maxPublicGroupOverlap;
  const fullRun=privateProof===keys.size && publicScopeValid;
  const separateRuns=privateProof===privateCount && publicScopeValid;
  if(!fullRun&&!separateRuns) fail('missing source repositories');
  return true;
}

export function verifyBlob(bytes,sha) {
  if(!Buffer.isBuffer(bytes)||!hex(sha,40)||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==sha) throw new PublicationError('Snapshot blob SHA mismatch.');
}
export async function stageSnapshot({root,policy,publicBytes,privateBytes,publicBlobSha,privateBlobSha,currentPrivateBlobSha}) {
  verifyBlob(publicBytes,publicBlobSha);verifyBlob(privateBytes,privateBlobSha);
  if(currentPrivateBlobSha!==privateBlobSha) throw new PublicationError('Selected private snapshot is not the current durable private blob.');
  let publicData,privateData;
  try {publicData=JSON.parse(publicBytes);privateData=JSON.parse(privateBytes);} catch {fail('invalid JSON');}
  validateSnapshotPair(publicData,privateData,policy);
  validateExternalPrivateMetrics(privateBytes,publicData,privateBlobSha);
  const directory=resolve(root,'web/data');
  await rm(directory,{recursive:true,force:true});await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'stats.json'),JSON.stringify(publicData));
  // Preserve these exact bytes: build-site verifies the selected private blob again.
  await writeFile(join(directory,'private-metrics.json'),privateBytes);
}

function githubClient({env=process.env,fetcher=fetch}={}) {
  if(!fullName(env.GITHUB_REPOSITORY)||!env.GH_TOKEN) fail('repository or Actions token missing');
  return async path=>{
    const response=await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${env.GH_TOKEN}`}});
    if(!response.ok) throw new PublicationError(`Snapshot metadata request failed: HTTP ${response.status}.`);
    return response.json();
  };
}
async function currentPrivateSha(api) {
  const ref=await api('/git/ref/heads/tally-state');
  if(!hex(ref?.object?.sha,40)) fail('durable reference');
  const commit=await api(`/git/commits/${ref.object.sha}`);
  if(!hex(commit?.tree?.sha,40)) fail('durable tree');
  const tree=await api(`/git/trees/${commit.tree.sha}`);
  if(tree.truncated||!Array.isArray(tree.tree)) fail('durable tree');
  const entry=tree.tree.find(e=>e.path==='private-metrics.json'&&e.type==='blob'&&e.mode==='100644');
  if(!entry||!hex(entry.sha,40)) fail('missing durable private metrics');
  return entry.sha;
}
export async function checkCurrentPrivate({env=process.env,fetcher=fetch}={}) {
  if(!hex(env.PRIVATE_METRICS_BLOB_SHA,40)) fail('private blob selection');
  if(await currentPrivateSha(githubClient({env,fetcher}))!==env.PRIVATE_METRICS_BLOB_SHA) throw new PublicationError('Selected private snapshot is not the current durable private blob.');
}
export async function downloadAndStage({root=resolve(import.meta.dirname,'..'),env=process.env,fetcher=fetch}={}) {
  const {SNAPSHOT_COMMIT:commitSha,PUBLIC_STATS_BLOB_SHA:publicBlobSha,PRIVATE_METRICS_BLOB_SHA:privateBlobSha}=env;
  if(![commitSha,publicBlobSha,privateBlobSha].every(v=>hex(v,40))) fail('immutable snapshot selection');
  const policy=await loadSnapshotPolicy(root),api=githubClient({env,fetcher});
  const commit=await api(`/git/commits/${commitSha}`);
  if(commit.sha!==commitSha||!hex(commit?.tree?.sha,40)) fail('snapshot commit');
  const tree=await api(`/git/trees/${commit.tree.sha}`);
  if(tree.truncated||!Array.isArray(tree.tree)) fail('snapshot tree');
  for(const [path,sha] of [['public-stats.json',publicBlobSha],['private-metrics.json',privateBlobSha]]) if(!tree.tree.some(e=>e.path===path&&e.sha===sha&&e.type==='blob'&&e.mode==='100644')) fail('selected commit does not bind both snapshots');
  const readBlob=async sha=>{
    const blob=await api(`/git/blobs/${sha}`);
    if(blob.sha!==sha||blob.encoding!=='base64'||!integer(blob.size)||blob.size>32*1024*1024||typeof blob.content!=='string') fail('snapshot blob response');
    const bytes=Buffer.from(blob.content,'base64');if(bytes.length!==blob.size) fail('snapshot blob length');verifyBlob(bytes,sha);return bytes;
  };
  const [publicBytes,privateBytes]=await Promise.all([readBlob(publicBlobSha),readBlob(privateBlobSha)]);
  await stageSnapshot({root,policy,publicBytes,privateBytes,publicBlobSha,privateBlobSha,currentPrivateBlobSha:await currentPrivateSha(api)});
}

export async function verifySite({root=resolve(import.meta.dirname,'..')}={}) {
  const site=resolve(root,'site');
  async function walk(directory,prefix='') {
    const files=[];
    for(const name of await readdir(directory)) {
      const relative=prefix+name, path=join(directory,name), stat=await lstat(path);
      if(stat.isSymbolicLink()) fail('site artifact symlink');
      if(stat.isDirectory()) {if(!['assets','data'].includes(relative)) fail('unexpected site artifact directory');files.push(...await walk(path,relative+'/'));}
      else if(stat.isFile()&&(/^(?:index\.html|favicon\.svg|\.nojekyll|data\/stats\.json)$/.test(relative)||/^assets\/(?:[A-Za-z0-9_-]+\.(?:js|css|woff2?)|favicon-[A-Za-z0-9_-]+\.svg)$/.test(relative))) files.push(relative);
      else fail('unexpected site artifact');
    }
    return files;
  }
  const files=await walk(site);
  if(!['index.html','data/stats.json','favicon.svg','.nojekyll'].every(f=>files.includes(f))) fail('incomplete site artifact');
  const data=JSON.parse(await readFile(join(site,'data/stats.json'),'utf8'));
  if(data.completeness?.complete!==true||data.publication?.privateAttemptStatus!=='external-verified'||!hex(data.publication?.privateSnapshotBlobSha,40)) fail('unverified site publication');
  if(!Array.isArray(data.repositories)) fail('site repository schema');
  for(const r of data.repositories) {
    if(!object(r)||!Array.isArray(r.history)||r.history.some(p=>!object(p))) fail('site history schema');
    if('inventory' in r||('head' in r && r.head!==null)||r.history.some(p=>['sha','committedAt','authoredAt'].some(k=>k in p))) fail('raw fields in site artifact');
  }
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [command,input,output,...extra]=process.argv.slice(2);
    if(extra.length) fail('unexpected arguments');
    if(command==='project'&&input&&output) {const data=projectPublicStats(JSON.parse(await readFile(input,'utf8')),await loadSnapshotPolicy());await writeFile(output,JSON.stringify(data));}
    else if(command==='stage'&&!input&&!output) await downloadAndStage();
    else if(command==='check-current'&&!input&&!output) await checkCurrentPrivate();
    else if(command==='verify-site'&&!input&&!output) await verifySite();
    else fail('usage: project INPUT OUTPUT | stage | check-current | verify-site');
    console.log('Selected sanitized snapshot publication check passed.');
  } catch(error) {console.error(error instanceof PublicationError?error.message:'Snapshot publication failed; invalid input or unavailable resource.');process.exitCode=1;}
}
