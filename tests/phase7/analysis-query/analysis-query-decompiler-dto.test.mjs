import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { decompile } from '../../../js/decompile.js';
import { buildSemanticModel } from '../../../js/blocks.js';

// The decompile query DTO contract:
//
//   * only the explicit presentation schema is published, so the result is
//     bounded by presentation data instead of the internal analysis graph;
//   * the internal graph (semantic IR, ctx observers, high variables, cAst,
//     phase8) is producer-owned and never crosses the query boundary — raw IR
//     is served by the dedicated semanticIR() query;
//   * anything outside the schema that carries an unclonable value still fails
//     closed instead of being silently dropped.
//
// These tests replace the previous shallow-copy/deny-list behaviour, which
// overflowed structuredClone() on large functions while leaving the graph in
// the published result.

function apiFor(value) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-decompiler-dto', gen: 1 },
    async getDecompile() { return value; },
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

async function run(value) {
  const api = apiFor(value);
  return api.decompile(await api.snapshot(), '0x1000');
}

function deepChain(depth) {
  let node = { id: 'leaf', op: 'const' };
  for (let index = 0; index < depth; index++) node = { id: `n${index}`, op: 'add', left: node, right: { id: `r${index}` } };
  return node;
}

function presentation() {
  return {
    pseudocode: 'int f(void) { return 1; }',
    lines: [{ kind: 'return', indent: 0, text: 'return 1;', row: 0, addr: 0 }],
    renderProvenance: { snapshotId: 'render-1', completeness: 'complete', reverse: { 'addr:0': ['L0:return'] }, entities: {}, ledger: [] },
  };
}

// A. Small normal result: presentation fields are preserved and immutable.
test('A. decompile query preserves presentation fields as an immutable detached snapshot', async () => {
  const producer = presentation();
  const result = await run(producer);

  assert.equal(result.completeness, 'complete');
  assert.equal(result.value.pseudocode, producer.pseudocode);
  assert.deepEqual(result.value.lines, producer.lines);
  assert.deepEqual(result.value.renderProvenance, producer.renderProvenance);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.lines), true);
  assert.equal(Object.isFrozen(result.value.renderProvenance), true);
  assert.notEqual(result.value.lines, producer.lines);
  assert.notEqual(result.value.renderProvenance, producer.renderProvenance);
});

// B. Large synthetic producer: the scale that overflows the clone envelope
// before the fix must publish a bounded presentation result afterwards.
test('B. large internal producers no longer overflow the clone envelope and publish a bounded result', async () => {
  // The published DTO must not carry the graph, so this depth only has to be
  // deep enough that structuredClone() cannot detach it directly.
  const detached = { values: deepChain(50_000) };
  assert.throws(() => structuredClone(detached), RangeError,
    'the raw producer graph is not clone-safe at this scale');

  const build = (depth) => ({
    ...presentation(),
    ir: { values: deepChain(depth), provenance: { source: 'semantic-ir/v2' }, defUse: () => new Map() },
    highVariables: { valueToGroup: new Map(), groups: [] },
    ctx: { values: { at: () => null, defAt: () => null }, rowOfAddress: () => 0, unknownInstructions: 7 },
  });

  const large = await run(build(50_000));
  assert.equal(large.value.pseudocode, presentation().pseudocode);
  assert.deepEqual(large.value.lines, presentation().lines);
  assert.equal(large.value.unknownInstructions, 7);
  for (const key of ['ir', 'highVariables', 'ctx']) assert.equal(Object.hasOwn(large.value, key), false, key);

  // Bounded: published size is a function of presentation data only, so it does
  // not grow with the internal analysis graph.
  const small = await run(build(2_000));
  const largeSize = JSON.stringify(large.value).length;
  assert.equal(largeSize, JSON.stringify(small.value).length, 'output size is independent of internal graph size');
  assert.ok(largeSize < 4096, `bounded result, got ${largeSize} bytes`);
});

// C. Unrelated callbacks stay fail-closed, and non-schema fields are not published.
test('C. unrelated unclonable metadata still fails closed and non-schema fields stay unpublished', async () => {
  await assert.rejects(
    run({ pseudocode: 'int f(void) { return 1; }', metadata: { callback: () => 'must remain fail-closed' } }),
    /analysis-query-value-unclonable/,
  );

  const safe = await run({ pseudocode: 'int f(void) { return 1; }', metadata: { note: 'clone-safe, not part of the schema' } });
  assert.equal(safe.value.pseudocode, 'int f(void) { return 1; }');
  assert.equal(Object.hasOwn(safe.value, 'metadata'), false);
});

// D. The real legacy decompiler result keeps its navigation/provenance behaviour.
test('D. legacy decompiler results stay navigable through the query boundary', async () => {
  const rows = [{ row: 0, address: 0x1000n, mn: 'mov', ops: 'w0, #7' }, { row: 1, address: 0x1004n, mn: 'ret', ops: '' }];
  const model = buildSemanticModel(rows, { startRow: 0, endRow: 1, rowOfAddress: (address) => Number((address - 0x1000n) / 4n), name: 'return_seven' });
  const direct = decompile(model, { addr: 0x1000n, name: 'return_seven' });
  assert.ok(direct.ir && direct.ctx, 'fixture crosses the real internal result boundary');

  const api = new AnalysisQueryAPI({
    ...createAppAnalysisQueryAdapter({ getDecompile: async () => direct }),
    currentIdentity: async () => ({ binaryId: 'dto-navigation', projectRevision: 1, analysisEpoch: 1, artifactVersions: {} }),
  });
  const query = await api.decompile(await api.snapshot(), '0x1000');

  assert.equal(Object.hasOwn(query.value, 'ir'), false);
  assert.equal(Object.hasOwn(query.value, 'ctx'), false);
  assert.deepEqual(query.value.renderProvenance, direct.renderProvenance);
  assert.notEqual(query.value.renderProvenance, direct.renderProvenance);

  const navigation = createDecompilerNavigation(query, { currentSnapshot: () => api.snapshot() });
  assert.equal(navigation.available, true, navigation.reason);
  const line = query.value.lines.findIndex((entry) => /return/.test(entry.text));
  assert.ok(line >= 0, 'rendered lines are published');
  assert.equal((await navigation.selectLine(line)).state, 'ready');
});
