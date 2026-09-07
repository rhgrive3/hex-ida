import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/index.js';

const origin = { instructionIds: ['i0'] };

function irWithAttrs(attributes) {
  return {
    functionId: 'f', entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['c0'], origin }],
    values: [{ id: 'v0', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'c0', origin }],
    nodes: [{ id: 'c0', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v0'], attributes, completeness: 'complete', origin }],
    completeness: 'complete', unknowns: [], origin,
  };
}

function firstConstExtra(ir) {
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const fn = out.functions?.[0] ?? out;
  const inst = (fn.instructions ?? []).find((i) => i?.extra !== undefined);
  return inst ? { value: inst.extra.value ?? null, float: inst.extra.float ?? null, constKind: inst.extra.constKind ?? null } : null;
}

test('#5847 empty-string const payload does not materialize as a known constant', () => {
  const extra = firstConstExtra(irWithAttrs({ value: '' }));
  assert.equal(extra.value, null, 'BigInt("") must not become 0n');
  assert.equal(extra.float, null, 'Number("") must not become 0');
});

test('#5847 boolean const payload does not materialize as 0/1', () => {
  const t = firstConstExtra(irWithAttrs({ value: true }));
  assert.equal(t.value, null);
  assert.equal(t.float, null);
});

test('#5847 canonical numeric strings and numbers still fold', () => {
  const s = firstConstExtra(irWithAttrs({ value: '42' }));
  assert.equal(s.value, 42n);
  const n = firstConstExtra(irWithAttrs({ value: 7 }));
  assert.equal(n.value, 7n);
});
