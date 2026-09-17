import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const FLOAT32 = { kind: 'float', widthBits: 32, format: 'binary32' };

function projectArgArithmetic(opcode) {
  const built = buildCil({
    types: [{ name: 'T', namespace: 'N', methodList: 1, fieldList: 1 }],
    methods: [{
      name: 'M',
      flags: 0x0016,
      // DEFAULT, one parameter, return r4, parameter r4.
      signature: [0x00, 0x01, 0x0c, 0x0c],
      body: [0x02, 0x02, opcode, 0x2a],
    }],
  });
  const lifted = liftCilMethod(0, parseCil(built.bytes));
  return { lifted, lowered: lowerVMEffectsToSemanticIr(lifted) };
}

function outputType(lowered, kind) {
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.kind === kind);
  assert.ok(node, `expected ${kind} node`);
  const value = lowered.semanticIr.values.find((candidate) => node.outputs.includes(candidate.id));
  assert.ok(value, `expected ${kind} output`);
  return { node, value };
}

test('#8924 float argument authority survives ldarg and arithmetic', () => {
  const { lifted, lowered } = projectArgArithmetic(0x58); // add
  const loads = lifted.bundles.filter((bundle) => bundle.mnemonic === 'ldarg.0');
  assert.equal(loads.length, 2);
  assert.deepEqual(loads[0].producedValues[0].type, FLOAT32);
  assert.deepEqual(lifted.bundles.find((bundle) => bundle.mnemonic === 'add').producedValues[0].type, FLOAT32);
  const { node, value } = outputType(lowered, 'binary');
  assert.deepEqual(value.machineType, FLOAT32);
  assert.equal(node.completeness, 'complete');
});

test('#8924 float div keeps float type and never invents integral divide exceptions', () => {
  const { lifted, lowered } = projectArgArithmetic(0x5b); // div
  const div = lifted.bundles.find((bundle) => bundle.mnemonic === 'div');
  assert.ok(div);
  assert.deepEqual(div.producedValues[0].type, FLOAT32);
  assert.deepEqual(div.possibleExceptions, []);
  assert.ok(!div.possibleExceptions.some((entry) => /DivideByZero|Arithmetic/.test(JSON.stringify(entry))));

  const { value } = outputType(lowered, 'binary');
  assert.deepEqual(value.machineType, FLOAT32);
  // The pre-existing #7937 exception-authority guard remains fail-closed until
  // integral-vs-floating exception completeness is promoted separately; this
  // regression pins that it cannot regress to complete *integer* semantics.
  assert.equal(div.completeness, 'partial');
  assert.ok(div.unknownEffects.some((entry) => entry.reason === 'cil-div-exception-authority-unresolved'));
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
