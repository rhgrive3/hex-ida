// Regression for #6167: normalizeCurrentFunction() coerced assemblyMeta
// counts with `Number()`, so `['100']`/`true` became canonical instruction
// counts. Those counts decide `truncated` — the model's explicit
// completeness authority for the assembly view — so a structured value could
// forge that evidence. Only primitive safe non-negative integers are adopted;
// anything else falls back.
import assert from 'node:assert/strict';
import { normalizeCurrentFunction } from '../js/ai/provider/worker-protocol.js';

const base = { address: '0x1000', assembly: 'ret' };

for (const [label, invalid] of [
  ['numeric string', '100'],
  ['array', ['100']],
  ['boolean', true],
  ['object', { value: 100 }],
]) {
  const normalized = normalizeCurrentFunction({
    ...base,
    assemblyMeta: {
      totalInstructions: invalid,
      includedInstructions: invalid,
      startRow: invalid,
      endRow: invalid,
      omittedInstructions: invalid,
    },
  });
  assert.deepEqual(normalized.assemblyMeta, {
    totalInstructions: 0,
    includedInstructions: 0,
    startRow: null,
    endRow: null,
    truncated: false,
    omittedInstructions: 0,
    selection: 'unknown',
  }, `${label} assembly metadata must fall back instead of becoming canonical counts`);
}

{
  const normalized = normalizeCurrentFunction({
    ...base,
    assemblyMeta: {
      totalInstructions: 100,
      includedInstructions: 100,
      startRow: 20,
      endRow: 29,
      truncated: true,
      omittedInstructions: 7,
      selection: 'window',
    },
  });
  assert.deepEqual(normalized.assemblyMeta, {
    totalInstructions: 100,
    includedInstructions: 100,
    startRow: 20,
    endRow: 29,
    truncated: true,
    omittedInstructions: 7,
    selection: 'window',
  }, 'valid rows, omitted count, and explicit truncation must be preserved');
}

{
  // Primitive safe integers keep working; the derived omission and truncated
  // logic still applies.
  const normalized = normalizeCurrentFunction({
    ...base,
    assemblyMeta: { totalInstructions: 100, includedInstructions: 10 },
  });
  assert.equal(normalized.assemblyMeta.totalInstructions, 100);
  assert.equal(normalized.assemblyMeta.includedInstructions, 10);
  assert.equal(normalized.assemblyMeta.truncated, true);
  assert.equal(normalized.assemblyMeta.omittedInstructions, 90);
}

for (const [field, invalid] of [
  ['totalInstructions', '100'],
  ['includedInstructions', ['10']],
  ['startRow', { value: 20 }],
  ['endRow', true],
  ['omittedInstructions', '90'],
]) {
  const assemblyMeta = {
    totalInstructions: field === 'includedInstructions' ? 0 : 100,
    includedInstructions: 100,
    [field]: invalid,
  };
  const normalized = normalizeCurrentFunction({ ...base, assemblyMeta });
  assert.equal(normalized.assemblyMeta.truncated, false, `${field} malformed value must not fabricate truncation`);
  const expected = ['startRow', 'endRow'].includes(field) ? null : 0;
  assert.equal(normalized.assemblyMeta[field], expected, `${field} malformed value must use its conservative fallback`);
}
