import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mintAICapability, verifyAICapability } from '../../js/auth/server/ai-capability.js';
import { signRuntimeSession, verifyRuntimeSession } from '../../js/userscript/runtime-security.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// A 32-byte HMAC is 43 Base64URL characters; the last one carries two unused
// bits. Flipping them gives a second spelling that decodes to the same bytes.
function alternateSpelling(token) {
  const [body, sig] = token.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(sig.at(-1));
  assert.equal(last & 3, 0, 'canonical encoding keeps unused bits zero');
  return `${body}.${sig.slice(0, -1)}${alphabet[last | 1]}`;
}

const key = new Uint8Array(32).fill(9);
const buildId = `${'a'.repeat(24)}.${'b'.repeat(24)}`;
const now = 1_700_000_000_000;

test('AI capability accepts only the canonical signature spelling', async () => {
  const { capability } = await mintAICapability({ signingKey: key, buildId, subject: 'c'.repeat(64), now });
  assert.ok(await verifyAICapability(capability, { signingKey: key, buildId, now: now + 1000 }));
  assert.equal(await verifyAICapability(alternateSpelling(capability), { signingKey: key, buildId, now: now + 1000 }), null);
});

test('runtime session accepts only the canonical signature spelling', async () => {
  const token = await signRuntimeSession({ v: 1, sid: 's'.repeat(16), bid: 'b'.repeat(16), rid: 'r'.repeat(16), exp: Math.floor(now / 1000) + 60 }, key);
  assert.ok(await verifyRuntimeSession(token, key, { now }));
  assert.equal(await verifyRuntimeSession(alternateSpelling(token), key, { now }), null);
});
