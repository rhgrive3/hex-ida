import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildFrameSrcdoc } from '../js/sandbox.js';

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const uxJs = fs.readFileSync(new URL('../js/ux.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const browserTestMjs = fs.readFileSync(new URL('./ui/browser.mjs', import.meta.url), 'utf8');

function extractCspDirectives(html) {
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i);
  assert.ok(match, 'index.html must contain a Content-Security-Policy meta tag');
  const directives = new Map();
  for (const part of match[1].split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    directives.set(name.toLowerCase(), values);
  }
  return directives;
}

test('index.html defines strict CSP matching js/sandbox.js FRAME script SHA-256 without unsafe-inline', () => {
  const directives = extractCspDirectives(indexHtml);

  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.deepEqual(directives.get('form-action'), ["'self'"]);
  assert.deepEqual(directives.get('frame-src'), ["'self'"]);

  const scriptSrc = directives.get('script-src') || [];
  assert.ok(scriptSrc.includes("'self'"), "script-src must include 'self'");
  assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), "script-src must include 'wasm-unsafe-eval'");
  assert.ok(scriptSrc.includes('blob:'), 'script-src must include blob: for sandbox Worker importScripts');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must NOT include 'unsafe-inline'");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src must NOT include 'unsafe-eval'");

  const frame = buildFrameSrcdoc();
  const scriptMatch = frame.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'buildFrameSrcdoc() must include an inline <script> block');
  const expectedDigest = crypto.createHash('sha256').update(scriptMatch[1], 'utf8').digest('base64');
  const expectedToken = `'sha256-${expectedDigest}'`;
  assert.ok(
    scriptSrc.includes(expectedToken),
    `script-src must include exact SHA-256 hash ${expectedToken} of js/sandbox.js FRAME script`,
  );

  const workerSrc = directives.get('worker-src') || [];
  assert.ok(workerSrc.includes("'self'") && workerSrc.includes('blob:'), 'worker-src must allow self and blob:');

  const fontSrc = directives.get('font-src') || [];
  assert.deepEqual(fontSrc, ["'self'", 'data:'], 'font-src must not allow external font origins');
});

test('index.html and js/ux.js contain zero Google Fonts references', () => {
  for (const [label, content] of [['index.html', indexHtml], ['js/ux.js', uxJs]]) {
    assert.ok(!/fonts\.googleapis\.com/i.test(content), `${label} must not reference fonts.googleapis.com`);
    assert.ok(!/fonts\.gstatic\.com/i.test(content), `${label} must not reference fonts.gstatic.com`);
    assert.ok(!/hex-optional-fonts/i.test(content), `${label} must not reference hex-optional-fonts`);
  }
  assert.ok(
    /remoteFontRequests\.length === 0/.test(browserTestMjs),
    'tests/ui/browser.mjs must assert zero remote Google Fonts requests on startup',
  );
});

test('index.html includes #integrity-banner and css/app.css defines loading lock, banner, and save error styles', () => {
  assert.match(
    indexHtml,
    /<div\s+class="integrity-banner"\s+id="integrity-banner"\s+role="alert"\s+hidden><\/div>/,
    'index.html must include hidden #integrity-banner with role="alert"',
  );

  assert.match(appCss, /body\.is-file-loading\s+\.loading[\s\S]*?position:\s*fixed;/);
  assert.match(appCss, /body\.is-file-loading\s+\.loading[\s\S]*?inset:\s*0;/);
  assert.match(appCss, /body\.is-file-loading\s+\.loading[\s\S]*?z-index:\s*2000;/);
  assert.match(appCss, /body\.is-file-loading\s+\.loading[\s\S]*?pointer-events:\s*all;/);
  assert.match(appCss, /body\.is-file-loading\s+#overlays\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(appCss, /\.integrity-banner\s*\{/);
  assert.match(appCss, /\.integrity-banner\[hidden\]\s*\{[^}]*display:\s*none;/);
  assert.match(appCss, /\.status-save-error\s*\{/);

  // #loading must live outside .viewwrap (direct child of <body>, sibling of #overlays)
  // so .ui-screen-route > .viewwrap { display: none !important } never hides the loading lock.
  const viewwrapStart = indexHtml.indexOf('<div class="viewwrap">');
  const overlaysIdx = indexHtml.indexOf('<div id="overlays"></div>');
  const loadingIdx = indexHtml.indexOf('<div class="loading" id="loading" hidden>');
  assert.ok(viewwrapStart >= 0 && overlaysIdx > viewwrapStart, 'index.html must contain .viewwrap before #overlays');
  assert.ok(loadingIdx > overlaysIdx, '#loading must be placed outside .viewwrap as a sibling of #overlays under <body>');
});
