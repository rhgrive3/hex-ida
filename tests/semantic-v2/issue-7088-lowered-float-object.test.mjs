import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFloatValue,
  createMachineEffectBundle,
  createMachineOperation,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

function projectLoweredConstants(values) {
  const bundle = createMachineEffectBundle({
    instructionId: 'issue-7088-float-object',
    architectureId: 'synthetic',
    mode: 'test',
    operations: [createMachineOperation({
      kind: 'value',
      id: 'fadd',
      opcode: 'fadd',
      inputs: values,
      outputs: [createTemporaryValue('result', values[0])],
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    completeness: 'exact',
    origin: { instructionIds: ['issue-7088-float-object'] },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: 'issue-7088-float-object',
    blockId: 'entry',
    addressWidthBits: 64,
  });
  const legacy = projectSemanticIrV2ToLegacyV1(ir);
  return ir.nodes.filter((node) => node.kind === 'const').map((node) => ({
    node,
    instruction: legacy.instructions.find((candidate) => candidate.semanticNodeId === node.id),
  }));
}

function assertFloatFact(row, expected) {
  const value = row.instruction?.dst;
  assert.equal(row.instruction?.extra?.value, null);
  assert.equal(row.instruction?.extra?.float, expected);
  assert.equal(value?.const, null);
  assert.equal(value?.float, expected);
  assert.equal(value?.floatConst, expected);
  assert.equal(value?.constKind, 'float');
}

function assertUnknownFact(row) {
  const value = row.instruction?.dst;
  assert.equal(row.instruction?.extra?.value, null);
  assert.equal(row.instruction?.extra?.float, undefined);
  assert.equal(value?.const, null);
  assert.equal(value?.float, undefined);
  assert.equal(value?.floatConst, undefined);
}

test('#7088: lowering preserves canonical semanticValue floats through compatibility projection', () => {
  const values = [
    createFloatValue(64, 'ieee754', { semanticValue: '1.5' }),
    createFloatValue(64, 'ieee754', { semanticValue: '9007199254740992.0' }),
  ];
  const rows = projectLoweredConstants(values);
  assert.equal(rows.length, values.length);
  const bySemanticValue = new Map(rows.map((row) => [row.node.attributes.constant.semanticValue, row]));
  assertFloatFact(bySemanticValue.get('1.5'), 1.5);
  assertFloatFact(bySemanticValue.get('9007199254740992.0'), 2 ** 53);
});

test('#7088: lowering decodes supported canonical IEEE bit patterns as float facts', () => {
  const cases = [
    [createFloatValue(64, 'ieee754', { bitPattern: 0x3ff0000000000000n }), 1],
    [createFloatValue(32, 'ieee754-binary32', { bitPattern: 0x3fc00000n }), 1.5],
    [createFloatValue(16, 'ieee754-binary16', { bitPattern: 0x3e00n }), 1.5],
  ];
  for (const [value, expected] of cases) {
    const rows = projectLoweredConstants([value]);
    assert.equal(rows.length, 1);
    assertFloatFact(rows[0], expected);
  }
});

test('#7088: semanticValue and bitPattern must agree before projection', () => {
  const consistent = createFloatValue(64, 'ieee754', {
    semanticValue: '1.5',
    bitPattern: 0x3ff8000000000000n,
  });
  assertFloatFact(projectLoweredConstants([consistent])[0], 1.5);

  const inconsistent = createFloatValue(64, 'ieee754', {
    semanticValue: '1.5',
    bitPattern: 0x3ff0000000000000n,
  });
  assertUnknownFact(projectLoweredConstants([inconsistent])[0]);
});

test('#7088: invalid, non-finite, unsupported, and non-finite bit patterns remain unknown', () => {
  const values = [
    createFloatValue(64, 'ieee754', { semanticValue: 'Infinity' }),
    createFloatValue(64, 'ieee754', { semanticValue: '1e309' }),
    createFloatValue(64, 'ieee754', { semanticValue: '1e-999' }),
    createFloatValue(64, 'ieee754', { semanticValue: 'not-a-float' }),
    createFloatValue(64, 'unsupported-format', { semanticValue: '1.5' }),
    createFloatValue(64, 'unsupported-format', { bitPattern: 0x3ff0000000000000n }),
    createFloatValue(64, 'ieee754', { bitPattern: 0x7ff0000000000000n }),
  ];
  const rows = projectLoweredConstants(values);
  assert.equal(rows.length, values.length);
  for (const row of rows) assertUnknownFact(row);
});

console.log('issue-7088-lowered-float-object: PASS');
