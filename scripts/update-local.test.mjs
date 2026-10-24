import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateLocal} from './update-local.mjs';

test('failed collection never persists or dispatches a publication', async () => {
  await assert.rejects(updateLocal({env: {GH_TOKEN: 'fixture'}, collect: () => ({status: 1}), persist: () => {throw new Error('must not publish');}}), /collection failed/i);
});

test('publication selects the actual durable sanitized blob and reuses a stable local state', async t => {
  let invocation, dispatched;
  const sha = 'a'.repeat(40);
  const root = await mkdtemp(join(tmpdir(), 'tally-update-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'config.json'), JSON.stringify({datasetEpoch: 'new-epoch'}));
  const result = await updateLocal({
    root, env: {GH_TOKEN: 'fixture', POLY_TALLY_TOKEN: 'source-read-only'},
    collect: (python, args, options) => {invocation = {python, args, options}; return {status: 0};},
    persist: async (command, filename, extra, options) => {
      assert.equal(command, 'save-private');
      assert.equal(filename, join(root, '.poly-tally/local/private-metrics.json'));
      assert.equal(extra, undefined);
      assert.equal(options.env.GITHUB_REPOSITORY, 'SiliconYC/poly-tally');
      assert.equal(options.env.POLY_TALLY_DATASET_EPOCH, 'new-epoch');
      return {privateBlobSha: sha};
    },
    fetcher: async (url, options) => {dispatched = {url, options}; return {ok: true};},
  });
  assert.equal(invocation.python, join(root, '.venv/bin/python'));
  assert.equal(invocation.args[invocation.args.indexOf('--state') + 1], join(root, '.poly-tally/local'));
  assert.equal(invocation.options.env.POLY_TALLY_TOKEN, 'source-read-only');
  assert.deepEqual(JSON.parse(dispatched.options.body), {ref: 'dev', inputs: {external_private_blob_sha: sha}});
  assert.equal(result.privateBlobSha, sha);
});

test('explicit gateway mode never consults a GitHub credential and publishes only snapshot exports',async t=>{
 const root=await mkdtemp(join(tmpdir(),'tally-gateway-update-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'config.json'),JSON.stringify({datasetEpoch:'new-epoch'}));let invocation,published;
 const env={POLY_TALLY_GATEWAY_URL:'https://gateway.example',POLY_TALLY_GATEWAY_PASSWORD:'fixture-proxy-password-not-a-real-secret-123456789'};
 const result=await updateLocal({root,env,gateway:true,collect:(python,args,options)=>{invocation={python,args,options};return {status:0};},publish:async options=>{published=options;return {privateBlobSha:'a'.repeat(40)};},persist:()=>assert.fail('legacy persistence')});
 assert.ok(invocation.args.includes('poly_tally.native_session'));assert.ok(invocation.args.includes('--gateway'));assert.equal(invocation.args[invocation.args.indexOf('--state')+1],join(root,'.poly-tally/local/epochs/new-epoch'));assert.equal(invocation.args[invocation.args.indexOf('--cache')+1],join(root,'.poly-tally/local/cache/private'));assert.equal(invocation.options.env.GH_TOKEN,undefined);assert.equal(invocation.options.env.POLY_TALLY_TOKEN,undefined);assert.match(published.publicFilename,/public-stats.json$/);assert.match(published.privateFilename,/private-metrics.json$/);assert.equal(result.privateBlobSha,'a'.repeat(40));
 await assert.rejects(updateLocal({root,env:{},gateway:true,collect:()=>assert.fail()}),/gateway/i);
});
