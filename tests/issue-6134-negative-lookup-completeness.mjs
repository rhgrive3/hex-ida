import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeDB } from '../js/knowledge/index.js';

// IDB event model: requests succeed before readonly transaction completion.
// Both getAll and openCursor are provided so the baseline reaches its actual
// name-first 200-row bug rather than failing on an absent test-double method.
function persistent(records, failure = null) {
  const metrics = { visited: 0, getAll: 0, transactions: 0 };
  const knowledge = new KnowledgeDB({ indexedDB: {}, memory: new Map() });
  knowledge._db = { transaction() {
    metrics.transactions++;
    const tx = { error: null };
    const finish = () => setImmediate(() => {
      if (failure === 'transaction') { tx.error = new Error('read transaction aborted'); tx.onabort?.(); }
      else tx.oncomplete?.();
    });
    const requestAll = (values) => {
      const req = {};
      queueMicrotask(() => { req.result = values; req.onsuccess?.(); finish(); });
      return req;
    };
    tx.objectStore = () => ({
      indexNames: { contains: () => true },
      index(name) { return { getAll(value, count) {
        metrics.getAll++;
        return requestAll(records.filter((r) => r[name] === value).slice(0, count));
      } }; },
      openCursor() {
        const req = {}; let index = 0;
        const next = () => queueMicrotask(() => {
          if (failure === 'request') { req.error = new Error('cursor read failed'); req.onerror?.(); finish(); return; }
          let continued = false;
          req.result = index < records.length ? { value: records[index++], continue() { continued = true; next(); } } : null;
          if (req.result) metrics.visited++;
          req.onsuccess?.(); if (!continued) finish();
        });
        next(); return req;
      },
    });
    return tx;
  } };
  return { knowledge, metrics };
}
const filler = (n = 230) => Array.from({ length: n }, (_, i) => ({
  id: `a-${String(i).padStart(4, '0')}`, candidateName: 'common', candidateIdentity: `other-${i}`,
  sourceBinaryHash: 'bin', targetAddress: i.toString(16),
}));
const target = (patch = {}) => ({ id: 'z-target', candidateName: 'common', candidateIdentity: 'target', sourceBinaryHash: 'bin', targetAddress: '1000', ...patch });
const query = { candidateName: 'common', candidateIdentity: 'target', sourceBinaryHash: 'bin', address: 0x1000n };

for (const size of [201, 1300]) test(`#6134 persistent negatives after ${size} same-name records match memory`, async () => {
  const records = [...filler(size), target()];
  const { knowledge, metrics } = persistent(records);
  const memory = new KnowledgeDB({ indexedDB: null, negativeMemory: new Map(records.map((r) => [r.id, r])) });
  assert.equal(await knowledge.isRejected(query), true);
  assert.equal(await memory.isRejected(query), true);
  assert.equal(metrics.visited, size + 1); assert.equal(metrics.getAll, 0);
  assert.equal(await knowledge.isRejected({ ...query, address: 0x2000n }), false);
});

test('#6134 neither identity cardinality nor name-only records are silently capped', async () => {
  const records = filler(250).map((r) => ({ ...r, candidateIdentity: 'target' }));
  for (const tail of [target(), target({ candidateIdentity: null }), target({ candidateName: null })]) {
    assert.equal(await persistent([...records, tail]).knowledge.isRejected(query), true);
  }
});

test('#6134 mismatch does not reject, read errors do not masquerade as absence', async () => {
  assert.equal(await persistent([target({ candidateIdentity: 'foreign' })]).knowledge.isRejected(query), false);
  assert.equal(await persistent([target({ sourceBinaryHash: 'other-bin' })]).knowledge.isRejected(query), false);
  for (const failure of ['request', 'transaction']) {
    await assert.rejects(persistent([target()], failure).knowledge.isRejected(query), /failed|aborted/);
  }
});

test('#6134 cursor short-circuits and retains no full result array', async () => {
  const { knowledge, metrics } = persistent([target(), ...filler(250)]);
  assert.equal(await knowledge.isRejected(query), true);
  assert.equal(metrics.visited, 1); assert.equal(metrics.getAll, 0);
});

test('#6134 findMatches and query honor later identity and wildcard fingerprint rejection', async () => {
  const fingerprint = { address: 0x1000n, bytes: Uint8Array.of(0xc3, 1, 2, 3), name: 'common', strings: [], imports: [] };
  const seed = new KnowledgeDB({ indexedDB: null });
  const remembered = await seed.remember({ fingerprint, name: 'common', confirmation: 'user-confirmed' });
  await seed.reject({ id: 'z-target', candidateName: 'common', candidateIdentity: remembered.identityKey, fingerprint });
  const { knowledge } = persistent([...filler(), ...seed.negativeMemory.values()]);
  knowledge.memory = seed.memory;
  assert.equal((await knowledge.findMatches(fingerprint)).length, 0);
  const results = await knowledge.query('common', [fingerprint]);
  assert.ok(results.every((r) => !r.knowledge), 'text-only match is not rejected knowledge');
  const wildcard = persistent([{ ...[...seed.negativeMemory.values()][0], candidateName: null, candidateIdentity: null }]).knowledge;
  assert.equal(await wildcard.isRejected({ fingerprint }), true);
});
