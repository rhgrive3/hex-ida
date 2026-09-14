/*
 * Issue #8931 — first-party AnalysisQueryAPI owns a canonical analysis epoch
 * (see `js/analysis/query/app-adapter.js::currentIdentity`). The AI
 * ObservationStore folds `context.analysisRevision` into its deterministic
 * binding key. If the first-party context never exposes the epoch, every
 * tool call in the same session resolves to `analysis:0` and the AI cache
 * keeps serving the previous epoch's result without ever re-invoking
 * AnalysisQueryAPI — silently bypassing its snapshot-freshness and
 * stale-retry authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexAIContext } from '../../../js/ai/ui/hex-context.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';
import { analysisBinding } from '../../../js/ai/tools/storage/observation-store.js';

function makeApp() {
  let gen = 1;
  const app = {
    store: {
      get(key) {
        return ({
          fileInfo: { name: 'a.bin' },
          sliceIndex: 0,
          architecture: 'arm64',
          canDisassemble: true,
          instructionAlignment: 4,
        })[key] ?? null;
      },
    },
    backend: {
      binaryId: 'bin-shared',
      contentHash: 'abc',
      get gen() { return gen; },
    },
    notes: { nameEntries: () => [] },
    workspace: { project: { id: 'proj-a', revision: 1, binary: { hash: 'abc' } } },
    analysisQueries: {
      async snapshot() {
        return {
          snapshotId: `snapshot-${gen}`,
          binaryId: 'bin-shared',
          projectRevision: 1,
          analysisEpoch: gen,
          artifactVersions: {},
        };
      },
      async functions(_snapshot, _query, page) {
        app._functionCalls += 1;
        return {
          value: [{ address: '0x1000', name: `fn-r${gen}` }],
          completeness: 'complete',
          page: { offset: page.offset || 0, returned: 1, total: 1, next: null },
        };
      },
    },
    _functionCalls: 0,
  };
  return { app, bumpEpoch: () => { gen += 1; } };
}

test('#8931: first-party query context exposes analysisRevision bound to backend.gen', () => {
  const { app, bumpEpoch } = makeApp();
  const context = createHexAIContext(app);
  assert.equal(context.analysisAuthority, 'AnalysisQueryAPI', 'first-party query context fixture');
  assert.equal(context.analysisRevision, 1, 'revision reflects the live backend epoch');
  bumpEpoch();
  assert.equal(context.analysisRevision, 2, 'revision advances with backend.gen (live getter)');
});

test('#8931: analysisBinding is complete when the query context is present', () => {
  const { app } = makeApp();
  const context = createHexAIContext(app);
  const binding = analysisBinding(context);
  assert.equal(binding.analysisRevision, '1', 'epoch 1 folds into the canonical binding key');
  assert.equal(binding.missing.includes('analysisRevision'), false, 'analysisRevision must not be unresolved');
  assert.equal(binding.complete, true, 'first-party context must resolve a complete deterministic binding');
});

test('#8931: identical tool call after analysis epoch advance misses the AI cache and re-queries', async () => {
  const { app, bumpEpoch } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  const first = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 1, 'first call must run through AnalysisQueryAPI');
  assert.match(first.result.results[0].name, /^fn-r1$/, 'epoch 1 result');

  bumpEpoch();
  const second = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 2,
    '#8931: after backend.gen advances, the AI cache must not serve a stale binding for the fresh QueryAPI epoch');
  assert.match(second.result.results[0].name, /^fn-r2$/, 'second call observes the advanced epoch');
});

test('#8931: without a live epoch the context stays explicit-unknown (not a shared authority)', () => {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-static', contentHash: 'abc' },
    notes: { nameEntries: () => [] },
    workspace: { project: { id: 'proj-static', revision: 1 } },
    analysisQueries: {
      async snapshot() { return { snapshotId: 's', binaryId: 'bin-static', projectRevision: 1, artifactVersions: {} }; },
      async functions() { return { value: [], completeness: 'complete', page: { offset: 0, returned: 0, total: 0, next: null } }; },
    },
  };
  const context = createHexAIContext(app);
  assert.equal(context.analysisRevision, null,
    'no backend.gen/analysisEpoch must surface as null so ObservationStore fails closed to unresolved identity');
  const binding = analysisBinding(context);
  assert.equal(binding.missing.includes('analysisRevision'), true,
    'unknown analysisRevision stays in the missing set; the per-context ephemeral nonce prevents cross-context sharing (#5887)');
});
