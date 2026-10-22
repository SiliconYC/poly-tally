import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {buildSite} from './build-site.mjs';

const project = resolve(import.meta.dirname, '..');
const publicStats = {schemaVersion: 1, generatedAt: '2026-10-21T05:00:00Z', rules: {version: '0123456789abcdef'}, repositories: []};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tally-react-build-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'web/src'), {recursive: true});
  await mkdir(join(root, 'web/data'));
  await mkdir(join(root, 'web/qa-lineage/data'), {recursive: true});
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await cp(join(project, 'vite.config.ts'), join(root, 'vite.config.ts'));
  await cp(join(project, 'web/favicon.svg'), join(root, 'web/favicon.svg'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify(publicStats));
  await writeFile(join(root, 'web/data/private-metrics.json'), JSON.stringify({schemaVersion: 1, generatedAt: '2026-10-21T04:00:00Z', rulesVersion: publicStats.rules.version, source: 'local', collection: {repositories: 0, failed: 0}, repositories: []}));
  await writeFile(join(root, 'web/data/unselected.json'), 'unselected-data-must-stay-private');
  await writeFile(join(root, 'web/index.html'), '<!doctype html><html><head></head><body><main id="root"></main><script type="module" src="/src/main.tsx"></script></body></html>');
  await writeFile(join(root, 'web/src/main.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import './styles.css'; createRoot(document.getElementById('root')!).render(<h1>React build fixture</h1>); import('./lazy').then(module => module.load()); fetch(import.meta.env.BASE_URL + 'data/stats.json');`);
  await writeFile(join(root, 'web/src/lazy.ts'), 'export const load = () => console.log("dynamic-chunk-fixture");');
  await writeFile(join(root, 'web/src/styles.css'), 'body{color:#123456}');
  await writeFile(join(root, 'web/src/debug.test.tsx'), 'unimported-test-must-stay-private');
  await writeFile(join(root, 'web/qa-lineage/index.html'), 'unselected-preview-must-stay-private');
  await writeFile(join(root, 'web/qa-lineage/data/stats.json'), 'unselected-preview-data-must-stay-private');
  return root;
}

async function assets(root) {
  const html = await readFile(join(root, 'site/index.html'), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="(\/poly-tally\/assets\/[^"\s]+)"/g)].map(match => match[1]);
  return {html, urls};
}

test('Vite emits content-hashed React assets, keeps identical URLs, and cleans stale releases', async t => {
  const root = await fixture(t);
  const build = () => buildSite({root, logger: {log() {}}});
  await build();
  const first = await assets(root);
  assert.ok(first.urls.some(url => /-[\w-]{8,}\.js$/.test(url)), 'entry module has a content hash');
  assert.ok(first.urls.some(url => /-[\w-]{8,}\.css$/.test(url)), 'stylesheet has a content hash');
  const assetNames = await readdir(join(root, 'site/assets'));
  assert.ok(assetNames.some(name => /^lazy-[\w-]{8,}\.js$/.test(name)), 'dynamic imports are bundled into hashed chunks');
  await build();
  assert.deepEqual(await assets(root), first, 'identical inputs retain cacheable URLs');
  await writeFile(join(root, 'site/assets/stale-release.js'), 'old-build');
  await writeFile(join(root, 'web/src/styles.css'), 'body{color:#abcdef}');
  await build();
  const next = await assets(root);
  const oldCss = first.urls.find(url => url.endsWith('.css'));
  assert.notEqual(next.urls.find(url => url.endsWith('.css')), oldCss);
  assert.ok(!(await readdir(join(root, 'site/assets'))).includes(oldCss.split('/').at(-1)));
  assert.ok(!(await readdir(join(root, 'site/assets'))).includes('stale-release.js'));
  assert.match(await readFile(join(root, 'web/src/main.tsx'), 'utf8'), /React build fixture/);
});

test('Pages subpath serves built assets and merged data without publishing source or nested previews', async t => {
  const root = await fixture(t);
  await buildSite({root, logger: {log() {}}});
  const {html, urls} = await assets(root);
  assert.ok(urls.length >= 2);
  assert.doesNotMatch(html, /\/src\/|\.tsx|\.mjs/);
  assert.deepEqual((await readdir(join(root, 'site'))).sort(), ['.nojekyll', 'assets', 'data', 'favicon.svg', 'index.html']);
  assert.deepEqual(await readdir(join(root, 'site/data')), ['stats.json']);
  assert.ok((await readdir(join(root, 'site/assets'))).every(name => !/\.(?:map|tsx?|mjs)$/.test(name)));
  const javascript = (await Promise.all((await readdir(join(root, 'site/assets'))).filter(name => name.endsWith('.js')).map(name => readFile(join(root, 'site/assets', name), 'utf8')))).join('\n');
  assert.ok(javascript.includes('/poly-tally/data/stats.json'), 'runtime fetch uses the Pages base path');
  assert.ok(!javascript.includes('must-stay-private'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/poly-tally/')) { response.writeHead(404).end(); return; }
      response.end(await readFile(join(root, 'site', pathname.slice('/poly-tally/'.length) || 'index.html')));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const url of ['/poly-tally/', ...urls, '/poly-tally/favicon.svg']) {
    assert.equal((await fetch(origin + url)).status, 200, url);
  }
  const data = await (await fetch(origin + '/poly-tally/data/stats.json')).json();
  assert.equal(data.publication.privateUpdatedAt, '2026-10-21T04:00:00Z');
  assert.deepEqual(data.repositories, []);
  for (const path of ['src/main.tsx', 'data/private-metrics.json', 'data/unselected.json', 'qa-lineage/', 'qa-lineage/data/stats.json']) {
    assert.equal((await fetch(origin + '/poly-tally/' + path)).status, 404, path);
  }
});
