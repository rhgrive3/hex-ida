import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';
import {
  DECOMPILE_DTO_SCHEMA,
  DECOMPILE_INTERNAL_FIELDS,
  DECOMPILE_PUBLIC_FIELDS,
} from '../../../js/analysis/query/app-adapter.js';

function apiFor(value) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-decompiler-projection', gen: 1 },
    async getDecompile() { return value; },
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

// The decompile query publishes an explicit presentation schema. The internal
// analysis graph used to be shallow-copied through with only a deny-list of
// callbacks removed, so a large function overflowed structuredClone() on the
// way out. Raw IR is owned by the dedicated semanticIR() query instead.
test('decompile query publishes the presentation schema and keeps the internal graph private', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    lines: [{ kind: 'return', indent: 0, text: 'return 1;', row: 0, addr: 0 }],
    renderProvenance: { snapshotId: 'render-1', completeness: 'complete', reverse: {}, entities: {}, ledger: [] },
    ctx: {
      unknownInstructions: 3,
      values: { at: () => new Map(), defAt: () => new Map() },
      rowOfAddress: () => 0,
      symbolFor: () => null,
    },
    ir: {
      values: [{ id: 'v0' }],
      provenance: { source: 'semantic-ir/v2' },
      defUse: () => new Map([['n0', []]]),
    },
    highVariables: { valueToGroup: new Map(), groups: [] },
    cAst: { body: [] },
    phase8: { published: true },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  // Product-critical presentation fields survive the boundary unchanged.
  assert.equal(result.value.pseudocode, producerValue.pseudocode);
  assert.deepEqual(result.value.lines, producerValue.lines);
  assert.deepEqual(result.value.renderProvenance, producerValue.renderProvenance);
  assert.equal(result.value.unknownInstructions, 3);
  assert.equal(Object.isFrozen(result.value), true);
  assert.notEqual(result.value.lines, producerValue.lines, 'the query keeps its own detached snapshot');

  // The internal analysis graph is never published; it is not part of the DTO.
  for (const key of ['ir', 'ctx', 'highVariables', 'cAst', 'phase8']) {
    assert.equal(Object.hasOwn(result.value, key), false, key);
    assert.equal(DECOMPILE_PUBLIC_FIELDS.includes(key), false, key);
    assert.equal(DECOMPILE_INTERNAL_FIELDS.includes(key), true, key);
  }
  assert.equal(DECOMPILE_DTO_SCHEMA, 'analysis-query-decompile-presentation-v1');

  // The producer's live observers stay owned by the producer.
  assert.equal(typeof producerValue.ir.defUse, 'function');
  assert.equal(typeof producerValue.ctx.rowOfAddress, 'function');
});

test('decompile query still rejects unrelated unclonable fields', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    ir: {
      nodes: [{ id: 'n0' }],
      defUse: () => new Map([['n0', []]]),
    },
    metadata: { callback: () => 'must remain fail-closed' },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();

  await assert.rejects(
    api.decompile(snapshot, '0x1000'),
    /analysis-query-value-unclonable/,
  );
  assert.equal(typeof producerValue.ir.defUse, 'function');
  assert.equal(typeof producerValue.metadata.callback, 'function');
});

// The semantic decompiler attaches a frozen control-render disposition to
// results whose rendering exercised control forms (the same producer-owned
// ledger family as semanticStatementRenderHistory). It is internal by
// contract: never published, never a completeness loss.
test('decompile query treats the control render history as internal, not drift', async () => {
  const producerValue = {
    pseudocode: 'int f(int x) { if (x) return 1; return 0; }',
    lines: [{ kind: 'if', indent: 0, text: 'if (x) {', row: 0, addr: 0 }],
    semanticControlRenderHistory: Object.freeze({
      scope: 'initial-control-render-producer',
      completeness: 'complete',
      reasons: Object.freeze([]),
    }),
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.reason ?? null, null);
  assert.equal(result.value.pseudocode, producerValue.pseudocode);
  assert.deepEqual(result.value.lines, producerValue.lines);
  assert.equal(Object.hasOwn(result.value, 'semanticControlRenderHistory'), false);
  assert.equal(DECOMPILE_INTERNAL_FIELDS.includes('semanticControlRenderHistory'), true);
  assert.equal(DECOMPILE_PUBLIC_FIELDS.includes('semanticControlRenderHistory'), false);
});

test('decompile query still reports a near-miss control history name as drift', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    semanticControlRenderHistories: { scope: 'typo-guard' },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'decompile-projection-schema-drift');
  assert.deepEqual(result.status.projection.unexpected, ['semanticControlRenderHistories']);
  assert.equal(result.value.pseudocode, producerValue.pseudocode);
  assert.equal(Object.hasOwn(result.value, 'semanticControlRenderHistories'), false);
});

test('decompile query keeps an ordinary pseudocode-only result complete', async () => {
  const producerValue = { pseudocode: 'int f(void) { return 1; }' };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.value.pseudocode, producerValue.pseudocode);
});

test('decompile query still rejects an unclonable unknown field after the history allowlist', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    semanticControlRenderHistory: Object.freeze({
      scope: 'initial-control-render-producer',
      completeness: 'complete',
      reasons: Object.freeze([]),
    }),
    extra: { callback: () => 'must remain fail-closed' },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();

  await assert.rejects(
    api.decompile(snapshot, '0x1000'),
    /analysis-query-value-unclonable/,
  );
});

test('decompile query treats a case-variant history name as drift, not internal', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    SemanticControlRenderHistory: { scope: 'case-guard' },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'decompile-projection-schema-drift');
});
