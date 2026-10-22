import {cp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mergePrivateMetrics, validatePrivateMetrics, validateCompletePrivateMetrics, validateRetainedPrivateBaseline, validatePrivateMetricsReplacement} from './metrics.mjs';
import {applyDisplayWindow} from '../web/model.mjs';

async function bundleSite({root, site}) {
  const {build} = await import('vite');
  await build({configFile: resolve(root, 'vite.config.ts'), root: resolve(root, 'web'), build: {outDir: site}});
}

export async function buildSite({root = resolve(import.meta.dirname, '..'), privateStatus = process.env.POLY_TALLY_PRIVATE_STATUS, externalPrivateBlobSha = process.env.POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA, logger = console, bundle = bundleSite} = {}) {
  let data = JSON.parse(await readFile(resolve(root, 'web/data/stats.json'), 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.repositories)) throw new Error('Invalid public dataset');
  let display;
  try {
    display = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8')).display;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let privateBytes;
  try {
    privateBytes = await readFile(resolve(root, 'web/data/private-metrics.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (externalPrivateBlobSha && privateBytes === undefined) throw new Error('Selected external private snapshot is missing; refusing site build.');
  let retainedBaseline;
  try {
    retainedBaseline = JSON.parse(await readFile(resolve(root, 'web/data/retained-private-baseline.json'), 'utf8'));
    validateRetainedPrivateBaseline(retainedBaseline);
    // A later reset does not silently inherit this one-time exception.
    if (retainedBaseline.targetEpoch !== data.datasetEpoch) retainedBaseline = undefined;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (privateBytes !== undefined) {
    let privateData;
    try {
      privateData = JSON.parse(privateBytes);
      validatePrivateMetrics(privateData);
    } catch {
      throw new Error('Invalid sanitized private metrics; refusing site build.');
    }
    validateCompletePrivateMetrics(privateData);
    if (retainedBaseline) validatePrivateMetricsReplacement(retainedBaseline.metrics, privateData, data, {resetEpoch: data.datasetEpoch, preserveScope: true});
    data = mergePrivateMetrics(data, privateData, {privateStatus, externalPrivateBlobSha, privateBytes});
  }
  if (privateBytes === undefined && retainedBaseline) data = mergePrivateMetrics(data, retainedBaseline.metrics, {retainedBaseline});
  if (data.datasetEpoch && privateBytes === undefined && !retainedBaseline) {
    data.publication = {privateRepositories: 0, privateUpdatedAt: null, privateSource: null, privateStatus: 'pending-rebuild'};
    if (data.lineageVersion) {
      data.publication.publicCompleteness = structuredClone(data.completeness ?? null);
      data.publication.privateCompleteness = null;
      data.completeness = {...data.completeness, complete: false};
    }
  }
  // 先验证并合并完整事实，再裁剪展示；检查点和私有快照始终保留完整历史。
  data = applyDisplayWindow(data, display);
  const site = resolve(root, 'site');
  await rm(site, {recursive: true, force: true});
  await bundle({root, site});
  await mkdir(resolve(site, 'data'), {recursive: true});
  await writeFile(resolve(site, 'data/stats.json'), JSON.stringify(data));
  await cp(resolve(root, 'web/favicon.svg'), resolve(site, 'favicon.svg'));
  await writeFile(resolve(site, '.nojekyll'), '');
  logger.log(`Built static site: ${data.repositories.length} repository records.`);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await buildSite();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
