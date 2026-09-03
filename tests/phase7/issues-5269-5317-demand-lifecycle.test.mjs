import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

/**
 * Demand-driven shared-producer lifecycle: the region-scan registry must not
 * evict in-flight producers (#5269), and partial shape merges must not pin
 * the canonical shapes when a retry could upgrade them (#5317).
 */

test('#5269 in-flight region scans survive cache pressure', async () => {
  const count = 34;
  const regions = Array.from({ length: count }, (_, index) => ({
    id: `r${index}`, exec: true, size: 0x100n,
    vmAddr: BigInt(0x10000 + index * 0x100), section: '__text',
  }));
  const calls = new Map();
  const gates = new Map();
  const app = {
    backend: {
      gen: 0,
      binaryId: 'test-binary-5269',
      scanProgram: (regionId) => {
        calls.set(regionId, (calls.get(regionId) || 0) + 1);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        gates.set(regionId, release);
        const request = gate.then(() => ({ regionId }));
        request.cancel = () => {};
        return request;
      },
    },
    programRegions: () => regions,
    store: { get: () => null },
  };
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  const addressOf = (index) => 0x10000n + BigInt(index * 0x100);
  const pending = regions.map((region, index) =>
    app.analysisQueries.callers(snapshot, addressOf(index), {}, {}).then(
      () => ({ status: 'fulfilled' }),
      (error) => ({ status: 'rejected', error }),
    ));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.size, count, 'every region scan must be registered exactly once');
  // Re-request the first region while all producers are still in flight.
  const again = app.analysisQueries.callers(snapshot, addressOf(0), {}, {}).then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.get('r0'), 1, 'the in-flight producer must be shared, not duplicated');
  for (const release of gates.values()) release();
  const outcomes = await Promise.all([...pending, again]);
  assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'), 'all queries settle once gates release');
  assert.equal(calls.get('r0'), 1);
});

test('#5269 settled scan entries remain prunable', async () => {
  const regions = Array.from({ length: 40 }, (_, index) => ({
    id: `s${index}`, exec: true, size: 0x100n,
    vmAddr: BigInt(0x20000 + index * 0x100), section: '__text',
  }));
  const calls = new Map();
  const app = {
    backend: {
      gen: 0,
      binaryId: 'test-binary-5269b',
      scanProgram: (regionId) => {
        calls.set(regionId, (calls.get(regionId) || 0) + 1);
        const request = Promise.resolve({ regionId });
        request.cancel = () => {};
        return request;
      },
    },
    programRegions: () => regions,
    store: { get: () => null },
  };
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();
  // Settle 40 scans sequentially, then re-request the oldest: settled entries
  // past capacity are evicted, so the oldest rescans (no unbounded retention).
  for (let index = 0; index < regions.length; index++) {
    await app.analysisQueries.callers(snapshot, 0x20000n + BigInt(index * 0x100), {}, {});
  }
  await app.analysisQueries.callers(snapshot, 0x20000n, {}, {});
  assert.equal(calls.get('s0'), 2, 'settled entries past capacity are evicted and rescanned on demand');
});

test('#5317 transient shape failures are retried and upgrade', async () => {
  let bAttempts = 0;
  const shapeScan = (complete) => ({ count: 0, complete, capped: false, unsupported: false });
  const app = {
    backend: {
      gen: 0,
      valueShapes: (regionId) => {
        if (regionId === 'A') return Promise.resolve(shapeScan(true));
        bAttempts++;
        if (bAttempts === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve(shapeScan(true));
      },
    },
    programRegions: () => [
      { id: 'A', exec: true, size: 16n, vmAddr: 0x2000n },
      { id: 'B', exec: true, size: 16n, vmAddr: 0x3000n },
    ],
  };
  installDemandDrivenAnalysis(app);
  const first = await app.ensureShapes({});
  assert.equal(first.complete, false, 'the current consumer still receives the partial merge');
  assert.equal(bAttempts, 1);
  const second = await app.ensureShapes({});
  assert.notEqual(second, first, 'a partial merge must not pin the canonical shapes');
  assert.equal(bAttempts, 2, 'the failed region is rescanned');
  assert.equal(second.complete, true, 'the retry upgrades to complete');
  const third = await app.ensureShapes({});
  assert.equal(third, second, 'the complete merge is cached without rescanning');
  assert.equal(bAttempts, 2);
});
