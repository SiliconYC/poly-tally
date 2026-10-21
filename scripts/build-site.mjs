import {cp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mergePrivateMetrics, validatePrivateMetrics} from './metrics.mjs';

export async function buildSite({root = resolve(import.meta.dirname, '..'), privateStatus = process.env.POLY_TALLY_PRIVATE_STATUS, logger = console} = {}) {
  let data = JSON.parse(await readFile(resolve(root, 'web/data/stats.json'), 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.repositories)) throw new Error('Invalid public dataset');
  let privateBytes;
  try {
    privateBytes = await readFile(resolve(root, 'web/data/private-metrics.json'), 'utf8');
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
    data = mergePrivateMetrics(data, privateData);
    if (privateStatus === 'stale') data.publication.privateStatus = 'stale';
  }
  await rm(resolve(root, 'site'), {recursive: true, force: true});
  await mkdir(resolve(root, 'site'), {recursive: true});
  await cp(resolve(root, 'web'), resolve(root, 'site'), {recursive: true, filter: path => !path.endsWith('.test.mjs') && path !== resolve(root, 'web/data/private-metrics.json')});
  await writeFile(resolve(root, 'site/data/stats.json'), JSON.stringify(data));
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
