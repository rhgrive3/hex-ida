import assert from 'node:assert/strict';
import { liftWasmFunction } from '../js/managed/wasm/lifter.js';
import { parseWasm } from '../js/managed/wasm/parser.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';

// Issue #4903: managed/wasm br_table must keep a lossless per-edge target kind
// (offset vs function-exit) for every case/default, and the bridge must not
// publish a mixed br_table as complete when a function-exit edge is unrepresented.

function uleb(value) {
  const out = [];
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value);
  return out;
}
function vec(items) { return [...uleb(items.length), ...items.flat()]; }
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }
function moduleWithBody(expr) {
  const type = [0x60, ...vec([[0x7f]]), ...vec([])]; // (func (param i32))
  const body = [0x00, ...expr]; // no locals, expression already carries the function-end 0x0b
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(0x01, vec([type])),
    ...section(0x03, vec([[0x00]])),
    ...section(0x0a, vec([[...uleb(body.length), ...body]])),
  ]);
}
function switchEffect(vmFn) {
  return vmFn.bundles.flatMap((bundle) => bundle.controlEffects).find((c) => c.kind === 'switch');
}

// (func (param i32) block local.get 0 br_table 0 1 end end)
// case 0 -> inner block, default 1 -> function label (function exit).
const caseOffsetDefaultExit = (() => {
  const bytes = moduleWithBody([0x02, 0x40, 0x20, 0x00, 0x0e, 0x01, 0x00, 0x01, 0x0b, 0x0b]);
  const vmFn = liftWasmFunction(0, parseWasm(bytes));
  return { vmFn, effect: switchEffect(vmFn) };
})();
{
  const { vmFn, effect } = caseOffsetDefaultExit;
  assert.equal(effect.kind, 'switch');
  assert.deepEqual(effect.caseKinds, ['offset'], 'case 0 keeps its offset target kind');
  assert.equal(effect.defaultKind, 'function-exit', 'default keeps its function-exit target kind');
  assert.equal(effect.defaultTargetOffset, null);
  const lowered = lowerVMEffectsToSemanticIr(vmFn);
  const block = lowered.cfg.blocks.find((b) => b.successors.some((s) => s.kind === 'switch-case'));
  assert.ok(block, 'resolved case offset edge is still present in the CFG');
  assert.notEqual(lowered.semanticIr.completeness, 'complete', 'mixed function-exit edge must not publish as complete');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'switch-function-exit-edge-unrepresented'));
}

// Reverse arrangement: case 1 -> function exit, default 0 -> inner block.
const caseExitDefaultOffset = (() => {
  const bytes = moduleWithBody([0x02, 0x40, 0x20, 0x00, 0x0e, 0x01, 0x01, 0x00, 0x0b, 0x0b]);
  const vmFn = liftWasmFunction(0, parseWasm(bytes));
  return { vmFn, effect: switchEffect(vmFn) };
})();
{
  const { vmFn, effect } = caseExitDefaultOffset;
  assert.deepEqual(effect.caseKinds, ['function-exit'], 'case 0 keeps its function-exit target kind');
  assert.equal(effect.defaultKind, 'offset', 'default keeps its offset target kind');
  assert.notEqual(effect.defaultTargetOffset, null);
  const lowered = lowerVMEffectsToSemanticIr(vmFn);
  assert.ok(lowered.cfg.blocks.some((b) => b.successors.some((s) => s.kind === 'switch-default')), 'default offset edge present');
  assert.notEqual(lowered.semanticIr.completeness, 'complete');
}

// Several cases where only one is a function exit: the case index mapping survives.
const mixedCases = (() => {
  const bytes = moduleWithBody([0x02, 0x40, 0x02, 0x40, 0x20, 0x00, 0x0e, 0x02, 0x00, 0x02, 0x01, 0x0b, 0x0b, 0x0b]);
  const vmFn = liftWasmFunction(0, parseWasm(bytes));
  return { vmFn, effect: switchEffect(vmFn) };
})();
{
  const { vmFn, effect } = mixedCases;
  assert.equal(effect.targetOffsets.length, 2);
  assert.deepEqual(effect.caseKinds, ['offset', 'function-exit'], 'function-exit case index preserved');
  assert.equal(effect.defaultKind, 'offset');
  assert.equal(effect.targetOffsets[1], null, 'function-exit case has no bytecode offset');
  const lowered = lowerVMEffectsToSemanticIr(vmFn);
  assert.notEqual(lowered.semanticIr.completeness, 'complete');
}

// All targets are ordinary blocks: existing CFG is preserved and stays complete.
const allOffsets = (() => {
  const bytes = moduleWithBody([0x02, 0x40, 0x02, 0x40, 0x20, 0x00, 0x0e, 0x01, 0x00, 0x01, 0x0b, 0x0b, 0x0b]);
  const vmFn = liftWasmFunction(0, parseWasm(bytes));
  return { vmFn, effect: switchEffect(vmFn) };
})();
{
  const { vmFn, effect } = allOffsets;
  assert.deepEqual(effect.caseKinds, ['offset']);
  assert.equal(effect.defaultKind, 'offset');
  const lowered = lowerVMEffectsToSemanticIr(vmFn);
  assert.equal(lowered.semanticIr.completeness, 'complete', 'fully-resolved switch stays complete');
  assert.ok(!lowered.semanticIr.unknowns.some((u) => u.reason === 'switch-function-exit-edge-unrepresented'));
  const switchBlock = lowered.cfg.blocks.find((b) => b.successors.some((s) => s.kind === 'switch-case'));
  assert.ok(switchBlock.successors.some((s) => s.kind === 'switch-default'), 'both switch edges kept');
}

console.log('  ok issue-4903 wasm br_table function-exit edge regression');
