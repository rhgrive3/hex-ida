/**
 * Regression for #8756 — the shared managed bridge must not fabricate a
 * 32-bit complete machine type for type-elided VMEffect entries, and must
 * propagate the input width through complete copy-like nodes (`dup`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { lowerVMEffectsToSemanticIr as lowerLegacy } from '../../../js/managed/shared/bridge.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image(body, bits) {
  const base = parseCil(buildCil({
    methods: [{
      name: 'Run',
      signature: Uint8Array.from([0x00, 0x00, 0x01]),
      body,
    }],
  }).bytes, { binaryId: 'issue-8756' });
  return { ...base, requires32Bit: bits === 32, requires64Bit: bits === 64 };
}

function lowered(body, bits, lower = lowerVMEffectsToSemanticIr) {
  return lower(liftCilMethod(0, image(body, bits)));
}

function nodeByMnemonic(result, mnemonic) {
  const node = result.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === mnemonic);
  assert.ok(node, `${mnemonic} node present`);
  return node;
}

function valueById(result, id) {
  const value = result.semanticIr.values.find((entry) => entry.id === id);
  assert.ok(value, `value ${id} present`);
  return value;
}

const LDC_I8_DUP = [0x21, 1, 0, 0, 0, 0, 0, 0, 0, 0x25, 0x26, 0x26, 0x2a];
const LDC_I4_DUP = [0x1f, 1, 0x25, 0x26, 0x26, 0x2a];
const LDNULL_POP = [0x14, 0x26, 0x2a];

for (const [label, lower] of [['bridge-v2', lowerVMEffectsToSemanticIr], ['legacy-bridge', lowerLegacy]]) {
  test(`#8756 ${label}: ldc.i8; dup keeps both dup outputs 64-bit`, () => {
    const result = lowered(LDC_I8_DUP, null, lower);
    const dup = nodeByMnemonic(result, 'dup');
    assert.equal(dup.outputs.length, 2);
    for (const id of dup.outputs) {
      const value = valueById(result, id);
      assert.equal(value.machineType.kind, 'bitvector');
      assert.equal(value.machineType.widthBits, 64, 'dup must propagate the 64-bit input width');
    }
    assert.equal(dup.completeness, 'complete', 'proved-width copy must stay complete');
    // Invariant (acceptance 7): a complete copy-like node never changes width.
    const inputWidths = dup.inputs.map((id) => valueById(result, id).machineType.widthBits);
    const outputWidths = dup.outputs.map((id) => valueById(result, id).machineType.widthBits);
    assert.deepEqual([...new Set([...inputWidths, ...outputWidths])], [64]);
  });

  test(`#8756 ${label}: ldc.i4; dup keeps both dup outputs 32-bit`, () => {
    const result = lowered(LDC_I4_DUP, null, lower);
    const dup = nodeByMnemonic(result, 'dup');
    for (const id of dup.outputs) {
      assert.equal(valueById(result, id).machineType.widthBits, 32);
    }
    assert.equal(dup.completeness, 'complete');
  });

  test(`#8756 ${label}: AnyCPU ldnull is not promoted to proven 32-bit complete`, () => {
    const result = lowered(LDNULL_POP, null, lower);
    const ldnull = nodeByMnemonic(result, 'ldnull');
    assert.equal(ldnull.completeness, 'partial', 'unresolved native width may not publish complete');
    assert.equal(ldnull.unknown?.reason, 'machine-type-unresolved');
    const output = valueById(result, ldnull.outputs[0]);
    assert.equal(output.metadata?.reason, 'machine-type-unresolved');
    assert.equal(result.semanticIr.completeness, 'partial');
    assert.ok(result.semanticIr.unknowns.some((entry) => entry.reason === 'machine-type-unresolved'));
  });

  test(`#8756 ${label}: unresolved width must not launder to 32-bit through copy propagation`, () => {
    const result = lowered([0x14, 0x25, 0x26, 0x26, 0x2a], null, lower);
    const dup = nodeByMnemonic(result, 'dup');
    assert.equal(dup.completeness, 'partial', 'dup of an unresolved value cannot publish proven widths');
    assert.equal(dup.unknown?.reason, 'machine-type-unresolved');
    for (const id of dup.outputs) {
      assert.equal(valueById(result, id).metadata?.reason, 'machine-type-unresolved');
    }
    assert.equal(result.semanticIr.completeness, 'partial');
  });

  test(`#8756 ${label}: explicit native width authority is preserved`, () => {
    for (const bits of [32, 64]) {
      const result = lowered(LDNULL_POP, bits, lower);
      const ldnull = nodeByMnemonic(result, 'ldnull');
      assert.equal(ldnull.completeness, 'complete', `${bits}-bit image ldnull stays complete`);
      const output = valueById(result, ldnull.outputs[0]);
      assert.equal(output.machineType.widthBits, bits);
      assert.equal(output.metadata?.reason, undefined);
    }
  });
}
