import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sqliteD1 } from './sqlite-d1.mjs';
import { AuthRepository } from '../../js/auth/server/repository.js';
import { createAuthHandler } from '../../js/auth/server/router.js';
import { ADMIN_HTML, ADMIN_CSS } from '../../js/auth/server/admin-site.js';

// Offline DOM regression, NOT an HTTP/CSP/production-bundle acceptance test.
// Every fetch below is a local in-process Request to the real auth handler/SQL.
const BASE = 'https://hex.test', owner = '111111111111111111', user = '222222222222222222';
const db = sqliteD1(), repo = new AuthRepository(db, owner);
await repo.loginUser({ id: owner, username: 'Owner' });
await repo.loginUser({ id: user, username: '<img src=x onerror="globalThis.XSS=true">' });
const token = await repo.issueSession(owner, 'web');
const handler = createAuthHandler({ privileged: { buildId: 'a'.repeat(24) + '.' + 'b'.repeat(24), adminSource: '//fixture' }, fetchRef: () => { throw new Error('External fetch forbidden.'); } });
let browser;
try {
  const pw = process.env.AUTH_PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.AUTH_PLAYWRIGHT_MODULE).href) : await import('playwright');
  browser = await pw.chromium.launch({ ...(process.env.AUTH_CHROMIUM_EXECUTABLE ? { executablePath: process.env.AUTH_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'], timeout: 15000 });
  const page = await browser.newPage({ viewport: { width: 744, height: 1133 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('__fixtureRequest', async (path, init) => {
    const headers = { ...(init?.headers || {}), cookie: `__Host-hex_session=${token}` };
    if (init?.method && init.method !== 'GET') headers.origin = BASE;
    const response = await handler(new Request(new URL(path, BASE), { ...init, headers, signal: undefined }), { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner });
    return { status: response.status, body: await response.json() };
  });
  await page.setContent(ADMIN_HTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  await page.addStyleTag({ content: ADMIN_CSS });
  await page.evaluate(() => { globalThis.fetch = async (path, init) => { const { status, body } = await globalThis.__fixtureRequest(path, init); return { ok: status >= 200 && status < 300, status, json: async () => body }; }; });
  await page.addScriptTag({ content: `(()=>{${await readFile(new URL('../../js/auth/admin-app.js', import.meta.url), 'utf8')}\n})();` });
  await page.waitForFunction(() => document.querySelectorAll('#users tr').length === 2);
  assert.ok((await page.locator('#users').textContent()).includes('<img src=x')); assert.equal(await page.locator('#users img').count(), 0);
  assert.equal(await page.evaluate(() => !!globalThis.XSS), false);
  assert.equal(await page.locator(`select[aria-label="Role: ${owner}"]`).isDisabled(), true);
  assert.equal(await page.locator(`input[aria-label="Enabled: ${owner}"]`).isDisabled(), true);
  await page.locator(`select[aria-label="Role: ${user}"]`).selectOption('vip');
  await page.waitForFunction(() => document.getElementById('audit').textContent.includes('"role":"vip"'));
  assert.equal((await repo.user(user)).role, 'vip');
  await page.locator(`input[aria-label="Enabled: ${user}"]`).uncheck();
  await page.waitForFunction(() => document.getElementById('audit').textContent.includes('"enabled":0'));
  assert.equal((await repo.user(user)).enabled, 0);
  await page.fill('#query', 'onerror'); await page.locator('#search').evaluate((node) => node.requestSubmit());
  await page.waitForFunction(() => document.querySelectorAll('#users tr').length === 1);
  await page.fill('#discord-id', '444444444444444444'); await page.locator('#register').evaluate((node) => node.requestSubmit());
  await page.waitForFunction(() => document.getElementById('audit').textContent.includes('user.register'));
  assert.equal((await repo.user('444444444444444444')).role, 'free');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setContent('<!doctype html><html><body></body></html>');
  const loginSource = await readFile(new URL('../../js/auth/userscript-login.js', import.meta.url), 'utf8');
  await page.addScriptTag({ content: `${loginSource.replace(/^export /gm, '')}\nglobalThis.__loginFixture=createUserscriptLogin;` });
  const login = await page.evaluate(async () => {
    const opens = [], completed = [], listeners = new Map(); let finish = 0;
    const windowRef = { location: { origin: 'https://chatgpt.com' }, open: (...args) => { opens.push(args); return null; }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
    const auth = { startPairing: async () => ({ transactionId: 't'.repeat(43), pollSecret: 'p'.repeat(43), authorizationUrl: 'https://discord.com/oauth2/authorize?scope=identify', expiresAt: Date.now() + 60000 }), pollPairing: async () => ({ status: 'completed' }), completePairing: async (...args) => { completed.push(args.slice(0, 3)); } };
    const ui = globalThis.__loginFixture({ auth, apiOrigin: 'https://hex.test', windowRef, onComplete: () => { finish++; } }); ui.show();
    await new Promise((resolve) => setTimeout(resolve, 10)); const automatic = opens.length, root = document.querySelector('[role=dialog]');
    root.querySelector('button').click(); root.querySelector('input').value = 's'.repeat(43);
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Complete login').click();
    await new Promise((resolve) => setTimeout(resolve, 10)); ui.close();
    return { automatic, manual: opens.length, finish, completed, listeners: listeners.size, dialogs: document.querySelectorAll('[role=dialog]').length };
  });
  assert.equal(login.automatic, 0); assert.equal(login.manual, 1); assert.equal(login.finish, 1); assert.equal(login.completed.length, 1); assert.equal(login.listeners, 0); assert.equal(login.dialogs, 0); assert.deepEqual(errors, []);
  console.log(`Offline auth DOM: PASS (${await browser.version()}); admin XSS, owner locks, role/enabled edits, audit/search/register, tablet width, actual-click/paste/cancel. Network/CSP/bundling are NOT covered.`);
} finally { await browser?.close(); db.close(); }
