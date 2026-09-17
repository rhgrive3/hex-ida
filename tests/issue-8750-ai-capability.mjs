import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mintAICapability, verifyAICapability, AI_CAPABILITY_TTL_MS } from '../js/auth/server/ai-capability.js';
import { sqliteD1 } from './auth/sqlite-d1.mjs';
import { createAuthHandler } from '../js/auth/server/router.js';
import { AuthRepository } from '../js/auth/server/repository.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const key = new Uint8Array(32).fill(7);
const buildId = `${'a'.repeat(24)}.${'b'.repeat(24)}`;
const subject = 'c'.repeat(64);
const now = 1_700_000_000_000;

const grant = await mintAICapability({ signingKey: key, buildId, subject, now });
assert.equal(grant.expiresAt, now + AI_CAPABILITY_TTL_MS);
const verified = await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + 1000 });
assert.equal(verified?.aud, 'hex-ai-provider');
assert.equal(verified?.bid, buildId);
assert.match(verified?.sid || '', /^[A-Za-z0-9_-]{22}$/);
assert.notEqual(verified?.sid, subject, 'capability must not expose the long-lived session token hash');
assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId: `${'d'.repeat(24)}.${'e'.repeat(24)}`, now: now + 1000 }), null, 'wrong build must fail');
assert.equal(await verifyAICapability(grant.capability, { signingKey: key, buildId, now: now + AI_CAPABILITY_TTL_MS + 1000 }), null, 'expired grant must fail');
assert.equal(await verifyAICapability(grant.capability.slice(0, -1) + (grant.capability.endsWith('A') ? 'B' : 'A'), { signingKey: key, buildId, now: now + 1000 }), null, 'tampering must fail');
assert.equal(await verifyAICapability('not-a-token', { signingKey: key, buildId, now }), null);
const bounded = await mintAICapability({ signingKey: key, buildId, subject, now, sessionExpiresAt: now + 30_000 });
assert.equal(bounded.expiresAt, now + 30_000, 'grant cannot outlive login session');

const db = sqliteD1();
try {
  const owner = '111111111111111111';
  const repo = new AuthRepository(db, owner, () => now);
  await repo.loginUser({ id: owner, username: 'owner' });
  const token = await repo.issueSession(owner, 'userscript');
  const handler = createAuthHandler({ aiCapability: { signingKey: key, buildId }, now: () => now });
  const env = { AUTH_DB: db, HEX_OWNER_DISCORD_ID: owner };
  const issue = (authorization) => handler(new Request('https://hex.test/api/auth/ai-capability', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: '{}',
  }), env);
  assert.equal((await issue(null)).status, 401);
  const response = await issue(`Bearer ${token}`);
  assert.equal(response.status, 200);
  const minted = await response.json();
  assert.ok(await verifyAICapability(minted.capability, { signingKey: key, buildId, now: now + 1000 }));
} finally { db.close(); }

console.log('issue-8750-ai-capability: PASS');
