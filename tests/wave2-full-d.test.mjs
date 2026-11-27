import test from 'node:test';
import assert from 'node:assert/strict';

import { queryPortableChecks } from '../js/analysis/query/semantic/portable-checks.js';
import { ScopedAnalysisWork } from '../js/core/budgets/scoped-work.js';
import { createCxxEvidenceCache } from '../js/analysis/cxx/rtti-evidence.js';
import { createCxxEvidenceProvider } from '../js/analysis/cxx/project.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('portable-checks: readRange receives request as 1st arg and { signal } as 2nd arg', async () => {
  const controller = new AbortController();
  const work = new ScopedAnalysisWork({ signal: controller.signal });
  const world = { id: 'world-1', profile: 'arm64-elf-v1' };
  const assumptions = { id: 'assumptions-1' };
  const snapshotId = 'snap-1';

  const row0 = {
    id: 'row-0',
    owner: 'semantic-ir',
    kind: 'other',
    origin: {
      byteRanges: [{ binaryId: 'bin-1', start: '0', end: '4' }],
      virtualRanges: [{ start: '4096', end: '4100' }],
    },
  };
  const row1 = {
    id: 'row-1',
    owner: 'semantic-ir',
    kind: 'state-read',
    variable: { physicalIdentity: { kind: 'register', registerId: 'x0' } },
    outputs: ['val-1'],
    origin: {
      byteRanges: [{ binaryId: 'bin-1', start: '4', end: '8' }],
      virtualRanges: [{ start: '4100', end: '4104' }],
    },
  };
  const rows = [row0, row1];
  let released = false;
  const projection = {
    functionId: 'fn-1',
    size: rows.length,
    inputIdentity: {
      binaryId: 'bin-1',
      snapshotId,
      producerArtifactId: 'prod-1',
      sourceLocation: { snapshotId, start: '4096', end: '4112' },
    },
    recordAt(i) { return rows[i]; },
    present(id) { return rows.find(r => r.id === id); },
    source(id) { return rows.find(r => r.id === id); },
    release() { released = true; },
  };
  const demand = {
    status: 'completed',
    ranges: {
      values: [{
        localId: 'loc-1',
        conditionalOn: [],
        fact: {
          bits: 64,
          range: { kind: 'interval', lower: '1', upper: '1' },
          knownOne: '1',
          knownZero: '0',
          constant: { value: '1' },
        },
      }],
      bindings: [{
        localId: 'loc-1',
        bits: 64,
        semanticValueId: 'val-1',
      }],
    },
  };

  const calls = [];
  const readRange = async (request, options) => {
    calls.push({ request, options });
    return {
      worldId: request.worldId,
      binaryId: request.binaryId,
      offset: String(request.offset),
      // movz x0, #1 -> 0x20, 0x00, 0x80, 0xd2
      bytes: new Uint8Array([0x20, 0x00, 0x80, 0xd2]),
    };
  };

  try {
    await queryPortableChecks(
      { functionId: 'fn-1', capsule: undefined },
      {
        world,
        assumptions,
        snapshotId,
        work,
        isCurrent: () => true,
        loadOwner: async () => ({ projection, demand }),
        readRange,
      },
    );
  } finally {
    work.dispose();
  }

  assert.equal(released, true);
  assert.equal(calls.length, 1);
  const [{ request, options }] = calls;
  assert.deepEqual(request, {
    worldId: 'world-1',
    binaryId: 'bin-1',
    offset: '0',
    length: 4,
  });
  assert.equal('signal' in request, false, 'signal must not be inside 1st request argument');
  assert.ok(options && typeof options === 'object', '2nd options argument must be passed');
  assert.ok(options.signal instanceof AbortSignal, 'options.signal must be an AbortSignal');
});

test('rtti-evidence: createCxxEvidenceCache evicts rejected promise and preserves newer entry on clear', async () => {
  const cache = createCxxEvidenceCache({ maxEntries: 4 });
  const symbols = { addrs: [0x1000n], names: ['_ZTV3Foo'] };

  // 1. Rejection evicts failed promise so subsequent get() retries cleanly.
  let failCalls = 0;
  await assert.rejects(
    cache.get({
      symbols,
      symbolSizeOf: () => {
        failCalls++;
        throw new Error('transient-size-failure');
      },
      read: async () => null,
    }, 'slice-1'),
    /transient-size-failure/,
  );
  assert.equal(failCalls, 1);
  assert.equal(cache.size(), 0, 'rejected promise must be deleted from cache');

  let okCalls = 0;
  const report = await cache.get({
    symbols,
    symbolSizeOf: () => {
      okCalls++;
      return 24;
    },
    read: async () => null,
  }, 'slice-1');
  assert.equal(okCalls, 1);
  assert.equal(cache.size(), 1);
  assert.equal(report.classes.length, 0);

  // 2. If clear() + new get() replaces the key while an older request is in flight,
  //    the older rejection must NOT delete the newer cache entry.
  cache.clear();
  const d1 = deferred();
  const d2 = deferred();

  const p1 = cache.get({
    symbols: { addrs: [0x1000n, 0x2000n], names: ['_ZTV3Foo', '_ZTV3Bar'] },
    symbolSizeOf: (addr) => {
      if (addr === 0x2000n) throw new Error('stale-failure');
      return 24;
    },
    read: () => d1.promise,
  }, 'slice-race');

  cache.clear();

  const p2 = cache.get({
    symbols,
    symbolSizeOf: () => 24,
    read: () => d2.promise,
  }, 'slice-race');

  // Unblock p1's first vtable read so it advances to 0x2000n and rejects asynchronously.
  d1.resolve(null);
  await assert.rejects(p1, /stale-failure/);
  assert.equal(cache.size(), 1, 'stale rejection must not evict newer entry under same key');

  d2.resolve(null);
  const r2 = await p2;
  assert.equal(r2.classes.length, 0);
  assert.equal(cache.size(), 1);
});

test('cxx/project: clear() during in-flight build() prevents stale index writeback and pending clobber', async () => {
  const symbols = { addrs: [0x2000n], names: ['_ZTV3Bar'] };
  const d1 = deferred();
  const d2 = deferred();
  let buildInvocation = 0;

  const provider = createCxxEvidenceProvider({
    symbols,
    symbolSizeOf: () => 24,
    read: () => {
      buildInvocation++;
      return buildInvocation === 1 ? d1.promise : d2.promise;
    },
  });

  // Start build #1 (in-flight).
  const p1 = provider.build();
  assert.equal(provider.stats().builds, 1);

  // Clear while build #1 is still in-flight.
  provider.clear();

  // Start build #2 (new epoch).
  const p2 = provider.build();
  assert.equal(provider.stats().builds, 2);

  // Resolve stale build #1 while build #2 is still pending.
  d1.resolve(null);
  await p1;

  // Stale build #1 must NOT mark provider ready or clear build #2's pending promise.
  assert.equal(provider.stats().ready, false, 'stale build must not restore index after clear()');
  assert.equal(provider.classEvidence(), null);

  // Calling build() again while build #2 is still pending must join build #2, not start build #3.
  const p2Joined = provider.build();
  assert.equal(provider.stats().builds, 2, 'stale build finally must not clobber active pending');

  // Resolve build #2.
  d2.resolve(null);
  const [idx2, idx2Joined] = await Promise.all([p2, p2Joined]);
  assert.equal(idx2, idx2Joined);
  assert.equal(provider.stats().ready, true);

  // Also verify clear() with no subsequent build() leaves provider unready after stale build resolves.
  const d3 = deferred();
  const provider2 = createCxxEvidenceProvider({
    symbols,
    symbolSizeOf: () => 24,
    read: () => d3.promise,
  });
  const p3 = provider2.build();
  provider2.clear();
  d3.resolve(null);
  await p3;
  assert.equal(provider2.stats().ready, false);
  assert.equal(provider2.classEvidence(), null);
});
