import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { chromium } from 'playwright';

const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

function serveSource(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, relative);
  if ((!file.startsWith(`${ROOT}${path.sep}`) && file !== path.join(ROOT, 'index.html')) ||
      !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
}

async function run() {
  const server = http.createServer(serveSource);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ja-JP' });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__app, null, { timeout: 10000 });
    await page.evaluate(() => window.__app.openSample());
    await page.waitForFunction(() => !!window.__app?.store?.get('fileInfo'), null, { timeout: 20000 });

    const result = await page.evaluate(async () => {
      const app = window.__app;
      await app.workspace.bind();
      if (!app.workspace.identity) throw new Error('workspace did not bind to sample');

      app.setLanguage('ja');
      app.setExplain(true);
      app.setTextSize('m');
      const initialOpenLabel = document.querySelector('#btn-open')?.textContent || '';

      const exported = await app.exportProjectFile();
      const baseProject = JSON.parse(await exported.text());
      const makeProjectFile = (settings, name) => {
        const project = structuredClone(baseProject);
        project.analysis = project.analysis || {};
        project.analysis.settings = settings;
        return new File([JSON.stringify(project)], name, { type: 'application/vnd.hex.project+json' });
      };

      await app.importProjectFile(makeProjectFile({ language: 'en', explain: false, textSize: 'xl' }, 'valid.hexproj'));
      const i18n = await import('/js/i18n.js');
      const root = document.documentElement;
      const valid = {
        prefs: { language: app.prefs.lang, explain: app.prefs.explain, textSize: app.prefs.textSize },
        activeLanguage: i18n.lang(),
        openLabel: document.querySelector('#btn-open')?.textContent || '',
        expectedOpenLabel: i18n.t('btn.open'),
        initialOpenLabel,
        explainAria: document.querySelector('#btn-explain')?.getAttribute('aria-pressed'),
        viewerShowNotes: app.viewer.showNotes,
        withNotes: root.classList.contains('with-notes'),
        sizeXl: root.classList.contains('size-xl'),
        otherSizes: ['s', 'm', 'l'].filter((size) => root.classList.contains(`size-${size}`)),
      };

      await app.importProjectFile(makeProjectFile({ language: 'fr', explain: 'false', textSize: 'xxl' }, 'invalid.hexproj'));
      const invalid = {
        prefs: { language: app.prefs.lang, explain: app.prefs.explain, textSize: app.prefs.textSize },
        activeLanguage: i18n.lang(),
        openLabel: document.querySelector('#btn-open')?.textContent || '',
        explainAria: document.querySelector('#btn-explain')?.getAttribute('aria-pressed'),
        viewerShowNotes: app.viewer.showNotes,
        withNotes: root.classList.contains('with-notes'),
        sizeXl: root.classList.contains('size-xl'),
      };
      return { valid, invalid };
    });

    assert.deepEqual(result.valid.prefs, { language: 'en', explain: false, textSize: 'xl' });
    assert.equal(result.valid.activeLanguage, 'en');
    assert.equal(result.valid.openLabel, result.valid.expectedOpenLabel);
    assert.notEqual(result.valid.openLabel, result.valid.initialOpenLabel);
    assert.equal(result.valid.explainAria, 'false');
    assert.equal(result.valid.viewerShowNotes, false);
    assert.equal(result.valid.withNotes, false);
    assert.equal(result.valid.sizeXl, true);
    assert.deepEqual(result.valid.otherSizes, []);

    assert.deepEqual(result.invalid.prefs, { language: 'en', explain: false, textSize: 'xl' });
    assert.equal(result.invalid.activeLanguage, 'en');
    assert.equal(result.invalid.openLabel, result.valid.openLabel);
    assert.equal(result.invalid.explainAria, 'false');
    assert.equal(result.invalid.viewerShowNotes, false);
    assert.equal(result.invalid.withNotes, false);
    assert.equal(result.invalid.sizeXl, true);

    console.log(`project settings browser: PASS (${JSON.stringify(result.valid)})`);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
