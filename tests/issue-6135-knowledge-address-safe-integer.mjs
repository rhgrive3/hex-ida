import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeDB } from '../js/knowledge/index.js';

function freshDb() {
  return new KnowledgeDB({ indexedDB: null, memory: new Map(), negativeMemory: new Map() });
}

test('#6135 unsafe number addresses fail closed in reject()', async () => {
  const db = freshDb();
  await assert.rejects(
    () => db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate', address: Number.MAX_SAFE_INTEGER + 1, reason: 'r' }),
    /address number must be a safe integer/,
  );
});

test('#6135 fractional/NaN/Infinity number addresses fail closed', async () => {
  const db = freshDb();
  for (const bad of [1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate', address: bad, reason: 'r' }),
      /address number must be a safe integer/,
      `address ${String(bad)} must be rejected`,
    );
  }
});

test('#6135 safe integer, bigint, and integer string addresses keep working', async () => {
  const db = freshDb();
  const safe = await db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate', address: 0x1000, reason: 'r' });
  assert.equal(safe.targetAddress, '1000');
  const big = await db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate2', address: 0x20000000000001n, reason: 'r' });
  assert.equal(big.targetAddress, '20000000000001');
  const text = await db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate3', address: '0x3000', reason: 'r' });
  assert.equal(text.targetAddress, '3000');
});

test('#6135 bigint addresses above 2^53 keep distinct negative identities', async () => {
  const db = freshDb();
  const a = await db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate', address: 0x20000000000000n, reason: 'reject-a' });
  const b = await db.reject({ sourceBinaryHash: 'bin', candidateName: 'candidate', address: 0x20000000000001n, reason: 'reject-b' });
  assert.notEqual(a.id, b.id, 'distinct large addresses must not collide');
  assert.notEqual(a.targetAddress, b.targetAddress);
});

test('#6135 remember() rejects unsafe numeric addresses instead of colliding', async () => {
  const db = freshDb();
  await assert.rejects(
    () => db.remember({ sourceBinaryHash: 'bin', name: 'fn', address: Number.MAX_SAFE_INTEGER + 1, kind: 'function', confidence: 1 }),
    /address number must be a safe integer/,
  );
});

test('#6135 nested unsafe fingerprint addresses fail before remember hashing', async () => {
  const db = freshDb();
  await assert.rejects(
    () => db.remember({
      sourceBinaryHash: 'bin',
      fingerprint: { address: Number.MAX_SAFE_INTEGER + 1, name: 'fn', instructions: [] },
    }),
    /address number must be a safe integer/,
  );
});

test('#6135 nested unsafe fingerprint addresses fail before reject hashing', async () => {
  const db = freshDb();
  await assert.rejects(
    () => db.reject({
      sourceBinaryHash: 'bin',
      candidateName: 'candidate',
      fingerprint: { address: Number.MAX_SAFE_INTEGER + 1, name: 'fn', instructions: [] },
      reason: 'r',
    }),
    /address number must be a safe integer/,
  );
});
