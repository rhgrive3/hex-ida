import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-adapter.js';

function appWith(overrides = {}) {
  const state = new Map([
    ['architecture', 'arm64'],
    ['capability', { architecture:'arm64', semanticVersion:'v1', instructionAlignment:4 }],
    ['instructionAlignment', 4],
    ['sliceIndex', 0],
  ]);
  const app = {
    backend: { binaryId:'bin-4231', gen:1, analysisRoute:'legacy' },
    symbols: { gen:1 },
    store: {
      get(key) { return state.get(key); },
      set(key, value) { state.set(key, value); },
    },
  };
  Object.assign(app, overrides);
  return { app, state };
}

function cycle(label) {
  const value = { label };
  value.self = value;
  return value;
}

async function snapshotFor(setup) {
  const { app, state } = appWith();
  setup?.(app, state);
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  return api.snapshot();
}

test('#4231 cyclic architecture identity fails closed instead of collapsing', async () => {
  await assert.rejects(
    snapshotFor((_app, state) => state.set('architecture', cycle('arm64-a'))),
    /analysis-query-artifact-identity-dimension-invalid/,
  );
  await assert.rejects(
    snapshotFor((_app, state) => state.set('architecture', cycle('x86-b'))),
    /analysis-query-artifact-identity-dimension-invalid/,
  );
});

test('#4231 cyclic route and capability identity fail closed independently', async () => {
  await assert.rejects(
    snapshotFor((app) => { app.backend.analysisRoute = cycle('route'); }),
    /analysis-query-artifact-identity-dimension-invalid/,
  );
  await assert.rejects(
    snapshotFor((_app, state) => state.set('capability', {
      architecture:'arm64', semanticVersion:cycle('contract'), instructionAlignment:4,
    })),
    /analysis-query-artifact-identity-dimension-invalid/,
  );
});

test('#4231 valid structured dimensions remain content-addressed and distinct', async () => {
  const first = await snapshotFor((_app, state) => state.set('architecture', { family:'arm', bits:64 }));
  const second = await snapshotFor((_app, state) => state.set('architecture', { family:'x86', bits:64 }));
  assert.notEqual(first.artifactVersions.architecture, second.artifactVersions.architecture);
  assert.notEqual(first.snapshotId, second.snapshotId);
});

test('#4231 primitive type identity remains non-coercing', async () => {
  const stringValue = await snapshotFor((_app, state) => state.set('sliceIndex', '1'));
  const numberValue = await snapshotFor((_app, state) => state.set('sliceIndex', 1));
  assert.notEqual(stringValue.artifactVersions.sliceIndex, numberValue.artifactVersions.sliceIndex);
  assert.notEqual(stringValue.snapshotId, numberValue.snapshotId);
});

test('#4231 canonicalization exceptions are not converted into a shared opaque identity', async () => {
  const cause = new Error('identity-getter-boom');
  const throwing = {};
  Object.defineProperty(throwing, 'value', {
    enumerable:true,
    get() { throw cause; },
  });
  await assert.rejects(
    snapshotFor((_app, state) => state.set('architecture', throwing)),
    (error) => error instanceof TypeError
      && error.message === 'analysis-query-artifact-identity-dimension-invalid'
      && error.cause === cause,
  );

  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('identity-ownkeys-boom'); },
  });
  await assert.rejects(
    snapshotFor((_app, state) => state.set('architecture', hostile)),
    /analysis-query-artifact-identity-dimension-invalid/,
  );

  const recursiveMap = new Map();
  recursiveMap.set('self', recursiveMap);
  await assert.rejects(
    snapshotFor((_app, state) => state.set('architecture', recursiveMap)),
    /analysis-query-artifact-identity-dimension-invalid/,
  );
});
