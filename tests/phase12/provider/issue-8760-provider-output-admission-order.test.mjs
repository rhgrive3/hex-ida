import assert from 'node:assert/strict';
import { validateProviderOutput } from '../../../js/phase12/package-envelope.js';

const base = (over = {}) => ({
  schemaVersion: 'provider-v1',
  provenance: { source: 'test' },
  completeness: 'partial',
  items: [],
  ...over,
});

{
  let provenance = { leaf: true };
  for (let i = 0; i < 50_000; i++) provenance = { next: provenance };
  const out = validateProviderOutput(base({ provenance }), { maxBytes: 1024, maxEntries: 1 });
  assert.equal(out.ok, false);
  assert.ok(typeof out.code === 'string' && out.code.startsWith('provider-output-'), `expected typed provider-output code, got ${out.code}`);
  assert.doesNotMatch(out.error || '', /Maximum call stack size exceeded/, 'raw RangeError must never escape the boundary');
}

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

{
  const big = 'x'.repeat(4_000_000);
  const out = validateProviderOutput(base({ provenance: { blob: big } }), { maxBytes: 1024, maxEntries: 1_000 });
  assert.equal(out.ok, false);
  assert.ok(typeof out.code === 'string' && out.code.startsWith('provider-output-'));
  assert.doesNotMatch(out.error || '', /call stack/i);
}

{
  const provenance = { a: 1 };
  provenance.self = provenance;
  const out = validateProviderOutput(base({ provenance }), { maxBytes: 8192, maxEntries: 1000 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'provider-output-structure-invalid');
}

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

{
  let reads = 0;
  let hostile = { leaf: true };
  for (let i = 0; i < 50_000; i++) hostile = { next: hostile };
  const value = base();
  Object.defineProperty(value, 'provenance', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? { source: 'first-read' } : hostile;
    },
  });
  const out = validateProviderOutput(value, { maxBytes: 8192, maxEntries: 100 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(reads, 1, `provider-owned getter must be read exactly once, saw ${reads}`);
  assert.deepEqual(out.value.provenance, { source: 'first-read' });
}

// Collection accessors are also single-admission: a safe first value cannot
// be replaced by a huge second value after the maxEntries preflight.
{
  let reads = 0;
  const value = base();
  Object.defineProperty(value, 'items', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? [] : Array.from({ length: 100_000 }, (_, i) => ({ id: `late-${i}`, targetIdentity: 't' }));
    },
  });
  const out = validateProviderOutput(value, { maxBytes: 8192, maxEntries: 1 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(reads, 1, `items getter must be read exactly once, saw ${reads}`);
  assert.deepEqual(out.value.items, []);
}

console.log('issue-8760 phase12 provider-output admission-order regression PASS');
