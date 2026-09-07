// Regression for #6167: normalizeCurrentFunction() coerced assemblyMeta
// counts with `Number()`, so `['100']`/`true` became canonical instruction
// counts. Those counts decide `truncated` — the model's explicit
// completeness authority for the assembly view — so a structured value could
// forge that evidence. Only primitive safe non-negative integers are adopted;
// anything else falls back.
import assert from 'node:assert/strict';
import { normalizeCurrentFunction } from '../js/ai/provider/worker-protocol.js';

const base = { address: '0x1000', assembly: 'ret' };

{
  const normalized = normalizeCurrentFunction({
    ...base,
    assemblyMeta: {
      totalInstructions: ['100'],
      includedInstructions: ['10'],
      startRow: ['20'],
      endRow: ['29'],
      omittedInstructions: ['90'],
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
  }, 'structured metadata must fall back instead of becoming canonical counts');
}

{
  const normalized = normalizeCurrentFunction({
    ...base,
    assemblyMeta: { totalInstructions: true, includedInstructions: false },
  });
  assert.equal(normalized.assemblyMeta.totalInstructions, 0, 'booleans are not instruction counts');
  assert.equal(normalized.assemblyMeta.truncated, false);
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
