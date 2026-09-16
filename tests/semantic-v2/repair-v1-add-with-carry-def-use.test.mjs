import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

function pipelineFor(mnemonic, operands) {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE, decoderSemanticVersion: 'local-c4-def-use-1',
    binaryId: 'binary_c4_flag_def_use', sliceId: 'slice_c4_flag_def_use', addressWidthBits: 64,
    entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [{ decoded: { address: 0x1000n, mnemonic, operands, ops: parseOperands(operands), mode: 'a64' } }],
    }],
  });
}

// The oracle evaluates only generic projected BV operations. Its expected
// C/V values below use full-precision arithmetic and signed bounds instead of
// repeating the production bit-carry formula.
function observe(value, left, right, cache = new Map()) {
  if (cache.has(value)) return cache.get(value);
  let raw;
  if (value.const != null) raw = value.const;
  else if (value.kind === 'arg') {
    assert.ok(['x0', 'x1'].includes(value.reg), `unexpected arithmetic input ${value.reg}`);
    raw = value.reg === 'x0' ? left : right;
  } else {
    const inst = value.def;
    assert.ok(inst && inst.dst === value, 'every observed result has its own definition');
    const args = (inst.args || []).map(a => observe(a.value, left, right, cache));
    if (inst.op === 'mov') raw = args[0];
    else if (inst.op === 'un' && inst.sub === 'not') raw = ~args[0];
    else if (inst.op === 'bfx') raw = (args[0] >> BigInt(inst.extra.lsb)) & ((1n << BigInt(inst.extra.width)) - 1n);
    else if (inst.op === 'bin') {
      switch (inst.sub) {
        case 'add': raw = args[0] + args[1]; break;
        case 'sub': raw = args[0] - args[1]; break;
        case 'and': raw = args[0] & args[1]; break;
        case 'or': raw = args[0] | args[1]; break;
        case 'xor': raw = args[0] ^ args[1]; break;
        default: assert.fail(`unexpected operation ${inst.sub}`);
      }
    } else assert.fail(`unexpected arithmetic definition ${inst.op}:${inst.sub}`);
  }
  const result = BigInt.asUintN(value.bits, raw);
  cache.set(value, result);
  return result;
}

for (const [mnemonic, operands, operator] of [
  ['cmp', 'w0, w1', 'sub'], ['cmn', 'w0, w1', 'add'],
  ['cmp', 'x0, x1', 'sub'], ['cmn', 'x0, x1', 'add'],
]) test(`${mnemonic} ${operands}: display comparison does not replace a consumed numeric result`, () => {
  const pipeline = pipelineFor(mnemonic, operands);
  const source = pipeline.semanticIr.nodes.find(n => n.operator === 'add-with-carry');
  assert.ok(source);
  const values = source.outputs.map(id => pipeline.legacyV1.values.find(v => v.semanticValueId === id));
  assert.ok(values.every(Boolean));
  const result = values[0];
  assert.ok(result.def, 'the N/Z-producing result needs its own definition');
  assert.equal(result.def.dst, result, 'a display-only carrier is not the definition of this numeric ValueId');
  assert.equal(result.def.op, 'bin');
  assert.equal(result.def.sub, operator);
  assert.ok(pipeline.legacyV1.instructions.some(i => i.op === 'cmp' && i.extra?.semanticComparisonCarrier),
    'legacy comparison rendering remains separate and available');
  for (const value of values.slice(1)) {
    assert.ok(value.def, 'a secondary result must have its own numeric definition');
    assert.equal(value.def.dst, value, 'secondary outputs cannot borrow the display comparison definition');
    assert.equal(value.def.op, 'bfx');
    assert.equal(value.def.extra?.compatSource, 'exact-add-with-carry-result');
  }
  const width = result.bits, modulus = 1n << BigInt(width), half = modulus >> 1n;
  const points = [0n, 1n, 2n, half - 2n, half - 1n, half, half + 1n, modulus - 2n, modulus - 1n];
  for (const a of points) for (const b of points) {
    const mathematical = operator === 'add' ? a + b : a - b;
    const signed = operator === 'add' ? BigInt.asIntN(width, a) + BigInt.asIntN(width, b)
      : BigInt.asIntN(width, a) - BigInt.asIntN(width, b);
    const expectedCarry = operator === 'add' ? mathematical >= modulus : a >= b;
    assert.equal(observe(values[0], a, b), BigInt.asUintN(width, mathematical));
    assert.equal(observe(values[1], a, b), BigInt(expectedCarry), `carry at ${a}, ${b}`);
    assert.equal(observe(values[2], a, b), BigInt(signed < -half || signed >= half), `overflow at ${a}, ${b}`);
  }

});


test('unused secondary values retain identity but cannot become unconstrained arguments', () => {
  const pipeline = pipelineFor('add', 'x5, x0, x1');
  const source = pipeline.semanticIr.nodes.find(n => n.operator === 'add-with-carry');
  for (const id of source.outputs.slice(1)) {
    const value = pipeline.legacyV1.values.find(v => v.semanticValueId === id);
    assert.equal(value.kind, 'undef');
    assert.equal(value.def, null);
    assert.equal(value.const, null);
    assert.equal(value.sourceEntityId, pipeline.semanticIr.values.find(v => v.id === id).sourceEntityId);
    assert.equal(value.compatOmitted, 'unused-add-with-carry-result');
  }
  assert.equal(pipeline.legacyV1.instructions.filter(i => i.extra?.compatSource === 'exact-add-with-carry-result').length, 0);
});

for (const mutation of ['memory', 'nondeterminism', 'extra-input']) test(`an intrinsic with ${mutation} does not borrow pure add-with-carry lowering`, () => {
  const ir = structuredClone(pipelineFor('cmp', 'w0, w1').semanticIr);
  const source = ir.nodes.find(n => n.operator === 'add-with-carry');
  if (mutation === 'memory') source.intrinsic.memoryWrite = { scope: 'all', addressSpaces: ['memory'] };
  else if (mutation === 'nondeterminism') source.intrinsic.determinism = 'nondeterministic';
  else {
    const originalRight = ir.nodes.find(n => n.outputs.includes(source.inputs[1])).inputs[0];
    source.inputs.push(originalRight); source.intrinsic.inputs.push(originalRight);
  }
  const projected = projectSemanticIrV2ToLegacyV1(ir);
  const arithmetic = projected.instructions.find(i => i.sourceEntityId === source.id);
  assert.equal(arithmetic.op, 'clobber');
  assert.ok(!projected.instructions.some(i => i.sourceEntityId === source.id && i.extra?.compatSource === 'exact-add-with-carry-result'));
});

for (const mnemonic of ['adcs', 'sbcs']) test(`${mnemonic}: dynamic incoming carry lowers through exact-dynamic-add-with-carry`, () => {
  const pipeline = pipelineFor(mnemonic, 'w0, w0, w1');
  const source = pipeline.semanticIr.nodes.find(n => n.operator === 'add-with-carry');
  assert.ok(source);
  const inst = pipeline.legacyV1.instructions.find(i => i.sourceEntityId === source.id && i.extra?.compatSource === 'exact-dynamic-add-with-carry-intrinsic');
  assert.ok(inst, `${mnemonic} must lower through exact-dynamic-add-with-carry-intrinsic, never clobber`);
  assert.equal(inst.op, 'bin');
  assert.equal(inst.sub, 'add');
  const values = source.outputs.map(id => pipeline.legacyV1.values.find(v => v.semanticValueId === id));
  assert.ok(values.every(Boolean));
  assert.equal(values[0].def, inst);
  for (const value of values.slice(1)) {
    assert.ok(value.def, 'secondary outputs need their own definition');
    assert.equal(value.def.extra?.compatSource, 'exact-add-with-carry-result');
  }
});

test('adds followed by adcs correctly chains dynamic carry without clobber', () => {
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE, decoderSemanticVersion: 'local-c4-def-use-chain',
    binaryId: 'bin_chain', sliceId: 'slice_chain', addressWidthBits: 64,
    entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [
        { decoded: { address: 0x1000n, mnemonic: 'adds', operands: 'x0, x1, x2', ops: parseOperands('x0, x1, x2'), mode: 'a64' } },
        { decoded: { address: 0x1004n, mnemonic: 'adcs', operands: 'x3, x4, x5', ops: parseOperands('x3, x4, x5'), mode: 'a64' } },
      ],
    }],
  });
  const addCarryNodes = pipeline.semanticIr.nodes.filter(n => n.operator === 'add-with-carry');
  assert.equal(addCarryNodes.length, 2);
  assert.ok(!pipeline.legacyV1.instructions.some(i => i.op === 'clobber'), 'no clobber instructions permitted in exact add-with-carry sequence');
  const dynamicInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-dynamic-add-with-carry-intrinsic');
  assert.ok(dynamicInst, 'adcs must project through exact-dynamic-add-with-carry-intrinsic');
});

test('subs followed by sbcs correctly chains dynamic borrow without clobber', () => {
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE, decoderSemanticVersion: 'local-c4-def-use-chain-sub',
    binaryId: 'bin_chain_sub', sliceId: 'slice_chain_sub', addressWidthBits: 64,
    entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [
        { decoded: { address: 0x1000n, mnemonic: 'subs', operands: 'x0, x1, x2', ops: parseOperands('x0, x1, x2'), mode: 'a64' } },
        { decoded: { address: 0x1004n, mnemonic: 'sbcs', operands: 'x3, x4, x5', ops: parseOperands('x3, x4, x5'), mode: 'a64' } },
      ],
    }],
  });
  const subCarryNodes = pipeline.semanticIr.nodes.filter(n => n.operator === 'add-with-carry');
  assert.equal(subCarryNodes.length, 2);
  assert.ok(!pipeline.legacyV1.instructions.some(i => i.op === 'clobber'), 'no clobber instructions permitted in exact sub-with-carry sequence');
  const dynamicInst = pipeline.legacyV1.instructions.find(i => i.extra?.compatSource === 'exact-dynamic-add-with-carry-intrinsic');
  assert.ok(dynamicInst, 'sbcs must project through exact-dynamic-add-with-carry-intrinsic');
});
