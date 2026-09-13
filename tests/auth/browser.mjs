import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sqliteD1 } from './sqlite-d1.mjs';
import { AuthRepository } from '../../js/auth/server/repository.js';
import { createAuthHandler } from '../../js/auth/server/router.js';

// A local HTTP harness with production auth routing/SQL and a mocked Discord.
// Test-source routes are harness-only; production source gating is tested by
// build-acceptance and worker-entry-routing, not this static module fixture.
const root = resolve(fileURLToPath(new URL('../../', import.meta.url))), db = sqliteD1(), owner = '111111111111111111', user = '222222222222222222';
const repo = new AuthRepository(db, owner);
await repo.loginUser({ id: owner, username: 'Owner' });
await repo.loginUser({ id: user, username: '<img src=x onerror="globalThis.XSS=true">' });
const token = await repo.issueSession(owner, 'web');
const adminSource = await readFile(new URL('../../js/auth/admin-app.js', import.meta.url), 'utf8');
const handler = createAuthHandler({ privileged: { buildId: 'a'.repeat(24) + '.' + 'b'.repeat(24), parentSource: '//p', childSource: '//c', adminSource }, fetchRef: async () => { throw new Error('Discord network disabled'); } });
const certDir = await mkdtemp(resolve(tmpdir(), 'hex-auth-browser-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(certDir, 'key.pem'), '-out', resolve(certDir, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-days', '1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 10000, stdio: 'ignore' });
let base;
const server = https.createServer({ key: await readFile(resolve(certDir, 'key.pem')), cert: await readFile(resolve(certDir, 'cert.pem')) }, async (req, res) => {
  try {
    const url = new URL(req.url, base); const body = [];
    for await (const chunk of req) { body.push(chunk); if (Buffer.concat(body).length > 10000) throw new Error('body too large'); }
    const request = new Request(url, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(body) }) });
    const response = await handler(request, { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner });
    if (response) {
      const headers = Object.fromEntries(response.headers); if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname === '/test/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-fixture-nonce'; style-src 'self' 'unsafe-inline'" }); res.end('<!doctype html><html><head><script nonce="fixture-nonce"></script></head><body></body></html>'); return; }
    if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/tests/auth/')) {
      const file = resolve(root, '.' + url.pathname); if (!file.startsWith(root + sep) || !file.endsWith('.js')) throw new Error('not found');
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(await readFile(file)); return;
    }
    res.writeHead(404); res.end('not found');
  } catch { res.writeHead(500); res.end('harness failure'); }
});
server.requestTimeout = 10000; server.headersTimeout = 10000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `https://127.0.0.1:${server.address().port}`;
let browser;
try {
  const module = process.env.AUTH_PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.AUTH_PLAYWRIGHT_MODULE).href) : await import('playwright');
  browser = await module.chromium.launch({ ...(process.env.AUTH_CHROMIUM_EXECUTABLE ? { executablePath: process.env.AUTH_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'], timeout: 15000 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 744, height: 1133 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Host-hex_session', value: token, url: base + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/admin/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#users tr').length === 2);
  assert.ok((await page.locator('#users').textContent()).includes('<img src=x'));
  assert.equal(await page.locator('#users img').count(), 0); assert.equal(await page.evaluate(() => !!globalThis.XSS), false);
  assert.equal(await page.locator(`select[aria-label="Role: ${owner}"]`).isDisabled(), true);
  assert.equal(await page.locator(`input[aria-label="Enabled: ${owner}"]`).isDisabled(), true);
  await page.locator(`select[aria-label="Role: ${user}"]`).selectOption('vip');
  await page.waitForFunction(() => document.getElementById('audit').textContent.includes('"role":"vip"'));
  assert.equal((await repo.user(user)).role, 'vip');
  await page.fill('#query', 'onerror'); await page.locator('#search').evaluate((node) => node.requestSubmit());
  await page.waitForFunction(() => document.querySelectorAll('#users tr').length === 1);
  await page.fill('#discord-id', '444444444444444444'); await page.locator('#register').evaluate((node) => node.requestSubmit());
  await page.waitForFunction(() => document.getElementById('audit').textContent.includes('user.register'));
  assert.equal((await repo.user('444444444444444444')).role, 'free');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(`${base}/test/`);
  const cspResult = await page.evaluate(async () => {
    const { loadChildModule } = await import('/js/auth/extension-loader.js');
    const source = 'var HexPrivilegedChild={installChildExtension(){return "installed"}};';
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const hash = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const module = await loadChildModule({ source, hash });
    return { value: module.installChildExtension(), leftover: Object.keys(globalThis).filter((key) => key.startsWith('__hexExtension_')), scripts: document.querySelectorAll('script[type=module]').length };
  });
  assert.equal(cspResult.value, 'installed'); assert.deepEqual(cspResult.leftover, []); assert.equal(cspResult.scripts, 0);
  const login = await page.evaluate(async () => {
    const { createUserscriptLogin } = await import('/js/auth/userscript-login.js');
    const opens = [], completed = [], listeners = new Map(); let finish = 0;
    const windowRef = { location: { origin: 'https://chatgpt.com' }, open: (...args) => { opens.push(args); return null; }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
    const auth = { startPairing: async () => ({ transactionId: 't'.repeat(43), pollSecret: 'p'.repeat(43), authorizationUrl: 'https://discord.com/oauth2/authorize?scope=identify', expiresAt: Date.now() + 60000 }), pollPairing: async () => ({ status: 'completed' }), completePairing: async (...args) => { completed.push(args.slice(0, 3)); } };
    const ui = createUserscriptLogin({ auth, apiOrigin: location.origin, windowRef, onComplete: () => { finish++; } }); ui.show();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const automatic = opens.length, root = document.querySelector('[role=dialog]');
    root.querySelector('button').click(); root.querySelector('input').value = 's'.repeat(43);
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Complete login').click();
    await new Promise((resolve) => setTimeout(resolve, 10)); ui.close();
    return { automatic, manual: opens.length, finish, completed, listeners: listeners.size, dialogs: document.querySelectorAll('[role=dialog]').length };
  });
  assert.equal(login.automatic, 0); assert.equal(login.manual, 1); assert.equal(login.finish, 1); assert.equal(login.completed.length, 1); assert.equal(login.listeners, 0); assert.equal(login.dialogs, 0);
  assert.deepEqual(errors, []);
  // Logout revokes the cookie and makes the protected JS unavailable.
  await page.goto(`${base}/admin/`); await page.locator('#logout').click(); await page.waitForURL(`${base}/`);
  assert.equal((await context.request.get(`${base}/admin/app.js`)).status(), 401);
  console.log(`Auth browser: PASS (${await browser.version()}); protected admin UI, role/audit/registration, XSS, mobile width, module loader, real-click/paste/cancel, logout.`);
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve)); db.close(); await rm(certDir, { recursive: true, force: true });
}
