import assert from 'node:assert/strict';
import test from 'node:test';

import { createPatternProducer } from '../../../js/analysis/discovery/producers.js';
import { DiscoveryProducerRegistry } from '../../../js/analysis/discovery/fusion.js';
import { functionCandidates } from '../../../js/analysis/index.js';

const CHECK_INTERVAL = 4096;

function countingCode(length, fill = 0) {
  const target = new Uint8Array(length).fill(fill);
  const state = { reads: 0 };
  const code = new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && /^[0-9]+$/.test(property)) state.reads += 1;
      return Reflect.get(object, property);
    },
  });
  return { code, state };
}

function pattern(overrides = {}) {
  return createPatternProducer({
    id: 'issue-4215-pattern',
    architectureId: 'arm64',
    alignment: 1,
    patterns: overrides.patterns ?? [{ id: 'prologue', bytes: [0xaa, 0xbb, 0xcc, 0xdd] }],
  });
}

function image(code, base = 0x1000n) {
  return { image: { codeBaseAddress: base, code } };
}

function registryWith(...producers) {
  const registry = new DiscoveryProducerRegistry();
  for (const producer of producers) registry.register(producer);
  return registry;
}

test('pattern scan charges byte comparisons to an explicit work budget', () => {
  const { code, state } = countingCode(1024 * 1024);
  const produced = pattern().produce(image(code), { budget: { maxPatternComparisons: 4096 } });

  assert.equal(Array.isArray(produced), false, 'a truncated scan must not look like a complete array');
  assert.equal(produced.truncated, true);
  assert.equal(produced.stopReason, 'budget-exhausted');
  assert.deepEqual(produced.evidence, []);
  assert.ok(state.reads <= 4096, `work must stay inside the budget, saw ${state.reads} byte reads`);
});

test('match-heavy input is bounded by an evidence emission cap', () => {
  const { code, state } = countingCode(256 * 1024, 0xaa);
  const produced = pattern({ patterns: [{ id: 'all', bytes: [0xaa] }] })
    .produce(image(code), { budget: { maxPatternEvidence: 32 } });

  assert.equal(produced.truncated, true);
  assert.equal(produced.stopReason, 'budget-exhausted');
  assert.equal(produced.evidence.length, 32);
  assert.ok(state.reads <= 256 * 1024, 'the scan must stop at the emission cap');
});

test('cancellation is observed inside the scan, not only between producers', () => {
  const controller = new AbortController();
  const { code, state } = countingCode(4 * 1024 * 1024);
  const capped = new Proxy(code, {
    get(object, property) {
      if (state.reads === 10_000) controller.abort();
      return Reflect.get(object, property);
    },
  });

  const produced = pattern().produce(
    { image: { codeBaseAddress: 0x1000n, code: capped } },
    { signal: controller.signal },
  );

  assert.equal(produced.truncated, true);
  assert.equal(produced.stopReason, 'cancelled');
  assert.ok(state.reads <= 10_000 + CHECK_INTERVAL, `cancel must be prompt, saw ${state.reads} byte reads`);
});

test('producer truncation reaches the fusion status through the registry', () => {
  const { code } = countingCode(1024 * 1024);
  const collected = registryWith(pattern()).collect(image(code), 'arm64', {
    budget: { maxPatternComparisons: 8192 },
  });

  assert.equal(collected.truncated, true);
  assert.equal(collected.stopReason, 'budget-exhausted');
  assert.deepEqual(collected.producerIds, ['issue-4215-pattern']);

  const fused = functionCandidates({
    input: image(code),
    architectureId: 'arm64',
    producers: [pattern()],
    budget: { maxPatternComparisons: 8192 },
  });
  assert.equal(fused.status.completeness, 'truncated');
  assert.equal(fused.status.stopReason, 'budget-exhausted');
  assert.deepEqual(fused.candidates, []);
});

test('a cancel observed between producers is never published as complete', () => {
  const controller = new AbortController();
  controller.abort();
  const collected = registryWith(pattern()).collect(image(new Uint8Array(8)), 'arm64', {
    signal: controller.signal,
  });

  assert.equal(collected.truncated, true);
  assert.equal(collected.stopReason, 'cancelled');
  assert.deepEqual(collected.evidence, []);
});

test('an exhaustive pattern scan keeps its results and array contract', () => {
  const code = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0, 0xaa, 0xbb, 0xcc, 0xdd]);
  const produced = pattern().produce(image(code, 0x1000n));
  assert.ok(Array.isArray(produced), 'an untruncated scan keeps returning an array');
  assert.deepEqual(produced.map((item) => item.start), ['4096', '4101']);

  const bounded = pattern().produce(image(code, 0x1000n), {
    budget: { maxPatternComparisons: 1_000_000, maxPatternEvidence: 1_000_000 },
    signal: new AbortController().signal,
  });
  assert.ok(Array.isArray(bounded));
  assert.deepEqual(bounded.map((item) => item.start), ['4096', '4101']);

  const fused = functionCandidates({
    input: image(code, 0x1000n),
    architectureId: 'arm64',
    producers: [pattern()],
  });
  assert.equal(fused.status.completeness, 'complete');
  assert.equal(fused.candidates.length, 2);
});

test('a malformed producer truncation envelope fails closed', () => {
  for (const envelope of [
    { evidence: [], truncated: 'yes' },
    { evidence: [], truncated: true, stopReason: 'because' },
    { evidence: {}, truncated: false },
    { truncated: false },
  ]) {
    assert.throws(
      () => registryWith({ id: 'bad', architectureId: 'arm64', produce() { return envelope; } })
        .collect(image(new Uint8Array(8)), 'arm64'),
      /discovery-producer-evidence-invalid/,
    );
  }
});

console.log('issue #4215 pattern producer cancellation and budget: PASS');
