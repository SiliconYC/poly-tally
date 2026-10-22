import {execFileSync, spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runState} from './state.mjs';

export async function updateLocal({root = resolve(import.meta.dirname, '..'), env = process.env, collect = spawnSync, persist = runState, fetcher = fetch} = {}) {
  const repository = env.GITHUB_REPOSITORY || 'SiliconYC/poly-tally';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GITHUB_REPOSITORY');
  const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
  const epoch = env.POLY_TALLY_DATASET_EPOCH || config.datasetEpoch;
  if (typeof epoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(epoch)) throw new Error('Invalid dataset epoch');
  let token = env.GH_TOKEN || env.POLY_TALLY_TOKEN;
  if (!token) {
    const credential = execFileSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'},
    });
    token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9);
    if (!token) throw new Error('Git credential helper returned no GitHub credential');
  }
  const state = resolve(root, env.POLY_TALLY_LOCAL_STATE || '.poly-tally/local');
  const privateMetrics = resolve(state, 'private-metrics.json');
  const environment = {...env, GH_TOKEN: token, POLY_TALLY_TOKEN: env.POLY_TALLY_TOKEN || token, GITHUB_REPOSITORY: repository, POLY_TALLY_DATASET_EPOCH: epoch};
  const result = collect(env.POLY_TALLY_PYTHON || resolve(root, '.venv/bin/python'), [
    '-m', 'poly_tally', 'collect', '--state', state, '--include-private-metrics',
    '--private-metrics-output', privateMetrics, '--output', resolve(state, 'combined-stats.json'),
    '--checkpoint', resolve(state, 'checkpoint.json'), '--report', resolve(state, 'latest-report.json'), '--refresh',
  ], {cwd: root, env: environment, stdio: 'inherit'});
  if (result.error || result.status !== 0) throw new Error('Local collection failed; publication stopped');
  // 只更新私有脱敏文件，避免本地公开检查点覆盖并行云端采集的较新结果。
  const saved = await persist('save-private', privateMetrics, undefined, {env: environment});
  if (!/^[a-f0-9]{40}$/.test(saved.privateBlobSha)) throw new Error('Missing durable private snapshot blob SHA');
  const response = await fetcher(`https://api.github.com/repos/${repository}/actions/workflows/pages.yml/dispatches`, {
    method: 'POST', headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28'},
    body: JSON.stringify({ref: 'dev', inputs: {external_private_blob_sha: saved.privateBlobSha}}),
  });
  if (!response.ok) throw new Error(`Pages dispatch failed: HTTP ${response.status}; sanitized data is saved and can be republished`);
  return saved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('Configure paths with POLY_TALLY_LOCAL_STATE and POLY_TALLY_PYTHON');
    await updateLocal();
    console.log('Incremental collection saved; GitHub Pages publication dispatched.');
  } catch (error) {
    console.error(error.code ? `Local update failed (${error.code})` : error.message);
    process.exitCode = 1;
  }
}
