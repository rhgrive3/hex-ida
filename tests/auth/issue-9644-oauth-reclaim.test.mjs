import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { AuthRepository, OAUTH_TRANSACTION_PRUNE_BATCH_SIZE, OAUTH_TRANSACTION_RETENTION_MS } from '../../js/auth/server/repository.js';
import { createAuthHandler } from '../../js/auth/server/router.js';
import { randomSecret } from '../../js/auth/server/primitives.js';

const BASE = 'https://hex.test';
const OWNER = '111111111111111111';
const NOW = 1_700_000_000_000;

function transaction(repo, { kind = 'web', expiresAt = NOW + 600_000 } = {}) {
  const id = randomSecret();
  return repo.createTransaction({
    id,
    stateHash: randomSecret(),
    kind,
    returnPath: '/',
    browserHash: kind === 'web' ? randomSecret() : null,
    pollHash: kind === 'userscript' ? randomSecret() : null,
    openerOrigin: kind === 'userscript' ? 'https://chatgpt.com' : null,
    expiresAt,
  }).then(() => id);
}

function transactionCount(db) {
  return db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_transactions').get().count;
}

test('OAuth reclamation removes expired rows after retention and preserves newer and active rows', async (t) => {
  const db = sqliteD1(); t.after(() => db.close());
  const repo = new AuthRepository(db, OWNER, () => NOW);
  const expired = await transaction(repo, { expiresAt: NOW - OAUTH_TRANSACTION_RETENTION_MS - 1 });
  const retainedExpired = await transaction(repo, { expiresAt: NOW - OAUTH_TRANSACTION_RETENTION_MS + 1 });
  const active = await transaction(repo, { expiresAt: NOW + 1 });

  const result = await repo.pruneOAuthTransactions();

  assert.equal(result.deleted, 1);
  assert.equal(await repo.transaction(expired), null);
  assert.ok(await repo.transaction(retainedExpired), 'expired rows remain during the retention window');
  assert.ok(await repo.transaction(active), 'an unexpired, unconsumed transaction is preserved');
});

test('OAuth reclamation removes terminal web and userscript rows after retention', async (t) => {
  const db = sqliteD1(); t.after(() => db.close());
  const repo = new AuthRepository(db, OWNER, () => NOW);
  const oldWeb = await transaction(repo, { kind: 'web' });
  const oldUserscript = await transaction(repo, { kind: 'userscript' });
  const retained = await transaction(repo, { kind: 'userscript' });
  await repo.statement('UPDATE oauth_transactions SET consumed_at = ? WHERE transaction_id IN (?, ?)', NOW - OAUTH_TRANSACTION_RETENTION_MS - 1, oldWeb, oldUserscript).run();
  await repo.statement('UPDATE oauth_transactions SET consumed_at = ? WHERE transaction_id = ?', NOW - OAUTH_TRANSACTION_RETENTION_MS + 1, retained).run();

  await repo.pruneOAuthTransactions();

  assert.equal(await repo.transaction(oldWeb), null);
  assert.equal(await repo.transaction(oldUserscript), null);
  assert.ok(await repo.transaction(retained), 'consumed rows remain during the retention window');
});

test('each OAuth cleanup call deletes a fixed bounded batch and repeated cleanup is idempotent', async (t) => {
  const db = sqliteD1(); t.after(() => db.close());
  const repo = new AuthRepository(db, OWNER, () => NOW);
  const count = OAUTH_TRANSACTION_PRUNE_BATCH_SIZE * 2 + 3;
  for (let index = 0; index < count; index++) await transaction(repo, { expiresAt: NOW - OAUTH_TRANSACTION_RETENTION_MS - 1 });

  const first = await repo.pruneOAuthTransactions();
  assert.equal(first.limit, OAUTH_TRANSACTION_PRUNE_BATCH_SIZE);
  assert.ok(first.deleted > 0 && first.deleted <= OAUTH_TRANSACTION_PRUNE_BATCH_SIZE);
  assert.equal(transactionCount(db), count - first.deleted, 'rows beyond one bounded batch remain for a later pass');

  let deleted = first.deleted;
  while (deleted < count) deleted += (await repo.pruneOAuthTransactions()).deleted;
  assert.equal(deleted, count);
  assert.equal((await repo.pruneOAuthTransactions()).deleted, 0);
  assert.equal(transactionCount(db), 0);

  const expiryPlan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT transaction_id FROM oauth_transactions INDEXED BY oauth_expiry
    WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`).all(NOW - OAUTH_TRANSACTION_RETENTION_MS, OAUTH_TRANSACTION_PRUNE_BATCH_SIZE / 2);
  const consumedPlan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT transaction_id FROM oauth_transactions INDEXED BY oauth_consumed_at
    WHERE consumed_at <= ? ORDER BY consumed_at LIMIT ?`).all(NOW - OAUTH_TRANSACTION_RETENTION_MS, OAUTH_TRANSACTION_PRUNE_BATCH_SIZE / 2);
  assert.ok(expiryPlan.some((row) => row.detail.includes('oauth_expiry')));
  assert.ok(consumedPlan.some((row) => row.detail.includes('oauth_consumed_at')));
});

test('both public OAuth start routes run only one bounded cleanup pass each', async (t) => {
  const db = sqliteD1(); t.after(() => db.close());
  let now = NOW;
  const repo = new AuthRepository(db, OWNER, () => now);
  const count = OAUTH_TRANSACTION_PRUNE_BATCH_SIZE + 7;
  for (let index = 0; index < count; index++) await transaction(repo, { expiresAt: now - OAUTH_TRANSACTION_RETENTION_MS - 1 });
  const handler = createAuthHandler({ now: () => now });
  const env = {
    AUTH_DB: db,
    HEX_OWNER_DISCORD_ID: OWNER,
    DISCORD_CLIENT_ID: '999999999999999999',
    DISCORD_CLIENT_SECRET: 'fixture-only-secret',
    DISCORD_REDIRECT_URI: `${BASE}/auth/discord/callback`,
  };
  const oldCount = () => db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_transactions WHERE expires_at <= ?').get(now - OAUTH_TRANSACTION_RETENTION_MS).count;

  const webStart = await handler(new Request(`${BASE}/auth/discord/start`), env);
  assert.equal(webStart.status, 302);
  const afterWebStart = oldCount();
  assert.ok(afterWebStart > 0, 'one public request leaves older rows for subsequent bounded passes');
  assert.ok(count - afterWebStart <= OAUTH_TRANSACTION_PRUNE_BATCH_SIZE);

  const scriptStart = await handler(new Request(`${BASE}/api/auth/userscript/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openerOrigin: 'https://chatgpt.com' }),
  }), env);
  assert.equal(scriptStart.status, 200);
  assert.ok(oldCount() < afterWebStart, 'the second public route advances cleanup by one more bounded pass');
});

test('a successful OAuth callback finishes with one bounded cleanup pass', async (t) => {
  const db = sqliteD1(); t.after(() => db.close());
  const repo = new AuthRepository(db, OWNER, () => NOW);
  const handler = createAuthHandler({
    now: () => NOW,
    fetchRef: async (url) => String(url).endsWith('/oauth2/token')
      ? Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer' })
      : Response.json({ id: '222222222222222222', username: 'fixture-user' }),
  });
  const env = {
    AUTH_DB: db,
    HEX_OWNER_DISCORD_ID: OWNER,
    DISCORD_CLIENT_ID: '999999999999999999',
    DISCORD_CLIENT_SECRET: 'fixture-only-secret',
    DISCORD_REDIRECT_URI: `${BASE}/auth/discord/callback`,
  };
  const start = await handler(new Request(`${BASE}/auth/discord/start`), env);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const binder = start.headers.get('set-cookie').split(';')[0];
  const count = OAUTH_TRANSACTION_PRUNE_BATCH_SIZE + 7;
  for (let index = 0; index < count; index++) await transaction(repo, { expiresAt: NOW - OAUTH_TRANSACTION_RETENTION_MS - 1 });

  const callback = await handler(new Request(`${BASE}/auth/discord/callback?state=${state}&code=mock-code`, { headers: { cookie: binder } }), env);

  assert.equal(callback.status, 303);
  const remaining = db.sqlite.prepare('SELECT COUNT(*) AS count FROM oauth_transactions WHERE expires_at <= ?').get(NOW - OAUTH_TRANSACTION_RETENTION_MS).count;
  assert.equal(count - remaining, OAUTH_TRANSACTION_PRUNE_BATCH_SIZE / 2, 'callback completion triggers one fixed-size cleanup pass');
});

test('OAuth cleanup is scheduled independently of requests every five minutes', () => {
  const config = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"crons"\s*:\s*\[\s*"\*\/5 \* \* \* \*"\s*\]/);
});
