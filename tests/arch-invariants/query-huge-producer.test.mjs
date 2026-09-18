/*
 * Invariant 2 — the public decompile query must survive a huge internal
 * producer.
 *
 * The query owns the product surface (pseudocode, lines, canonical
 * presentation provenance) and must publish it as an immutable, detached value
 * even when the internal producer state is large and deep. It is explicitly
 * NOT required to publish that internal graph; only to keep answering the
 * public question.
 *
 * The presentation field name is not chosen here. `decompilerSnapshot()` is the
 * shared public presentation projection for both production analysis routes and
 * it publishes `renderProvenance`; the production navigation, UI and validation
 * consumers read that same field. The first test re-derives the field name from
 * that projection so the assertion tracks the production contract instead of a
 * test-local schema.
 *
 * Fixture: synthetic product text plus a large/deep IR-like state (no benchmark
 * input, no captured payload).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../js/analysis/query/index.js';
import { decompilerSnapshot } from '../../js/analysis/semantic-function-base.js';
import { validateRenderProvenance } from '../../js/decompiler/phase8/render-provenance.js';
import { createDecompilerNavigation } from '../../js/ui/decompiler-provenance.js';
import {
  HUGE_LINE_COUNT,
  HUGE_PSEUDOCODE,
  HUGE_RENDER_PROVENANCE,
  hugeDecompilerProducer,
  hugeProducedLines,
} from './invariant-fixtures.mjs';

const FUNCTION_ID = '0x1000';
const QUERY_TIMEOUT_MS = 30_000;

// The internal fixture chains 20000 expression levels. The public query may
// publish a bounded view of that state, but it must not hand the deep chain to
// consumers; this budget is generous compared with any real presentation value
// and far below the internal depth.
const PUBLISHED_DEPTH_BUDGET = 512;

function apiFor(producer) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-arch-invariant-huge', gen: 1 },
    async getDecompile() { return producer; },
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

function withTimeout(promise, label, ms = QUERY_TIMEOUT_MS) {
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Iterative on purpose: a recursive walk would itself die on the very state
// this invariant is about.
function publishedDepth(root) {
  let maximum = 0;
  const seen = new WeakSet();
  const stack = [[root, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node == null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (depth > maximum) maximum = depth;
    if (depth > PUBLISHED_DEPTH_BUDGET) return depth;
    for (const key of Object.keys(node)) stack.push([node[key], depth + 1]);
  }
  return maximum;
}

test('public decompile query completes on a huge internal producer and keeps the canonical presentation surface', async () => {
  const expectedLines = hugeProducedLines();
  const producer = hugeDecompilerProducer();
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  // Contract oracle, not an assumption: the shared public presentation
  // projection decides which fields the presentation surface carries, and it
  // publishes the render provenance map, not a generic `provenance` bag.
  const canonicalPresentation = decompilerSnapshot(producer);
  assert.equal(Object.hasOwn(canonicalPresentation, 'renderProvenance'), true,
    'the shared public presentation projection must publish renderProvenance');
  assert.equal(canonicalPresentation.pseudocode, HUGE_PSEUDOCODE);

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'public decompile query');

  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE, 'pseudocode must survive the projection');
  assert.equal(result.value.lines.length, HUGE_LINE_COUNT, 'every product line must survive the projection');
  assert.deepEqual(result.value.lines, expectedLines, 'product lines must be preserved verbatim');
  assert.deepEqual(result.value.renderProvenance, HUGE_RENDER_PROVENANCE,
    'the canonical presentation provenance must survive the projection');
  assert.equal(validateRenderProvenance(result.value.renderProvenance).state, 'complete',
    'the published provenance must still be a valid canonical navigation map');

  const navigation = createDecompilerNavigation(result, { currentSnapshot: () => api.snapshot() });
  assert.equal(navigation.available, true, 'the published result must still expose navigation');
  assert.equal((await navigation.checkSnapshot()).state, 'ready',
    'the published result must still pass the navigation snapshot check');
});

test('the huge-producer result is immutable, detached and is not the internal graph', async () => {
  const producer = hugeDecompilerProducer();
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'public decompile query');

  assert.equal(Object.isFrozen(result.value), true, 'the published value must be immutable');
  assert.equal(Object.isFrozen(result.value.lines), true, 'the published line list must be immutable');
  assert.equal(Object.isFrozen(result.value.lines[0]), true, 'the published line records must be immutable');
  assert.equal(Object.isFrozen(result.value.renderProvenance), true, 'the published provenance must be immutable');

  assert.notEqual(result.value, producer, 'the query must not hand back the producer-owned object');
  assert.notEqual(result.value.lines, producer.lines, 'the query must not hand back the producer-owned line list');

  const depth = publishedDepth(result.value);
  assert.ok(depth <= PUBLISHED_DEPTH_BUDGET,
    `the published value must not reproduce the deep internal graph (depth ${depth} exceeds ${PUBLISHED_DEPTH_BUDGET})`);

  producer.pseudocode = 'mutated after publication';
  producer.lines.push({ indent: 0, text: 'mutated after publication', address: 0n });
  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE, 'later producer mutation must not reach the published value');
  assert.equal(result.value.lines.length, HUGE_LINE_COUNT, 'later producer mutation must not resize the published lines');
});

test('control: a small normal decompile query keeps its product surface', async () => {
  const lines = hugeProducedLines(64);
  const producer = { pseudocode: HUGE_PSEUDOCODE, lines, renderProvenance: { ...HUGE_RENDER_PROVENANCE } };
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'small decompile query');

  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE);
  assert.deepEqual(result.value.lines, lines);
  assert.deepEqual(result.value.renderProvenance, HUGE_RENDER_PROVENANCE);
  assert.equal(Object.isFrozen(result.value), true);
});

test('control: an unrelated callback still fails closed', async () => {
  const producer = {
    pseudocode: HUGE_PSEUDOCODE,
    lines: hugeProducedLines(4),
    renderProvenance: { ...HUGE_RENDER_PROVENANCE },
    metadata: { resolver: () => 'callbacks are never query values' },
  };
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  await assert.rejects(
    withTimeout(api.decompile(snapshot, FUNCTION_ID), 'fail-closed decompile query'),
    /analysis-query-value-unclonable/,
    'a runtime callback outside the known decompiler sidecar must stay a hard error',
  );
});

test('control: a huge producer does not turn fail-closed into a silent success', async () => {
  const producer = hugeDecompilerProducer({ unrelatedCallback: true });
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  await assert.rejects(
    withTimeout(api.decompile(snapshot, FUNCTION_ID), 'huge fail-closed decompile query'),
    /analysis-query-value-unclonable/,
    'surviving a huge producer must not weaken the unrelated-callback fail-closed rule',
  );
});
