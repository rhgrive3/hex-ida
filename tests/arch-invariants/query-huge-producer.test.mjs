/*
 * Invariant 2 — the public decompile query must survive a huge internal
 * producer.
 *
 * The query owns the product surface (pseudocode, lines, provenance) and must
 * publish it as an immutable, detached value even when the internal producer
 * state is large and deep. It is explicitly NOT required to publish that
 * internal graph; only to keep answering the public question.
 *
 * Fixture: synthetic product text plus a large/deep IR-like state (no benchmark
 * input, no captured payload).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../js/analysis/query/index.js';
import {
  HUGE_LINE_COUNT,
  HUGE_PSEUDOCODE,
  HUGE_PROVENANCE,
  hugeDecompilerProducer,
  hugeProducedLines,
} from './invariant-fixtures.mjs';

const FUNCTION_ID = '0x1000';
const QUERY_TIMEOUT_MS = 30_000;

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

test('public decompile query completes on a huge internal producer and keeps pseudocode, lines and provenance', async () => {
  const expectedLines = hugeProducedLines();
  const producer = hugeDecompilerProducer();
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'public decompile query');

  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE, 'pseudocode must survive the projection');
  assert.equal(result.value.lines.length, HUGE_LINE_COUNT, 'every product line must survive the projection');
  assert.deepEqual(result.value.lines, expectedLines, 'product lines must be preserved verbatim');
  assert.deepEqual(result.value.provenance, HUGE_PROVENANCE,
    'product-critical provenance must survive the projection');
});

test('the huge-producer result is immutable and detached from the producer', async () => {
  const producer = hugeDecompilerProducer();
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'public decompile query');

  assert.equal(Object.isFrozen(result.value), true, 'the published value must be immutable');
  assert.equal(Object.isFrozen(result.value.lines), true, 'the published line list must be immutable');
  assert.equal(Object.isFrozen(result.value.lines[0]), true, 'the published line records must be immutable');
  assert.equal(Object.isFrozen(result.value.provenance), true, 'the published provenance must be immutable');

  assert.notEqual(result.value, producer, 'the query must not hand back the producer-owned object');
  assert.notEqual(result.value.lines, producer.lines, 'the query must not hand back the producer-owned line list');

  producer.pseudocode = 'mutated after publication';
  producer.lines.push({ indent: 0, text: 'mutated after publication', address: 0n });
  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE, 'later producer mutation must not reach the published value');
  assert.equal(result.value.lines.length, HUGE_LINE_COUNT, 'later producer mutation must not resize the published lines');
});

test('control: a small normal decompile query keeps its product surface', async () => {
  const lines = hugeProducedLines(64);
  const producer = { pseudocode: HUGE_PSEUDOCODE, lines, provenance: { ...HUGE_PROVENANCE } };
  const api = apiFor(producer);
  const snapshot = await api.snapshot();

  const result = await withTimeout(api.decompile(snapshot, FUNCTION_ID), 'small decompile query');

  assert.equal(result.value.pseudocode, HUGE_PSEUDOCODE);
  assert.deepEqual(result.value.lines, lines);
  assert.deepEqual(result.value.provenance, HUGE_PROVENANCE);
  assert.equal(Object.isFrozen(result.value), true);
});

test('control: an unrelated callback still fails closed', async () => {
  const producer = {
    pseudocode: HUGE_PSEUDOCODE,
    lines: hugeProducedLines(4),
    provenance: { ...HUGE_PROVENANCE },
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
