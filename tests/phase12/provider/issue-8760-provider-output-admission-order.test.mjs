import assert from 'node:assert/strict';
import { validateProviderOutput } from '../../../js/phase12/package-envelope.js';

const base = (over = {}) => ({
  schemaVersion: 'provider-v1',
  provenance: { source: 'test' },
  completeness: 'partial',
  items: [],
  ...over,
});

// (1) 50k-deep provenance with maxBytes=1024 must fail with a typed nesting
//     resource error, never a raw RangeError from stableStringify/deepFreeze.
{
  let provenance = { leaf: true };
  for (let i = 0; i < 50_000; i++) provenance = { next: provenance };
  const out = validateProviderOutput(base({ provenance }), { maxBytes: 1024, maxEntries: 1 });
  assert.equal(out.ok, false);
  assert.ok(typeof out.code === 'string' && out.code.startsWith('provider-output-'), `expected typed provider-output code, got ${out.code}`);
  assert.doesNotMatch(out.error || '', /Maximum call stack size exceeded/, 'raw RangeError must never escape the boundary');
}

// (2) maxEntries=1 must fail before traversing/materializing every item.
{
  let touched = 0;
  const items = Array.from({ length: 100_000 }, (_, i) => ({
    get id() { touched++; return `id-${i}`; },
    kind: 'x',
    targetIdentity: 't',
  }));
  const out = validateProviderOutput(base({ items, targetIdentity: 't' }), { maxEntries: 1, maxBytes: 64 * 1024 * 1024 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'provider-output-entry-budget-exceeded');
  assert.ok(touched <= 3, `getter items must not all be walked before the entry budget (touched ${touched})`);
}

// (3) A tiny maxBytes must prevent canonicalization of an oversized scalar/object.
{
  const big = 'x'.repeat(4_000_000);
  const out = validateProviderOutput(base({ provenance: { blob: big } }), { maxBytes: 1024, maxEntries: 1_000 });
  assert.equal(out.ok, false);
  assert.ok(typeof out.code === 'string' && out.code.startsWith('provider-output-'));
  assert.doesNotMatch(out.error || '', /call stack/i);
}

// (4) Cyclic provider-output graph fails closed with a typed error (no crash).
{
  const provenance = { a: 1 };
  provenance.self = provenance;
  const out = validateProviderOutput(base({ provenance }), { maxBytes: 8192, maxEntries: 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'provider-output-structure-invalid');
}

// (5) A well-formed, in-budget provider output still validates and returns ok.
{
  const out = validateProviderOutput(base({
    completeness: 'complete',
    items: [{ id: 'a', targetIdentity: 't1' }],
    targetIdentity: 't1',
  }), { maxBytes: 8192, maxEntries: 10 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.value.items[0].id, 'a');
  assert.ok(Object.isFrozen(out.value));
}

// (6) A getter-bearing provenance is admitted within budget and still
//     validates: the preflight + stableStringify keep the boundary from ever
//     crashing, and a small bounded number of property reads (not a heap/stack
//     exhaustion) is the correct, type-preserving #7127 outcome.
{
  let reads = 0;
  const provenance = { get boom() { reads++; return { deep: 'x'.repeat(10) }; } };
  const out = validateProviderOutput(base({ provenance }), { maxBytes: 8192, maxEntries: 100 });
  assert.equal(out.ok, true);
  assert.ok(reads >= 1 && reads <= 4, `bounded getter reads, saw ${reads}`);
}

console.log('issue-8760 phase12 provider-output admission-order regression PASS');
