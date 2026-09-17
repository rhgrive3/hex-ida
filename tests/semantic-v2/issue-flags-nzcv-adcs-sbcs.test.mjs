import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, constOf } from '../../js/expr.js';
import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

function buildExprModel(rows) {
  const raw = rows.map((r, row) => ({ row, address: 0x1000n + BigInt(row * 4), mn: r.mn, ops: r.ops }));
  const rowByAddress = new Map(raw.map((r) => [r.address.toString(), r.row]));
  return buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
    addrOfRow: (row) => raw[row]?.address ?? null,
    symbolFor: () => null,
    name: 'flags_nzcv_adcs_sbcs_test',
  });
}

test('expr.js: adcs and sbcs retain flag effects for following conditional select', () => {
  const model = buildExprModel([
    { mn: 'adds', ops: 'w0, w1, w2' },
    { mn: 'adcs', ops: 'w3, w4, w5' },
    { mn: 'csel', ops: 'w6, w7, w8, eq' },
  ]);
  const values = buildValues(model);
  const def = values.defAt(2, 'x6');
  assert.ok(def, 'missing csel definition');
  const selNode = def.k === 'un' && def.op === 'uxt32' ? def.a : def;
  assert.equal(selNode.k, 'sel');
  assert.equal(selNode.cc, 'eq');
  assert.ok(selNode.predicate, 'adcs must not invalidate remembered predicate as unsupportedFlagWriter');
  assert.equal(selNode.predicate.k, 'flagcond');
  assert.equal(selNode.predicate.producer, 'adcs');
});

test('expr.js: sbcs retains flag effects for following conditional select', () => {
  const model = buildExprModel([
    { mn: 'subs', ops: 'x0, x1, x2' },
    { mn: 'sbcs', ops: 'x3, x4, x5' },
    { mn: 'cset', ops: 'x6, ne' },
  ]);
  const values = buildValues(model);
  const setNode = values.defAt(2, 'x6');
  assert.ok(setNode, 'missing cset definition');
  assert.equal(setNode.k, 'sel');
  assert.equal(setNode.cc, 'ne');
  assert.ok(setNode.predicate, 'sbcs must retain flag condition');
  assert.equal(setNode.predicate.producer, 'sbcs');
});

test('expr.js: adc, adcs, sbc, sbcs emit binary arithmetic nodes', () => {
  const model = buildExprModel([
    { mn: 'adc', ops: 'x0, x1, x2' },
    { mn: 'adcs', ops: 'x3, x4, x5' },
    { mn: 'sbc', ops: 'x6, x7, x8' },
    { mn: 'sbcs', ops: 'x9, x10, x11' },
    { mn: 'ngc', ops: 'x12, x13' },
    { mn: 'ngcs', ops: 'x14, x15' },
  ]);
  const values = buildValues(model);
  assert.equal(values.defAt(0, 'x0')?.k, 'bin');
  assert.equal(values.defAt(0, 'x0')?.op, 'adc');
  assert.equal(values.defAt(1, 'x3')?.k, 'bin');
  assert.equal(values.defAt(1, 'x3')?.op, 'adc');
  assert.equal(values.defAt(2, 'x6')?.k, 'bin');
  assert.equal(values.defAt(2, 'x6')?.op, 'sbc');
  assert.equal(values.defAt(3, 'x9')?.k, 'bin');
  assert.equal(values.defAt(3, 'x9')?.op, 'sbc');
  assert.equal(values.defAt(4, 'x12')?.k, 'un');
  assert.equal(values.defAt(4, 'x12')?.op, 'ngc');
  assert.equal(values.defAt(5, 'x14')?.k, 'un');
  assert.equal(values.defAt(5, 'x14')?.op, 'ngc');
});

test('semantic-v2: dynamic adcs multi-word addition computes exact mathematical result', () => {
  // Compute (0x1_00000000_00000000 + 0x2_00000000_00000000) via low 64-bit adds and high 64-bit adcs
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE, decoderSemanticVersion: 'test-adcs-math',
    binaryId: 'bin_math', sliceId: 'slice_math', addressWidthBits: 64,
    entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [
        { decoded: { address: 0x1000n, mnemonic: 'adds', operands: 'x0, x1, x2', ops: parseOperands('x0, x1, x2'), mode: 'a64' } },
        { decoded: { address: 0x1004n, mnemonic: 'adcs', operands: 'x3, x4, x5', ops: parseOperands('x3, x4, x5'), mode: 'a64' } },
      ],
    }],
  });
  const addCarryNodes = pipeline.semanticIr.nodes.filter(n => n.operator === 'add-with-carry');
  assert.equal(addCarryNodes.length, 2);

  // Both the first (adds) and second (adcs) must produce exact non-clobber lowering
  const firstInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-add-with-carry-intrinsic');
  const secondInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-dynamic-add-with-carry-intrinsic');

  assert.ok(firstInst, 'first instruction must lower through exact-add-with-carry-intrinsic');
  assert.equal(firstInst.op, 'bin');
  assert.equal(firstInst.extra?.compatSource, 'exact-add-with-carry-intrinsic');
  assert.ok(secondInst, 'second instruction must lower through exact-dynamic-add-with-carry-intrinsic');
  assert.equal(secondInst.op, 'bin');
  assert.equal(secondInst.extra?.compatSource, 'exact-dynamic-add-with-carry-intrinsic');

  // Verify secondary flag outputs (C and V) are generated for both operations
  for (const node of addCarryNodes) {
    const cValue = pipeline.legacyV1.values.find(v => v.semanticValueId === node.outputs[1]);
    const vValue = pipeline.legacyV1.values.find(v => v.semanticValueId === node.outputs[2]);
    assert.ok(cValue?.def, `carry-out definition required for ${node.id}`);
    assert.ok(vValue?.def, `overflow definition required for ${node.id}`);
    assert.equal(cValue.def.extra?.compatSource, 'exact-add-with-carry-result');
    assert.equal(vValue.def.extra?.compatSource, 'exact-add-with-carry-result');
  }
});

test('semantic-v2: dynamic sbcs multi-word subtraction computes exact mathematical result', () => {
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE, decoderSemanticVersion: 'test-sbcs-math',
    binaryId: 'bin_math_sub', sliceId: 'slice_math_sub', addressWidthBits: 64,
    entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [
        { decoded: { address: 0x1000n, mnemonic: 'subs', operands: 'x0, x1, x2', ops: parseOperands('x0, x1, x2'), mode: 'a64' } },
        { decoded: { address: 0x1004n, mnemonic: 'sbcs', operands: 'x3, x4, x5', ops: parseOperands('x3, x4, x5'), mode: 'a64' } },
      ],
    }],
  });
  const subCarryNodes = pipeline.semanticIr.nodes.filter(n => n.operator === 'add-with-carry');
  assert.equal(subCarryNodes.length, 2);

  const firstInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-add-with-carry-intrinsic');
  const secondInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-dynamic-add-with-carry-intrinsic');

  assert.ok(firstInst, 'first instruction must lower through exact-add-with-carry-intrinsic');
  assert.equal(firstInst.op, 'bin');
  assert.equal(firstInst.sub, 'sub');
  assert.ok(secondInst, 'second instruction must lower through exact-dynamic-add-with-carry-intrinsic');
  assert.equal(secondInst.op, 'bin');
  assert.equal(secondInst.sub, 'add');

  for (const node of subCarryNodes) {
    const cValue = pipeline.legacyV1.values.find(v => v.semanticValueId === node.outputs[1]);
    const vValue = pipeline.legacyV1.values.find(v => v.semanticValueId === node.outputs[2]);
    assert.ok(cValue?.def, `carry-out definition required for ${node.id}`);
    assert.ok(vValue?.def, `overflow definition required for ${node.id}`);
    assert.equal(cValue.def.extra?.compatSource, 'exact-add-with-carry-result');
    assert.equal(vValue.def.extra?.compatSource, 'exact-add-with-carry-result');
  }
});
