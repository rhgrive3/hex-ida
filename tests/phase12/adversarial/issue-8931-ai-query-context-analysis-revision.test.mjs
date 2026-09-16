/*
 * Issue #8931 — first-party AnalysisQueryAPI owns a canonical analysis
 * identity (see `js/analysis/query/app-adapter.js::currentIdentity`). The AI
 * ObservationStore folds `context.analysisRevision` into its deterministic
 * binding key. If the first-party context omits any semantic identity
 * dimension, the outer AI cache can serve a stale result without re-invoking
 * AnalysisQueryAPI and silently bypass its snapshot-freshness authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexAIContext } from '../../../js/ai/ui/hex-context.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';
import { analysisBinding } from '../../../js/ai/tools/storage/observation-store.js';

function makeApp() {
  let gen = 1;
  let artifactVersions = { cfg: 1 };
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
    get analysisArtifactVersions() { return artifactVersions; },
    notes: { nameEntries: () => [] },
    workspace: { project: { id: 'proj-a', revision: 1, binary: { hash: 'abc' } } },
    analysisQueries: {
      async snapshot() {
        return {
          snapshotId: `snapshot-${String(gen)}-cfg${String(artifactVersions.cfg ?? 'none')}-p${String(app.workspace.project.revision)}`,
          binaryId: 'bin-shared',
          projectRevision: app.workspace.project.revision,
          analysisEpoch: gen,
          artifactVersions: { ...artifactVersions },
        };
      },
      async functions(_snapshot, _query, page) {
        app._functionCalls += 1;
        return {
          value: [{
            address: '0x1000',
            name: `fn-r${String(gen)}-cfg${String(artifactVersions.cfg ?? 'none')}-p${String(app.workspace.project.revision)}`,
          }],
          completeness: 'complete',
          page: { offset: page.offset || 0, returned: 1, total: 1, next: null },
        };
      },
      async binaryInfo() {
        return {
          value: { regions: [{ id: '.text', startAddress: '0x100', endAddress: '0x200' }] },
          completeness: 'complete',
        };
      },
      async search(_snapshot, criteria, page) {
        app._stringCalls += 1;
        return {
          value: [{
            address: '0x100',
            string: `s-r${String(gen)}-${String(criteria.query)}`,
          }],
          completeness: 'complete',
          page: { offset: page.offset || 0, returned: 1, total: 1, next: null },
        };
      },
    },
    _functionCalls: 0,
    _stringCalls: 0,
  };
  return {
    app,
    bumpEpoch: () => { gen += 1; },
    setEpoch: (value) => { gen = value; },
    setArtifactVersions: (value) => { artifactVersions = value; },
    setProjectRevision: (value) => { app.workspace.project.revision = value; },
  };
}

test('#8931: first-party query context exposes a live canonical analysis identity', () => {
  const { app, bumpEpoch, setArtifactVersions, setProjectRevision } = makeApp();
  const context = createHexAIContext(app);
  assert.equal(context.analysisAuthority, 'AnalysisQueryAPI', 'first-party query context fixture');

  const initial = context.analysisRevision;
  assert.match(initial, /^snapshot_/, 'revision is derived from the canonical AnalysisQueryAPI snapshot identity');

  bumpEpoch();
  const afterEpoch = context.analysisRevision;
  assert.notEqual(afterEpoch, initial, 'revision advances with backend.gen');

  setArtifactVersions({ cfg: 2 });
  const afterArtifact = context.analysisRevision;
  assert.notEqual(afterArtifact, afterEpoch, 'artifactVersions-only drift changes the cache authority');

  setProjectRevision(2);
  assert.notEqual(context.analysisRevision, afterArtifact, 'projectRevision drift follows QueryAPI identity semantics');
});

test('#8931: artifact-version key order does not create a false identity change', () => {
  const { app, setArtifactVersions } = makeApp();
  const context = createHexAIContext(app);
  setArtifactVersions({ cfg: 1, decompile: 2 });
  const a = context.analysisRevision;
  setArtifactVersions({ decompile: 2, cfg: 1 });
  assert.equal(context.analysisRevision, a, 'canonical identity must not depend on object insertion order');
});

test('#8931: analysisBinding is complete when the query context identity is present', () => {
  const { app } = makeApp();
  const context = createHexAIContext(app);
  const binding = analysisBinding(context);
  assert.match(binding.analysisRevision, /^snapshot_/, 'canonical query snapshot identity folds into the binding key');
  assert.equal(binding.missing.includes('analysisRevision'), false, 'analysisRevision must not be unresolved');
  assert.equal(binding.complete, true, 'first-party context must resolve a complete deterministic binding');
});

test('#8931: same canonical identity preserves deterministic cache hits', async () => {
  const { app } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  const first = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  const second = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 1, 'unchanged canonical identity must keep the existing deterministic cache hit');
  assert.equal(second.result.results[0].name, first.result.results[0].name);
});

test('#8931: identical tool call after analysis epoch advance misses the AI cache and re-queries', async () => {
  const { app, bumpEpoch } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  const first = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 1, 'first call must run through AnalysisQueryAPI');
  assert.match(first.result.results[0].name, /^fn-r1-cfg1-p1$/, 'epoch 1 result');

  bumpEpoch();
  const second = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 2,
    '#8931: after backend.gen advances, the AI cache must not serve a stale binding for the fresh QueryAPI epoch');
  assert.match(second.result.results[0].name, /^fn-r2-cfg1-p1$/, 'second call observes the advanced epoch');
});

test('#8931: artifactVersions-only drift misses the AI cache and re-queries', async () => {
  const { app, setArtifactVersions } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  const first = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.match(first.result.results[0].name, /cfg1/);
  setArtifactVersions({ cfg: 2 });
  const second = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 2,
    'artifactVersions are part of QueryAPI snapshot identity and must invalidate the outer deterministic cache');
  assert.match(second.result.results[0].name, /cfg2/);
});

test('#8931: projectRevision-only drift misses the AI cache and re-queries', async () => {
  const { app, setProjectRevision } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  setProjectRevision(2);
  const second = await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 2, 'projectRevision drift must follow QueryAPI currentIdentity semantics');
  assert.match(second.result.results[0].name, /-p2$/);
});

test('#8931: malformed generation cannot alias a prior numeric cache identity', () => {
  const { app, setEpoch } = makeApp();
  const context = createHexAIContext(app);
  const valid = analysisBinding(context);
  assert.equal(valid.complete, true);

  setEpoch('1');
  assert.throws(
    () => analysisBinding(context),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-epoch-invalid',
    'numeric 1 -> string "1" must fail closed instead of stringifying to the previous cache authority',
  );
});

test('#8931: malformed project generation follows QueryAPI fail-closed validation', () => {
  const { app, setProjectRevision } = makeApp();
  const context = createHexAIContext(app);
  setProjectRevision('1');
  assert.throws(
    () => analysisBinding(context),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-project-revision-invalid',
  );
});

test('#8931: malformed nested artifact version cannot alias a prior valid cache identity', () => {
  const { app, setArtifactVersions } = makeApp();
  const context = createHexAIContext(app);
  setArtifactVersions({ cfg: {} });
  const valid = analysisBinding(context);
  assert.equal(valid.complete, true);

  // A hand-rolled enumerable-key serializer maps Date to {}, which would alias
  // the preceding valid object and let the outer cache hide the invalid live
  // QueryAPI identity. Canonical snapshot normalization rejects it instead.
  setArtifactVersions({ cfg: new Date(0) });
  assert.throws(
    () => analysisBinding(context),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-artifact-version-value-invalid',
  );
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

test('#8931: one canonical revision authority invalidates every query-backed tool family', async () => {
  const { app, bumpEpoch } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  const stringsFirst = await registry.execute('search_strings', { query: 'str', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 1, 'function search ran through AnalysisQueryAPI');
  assert.equal(app._stringCalls, 1, 'string search ran through AnalysisQueryAPI');
  assert.match(JSON.stringify(stringsFirst.result), /s-r1-str/, 'epoch 1 string result');

  await registry.execute('search_strings', { query: 'str', limit: 10 }, { scope: 'project' });
  assert.equal(app._stringCalls, 1, 'unchanged identity keeps the deterministic cache hit for strings too');

  bumpEpoch();
  await registry.execute('search_strings', { query: 'str', limit: 10 }, { scope: 'project' });
  assert.equal(app._stringCalls, 2,
    '#8931: the analysis epoch advance must invalidate the outer cache of every query-backed tool, not only search_functions');
  const stringsSecond = await registry.execute('search_strings', { query: 'str', limit: 10 }, { scope: 'project' });
  assert.equal(app._stringCalls, 2, 'the epoch-2 result is then cached again under the fresh binding');
  assert.match(JSON.stringify(stringsSecond.result), /s-r2-str/, 'epoch 2 string result replaces the stale one');

  await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 2,
    'both families share one canonical binding: one epoch advance re-queries each family exactly once');
});

test('#8931: session bookkeeping churn does not invalidate the analysis cache (#6252)', async () => {
  const { app } = makeApp();
  const context = createHexAIContext(app);
  const registry = createHexToolRegistry(context);

  const before = context.analysisRevision;
  await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });

  app.workspace.project.sessionLastOpenedAt = '2026-09-15T18:00:00.000Z';
  app.workspace.project.updatedAt = '2026-09-15T18:00:01.000Z';
  app.notes.nameEntries = () => [{ address: '0x1000', name: 'renamed-during-session' }];

  assert.equal(context.analysisRevision, before,
    '#6252: session timestamps and note bookkeeping are not analysis identity dimensions');
  await registry.execute('search_functions', { query: 'fn', limit: 10 }, { scope: 'project' });
  assert.equal(app._functionCalls, 1,
    '#6252: AI session bookkeeping alone must not force the semantic cache to re-query AnalysisQueryAPI');
});
