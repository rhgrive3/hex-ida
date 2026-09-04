import assert from 'node:assert/strict';
import test from 'node:test';
import { VariableInstructionIndex } from '../js/viewer/variable-instruction-index.js';

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function instrAt(start) {
  return {
    instructions: [
      { address: start, length: 1, bytes: new Uint8Array([0x90]), mnemonic: 'nop', opStr: '' },
    ],
    bytesRead: 32,
  };
}

function createIndex({ pendingB } = {}) {
  const calls = [];
  const disassembleAt = async (start, opts) => {
    calls.push(start);
    if (pendingB && start === 0x1010n) {
      await pendingB.promise;
      return instrAt(start);
    }
    return instrAt(start);
  };
  const index = new VariableInstructionIndex({
    disassembleAt,
    architecture: 'x86_64',
    pageBytes: 32,
    overlapBytes: 0,
    maxPages: 1,
    maxInstructions: 100,
    maxPrefetchPages: 1,
  });
  index.configureRegion({ id: 'r1', vmAddr: 0x1000n, size: 0x1000n });
  return { index, calls };
}

test('issue #6094 - prefetch then navigate join keeps protect', async () => {
  const pendingB = makeDeferred();
  const { index } = createIndex({ pendingB });
  const A = 0x1000n;
  const B = 0x1010n;

  // A as current page
  const pageA = await index.ensurePage(A, { protect: true });
  assert.ok(pageA.entries.length > 0);
  assert.equal(index.currentPageKey?.includes('1000'), true);

  // Start B as prefetch (protect:false), keep decoder pending
  const prefetchP = index.ensurePage(B, { priority: 'prefetch', protect: false });
  // Give the producer a tick to register inflight
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(index.inflight.size, 1);

  // Navigate joins the same inflight with protect:true
  const navigateP = index.ensurePage(B, { priority: 'current', protect: true });

  // Resolve decoder for B
  pendingB.resolve();
  const [prefetchPage, navigatePage] = await Promise.all([prefetchP, navigateP]);
  assert.equal(prefetchPage.entries[0].address, B);
  assert.equal(navigatePage.entries[0].address, B);

  // B must not be evicted; current page must be B
  const keys = Array.from(index.pages.keys());
  assert.ok(keys.some((k) => k.includes('1010')), `B should remain cached, got ${keys}`);
  assert.ok(index.currentPageKey?.includes('1010'), `currentPageKey should be B, got ${index.currentPageKey}`);
  const rows = index.localRows(B);
  assert.ok(rows.some((e) => e.address === B), 'localRows(B) should return B row');
});

test('issue #6094 - shared decode stays single-flight', async () => {
  const pendingB = makeDeferred();
  const { index, calls } = createIndex({ pendingB });
  const B = 0x1010n;
  await index.ensurePage(0x1000n, { protect: true });
  const p1 = index.ensurePage(B, { protect: false });
  await new Promise((r) => setTimeout(r, 0));
  const p2 = index.ensurePage(B, { protect: true });
  pendingB.resolve();
  await Promise.all([p1, p2]);
  const bCalls = calls.filter((c) => c === B);
  assert.equal(bCalls.length, 1, 'shared decode should happen once');
});

test('issue #6094 - prefetch alone does not promote to current', async () => {
  const { index } = createIndex({});
  const A = 0x1000n;
  const B = 0x1010n;
  await index.ensurePage(A, { protect: true });
  const before = index.currentPageKey;
  await index.ensurePage(B, { protect: false });
  // After prefetch with maxPages=1, one of A/B is evicted but current stays A
  // Prefetch must not promote B to current.
  assert.equal(index.currentPageKey, before);
});
