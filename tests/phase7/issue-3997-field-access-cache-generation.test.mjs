import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearFieldAccessArtifacts,
  fieldAccessRegion,
} from '../../js/analysis/field-access-artifact.js';

const REGION = Object.freeze({ id:'p0_s0' });

function result(addr = null) {
  return {
    results:addr == null ? [] : [{ addr, kind:'load' }],
    complete:true,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('field-access cache reuses entries within one backend generation', async (t) => {
  let calls = 0;
  const backend = {
    analysisEpoch:7,
    fieldAccess() {
      calls += 1;
      return Promise.resolve(result(0x1110n));
    },
  };
  t.after(() => clearFieldAccessArtifacts(backend));

  const first = await fieldAccessRegion(backend, REGION, 0x20, 8);
  const second = await fieldAccessRegion(backend, REGION, 0x20, 8);

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(second.results[0].addr, 0x1110n);
});

test('field-access cache does not reuse complete evidence across backend generations', async (t) => {
  let calls = 0;
  const backend = {
    analysisEpoch:0,
    fieldAccess() {
      calls += 1;
      return Promise.resolve(this.analysisEpoch === 0 ? result() : result(0x2220n));
    },
  };
  t.after(() => clearFieldAccessArtifacts(backend));

  const binaryA = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(binaryA.complete, true);
  assert.deepEqual(binaryA.results, []);
  assert.equal(calls, 1);

  backend.analysisEpoch = 1;
  const binaryB = await fieldAccessRegion(backend, REGION, 0x20, 8);

  assert.equal(calls, 2);
  assert.equal(binaryB.complete, true);
  assert.equal(binaryB.results[0].addr, 0x2220n);
});

test('field-access cache never reuses entries when analysisEpoch is missing or invalid', async (t) => {
  const cases = [
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ];

  for (const [label, analysisEpoch] of cases) {
    let calls = 0;
    const backend = {
      analysisEpoch,
      fieldAccess() {
        calls += 1;
        return Promise.resolve(result(BigInt(0x3000 + calls)));
      },
    };
    t.after(() => clearFieldAccessArtifacts(backend));

    const first = await fieldAccessRegion(backend, REGION, 0x20, 8);
    const second = await fieldAccessRegion(backend, REGION, 0x20, 8);

    assert.equal(calls, 2, label);
    assert.notEqual(first, second, label);
    assert.notEqual(first.results[0].addr, second.results[0].addr, label);
  }
});

test('invalid analysisEpoch clears prior reusable generation state', async (t) => {
  let calls = 0;
  let target = 0x1110n;
  const backend = {
    analysisEpoch:7,
    fieldAccess() {
      calls += 1;
      return Promise.resolve(result(target));
    },
  };
  t.after(() => clearFieldAccessArtifacts(backend));

  const first = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(first.results[0].addr, 0x1110n);

  backend.analysisEpoch = Number.NaN;
  target = 0x2220n;
  const invalid = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(invalid.results[0].addr, 0x2220n);

  backend.analysisEpoch = 7;
  target = 0x3330n;
  const restored = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(restored.results[0].addr, 0x3330n);
  assert.equal(calls, 3);
});

test('a pending old-generation request cannot poison the current-generation cache', async (t) => {
  const oldRequest = deferred();
  let calls = 0;
  const backend = {
    analysisEpoch:0,
    fieldAccess() {
      calls += 1;
      if (this.analysisEpoch === 0) return oldRequest.promise;
      return Promise.resolve(result(0x2220n));
    },
  };
  t.after(() => clearFieldAccessArtifacts(backend));

  const pendingA = fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(calls, 1);

  backend.analysisEpoch = 1;
  const binaryB = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(binaryB.results[0].addr, 0x2220n);
  assert.equal(calls, 2);

  oldRequest.resolve(result(0x1110n));
  const binaryA = await pendingA;
  assert.equal(binaryA.results[0].addr, 0x1110n);

  const cachedB = await fieldAccessRegion(backend, REGION, 0x20, 8);
  assert.equal(cachedB.results[0].addr, 0x2220n);
  assert.equal(calls, 2);
});
