import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';

// #8977: the DEX field-memory semantic overlay (`repairDexFieldMemory`) used to run a FULL
// `old.nodes.filter(...)` scan once per field-bound load/store (and a second one per extended
// load), making ordinary whole-module lowering O(field-accesses x IR-nodes). It must instead index
// state-read / state-write nodes by effect ONCE and serve each access in O(matching-nodes), with
// identical output semantics.
const build = (n) => {
  const fields = Array.from({ length: n }, (_, i) => ({ classType: 'LTest;', type: 'I', name: 'f' + String(i).padStart(5, '0') }));
  const words = [];
  for (let i = 0; i < n; i++) words.push(0x1052, i); // iget v0, v1, field@i
  words.push(0x000e); // return-void
  return liftDexMethod(0, dexMethod(words, { fields }));
};

// A node array is an array whose elements carry node identity (blockId + sourceEffectIds) but are
// NOT value records (values carry definitionNodeId). repairDexFieldMemory's per-access scans ran
// over such arrays; the fix must not run a full node-array `.filter` per access.
const isNodeArray = (a) =>
  Array.isArray(a) && a.length > 0 && a[0] && typeof a[0] === 'object'
  && 'blockId' in a[0] && 'sourceEffectIds' in a[0] && !('definitionNodeId' in a[0]);

test('#8977: field-memory lowering forms one receiver-derived address per field access (behavior preserved)', () => {
  const n = 8;
  const lowered = lowerVMEffectsToSemanticIr(build(n));
  const loads = lowered.semanticIr.nodes.filter((node) => node.kind === 'load');
  const addressNodes = lowered.semanticIr.nodes.filter((node) => node.operator === 'managed.dex.instance-field-address');
  assert.equal(loads.length, n);
  assert.equal(addressNodes.length, n);
  assert.equal(new Set(addressNodes.map((a) => a.attributes.fieldIdentity)).size, n);
  // Every load's address is proven from a receiver read, and every load references its own address value.
  for (const load of loads) {
    const addressValueId = load.memory.addressExpr.valueId;
    const address = addressNodes.find((a) => a.outputs.includes(addressValueId));
    assert.ok(address, 'load has a field-address node');
    assert.equal(load.inputs[0], addressValueId);
    assert.ok(address.inputs.length >= 1, 'address is derived from the receiver read');
  }
});

test('#8977: field-memory lowering does not full-scan the IR node array per field access', () => {
  const fn = build(200);
  const original = Array.prototype.filter;
  let nodeArrayFilters = 0;
  Array.prototype.filter = function (...args) {
    if (isNodeArray(this)) nodeArrayFilters += 1;
    return original.apply(this, args);
  };
  try {
    const lowered = lowerVMEffectsToSemanticIr(fn);
    assert.equal(lowered.semanticIr.nodes.filter((node) => node.operator === 'managed.dex.instance-field-address').length, 200);
  } finally {
    Array.prototype.filter = original;
  }
  // Base ran one full node-array `.filter` per field access (~200) plus the SSA build's own
  // per-node work; the fixed overlay replaces those with a single effect index, so the overlay's
  // own node-array filters collapse to zero (only the SSA module's single traversal remains).
  assert.ok(nodeArrayFilters <= 4,
    `expected the overlay to stop scanning the whole node array per access, saw ${nodeArrayFilters}`);
});
