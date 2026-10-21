import {cp, mkdir, rm, writeFile, readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, relative, dirname, extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mergePrivateMetrics, validatePrivateMetrics, validateRetainedPrivateBaseline, validatePrivateMetricsReplacement} from './metrics.mjs';

// A release-wide content digest keeps the HTML, CSS and complete ESM graph together.
// Hash filenames (rather than reload instructions) invalidate browser/CDN asset caches.
async function versionAssets(site) {
  const assets = [], htmlPages = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'data') await visit(path); }
      else if (/\.(?:mjs|js|css)$/.test(entry.name)) assets.push(path);
      else if (entry.name.endsWith('.html')) htmlPages.push(path);
    }
  }
  await visit(site);
  if (!assets.length) return;
  assets.sort();
  const sources = new Map();
  const digest = createHash('sha256');
  for (const path of assets) {
    const source = await readFile(path, 'utf8');
    sources.set(path, source);
    digest.update(relative(site, path)).update('\0').update(source).update('\0');
  }
  const version = digest.digest('hex').slice(0, 16);
  const names = new Map(assets.map(path => [path, path.slice(0, -extname(path).length) + '.' + version + extname(path)]));
  function rewrite(source, path) {
    // Resolve only quoted relative references to assets we actually copied. Data
    // fetches, external URLs, anchors and arbitrary strings remain untouched.
    return source.replace(/(["'])(\.{1,2}\/[^"'\s?#]+)([?#][^"']*)?\1/g, (match, quote, url, suffix = '') => {
      const replacement = names.get(resolve(dirname(path), url));
      if (!replacement) return match;
      let target = relative(dirname(path), replacement).split('\\').join('/');
      if (!target.startsWith('.')) target = './' + target;
      return quote + target + suffix + quote;
    });
  }
  for (const [path, source] of sources) {
    await writeFile(names.get(path), rewrite(source, path));
    await rm(path);
  }
  for (const page of htmlPages) await writeFile(page, rewrite(await readFile(page, 'utf8'), page));
}

export async function buildSite({root = resolve(import.meta.dirname, '..'), privateStatus = process.env.POLY_TALLY_PRIVATE_STATUS, logger = console} = {}) {
  let data = JSON.parse(await readFile(resolve(root, 'web/data/stats.json'), 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.repositories)) throw new Error('Invalid public dataset');
  let privateBytes;
  try {
    privateBytes = await readFile(resolve(root, 'web/data/private-metrics.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
    if (privateData.collection.failed > 0) throw new Error('Incomplete private collection; retain a previous complete sanitized snapshot.');
    if (retainedBaseline) validatePrivateMetricsReplacement(retainedBaseline.metrics, privateData, data, {resetEpoch: data.datasetEpoch, preserveScope: true});
    data = mergePrivateMetrics(data, privateData);
    if (privateStatus === 'stale') data.publication.privateStatus = 'stale';
  }
  if (privateBytes === undefined && retainedBaseline) data = mergePrivateMetrics(data, retainedBaseline.metrics, {retainedBaseline});
  if (data.datasetEpoch && privateBytes === undefined && !retainedBaseline) {
    data.publication = {privateRepositories: 0, privateUpdatedAt: null, privateSource: null, privateStatus: 'pending-rebuild'};
  }
  await rm(resolve(root, 'site'), {recursive: true, force: true});
  await mkdir(resolve(root, 'site'), {recursive: true});
  await cp(resolve(root, 'web'), resolve(root, 'site'), {recursive: true, filter: path => !path.endsWith('.test.mjs') && !['private-metrics.json', 'retained-private-baseline.json'].some(name => path === resolve(root, 'web/data', name))});
  await writeFile(resolve(root, 'site/data/stats.json'), JSON.stringify(data));
  await versionAssets(resolve(root, 'site'));
  await writeFile(resolve(root, 'site/.nojekyll'), '');
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
