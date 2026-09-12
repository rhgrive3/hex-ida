import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8037 — JVM `bipush`/`sipush` push an immediate integer constant, but the
// bridge lowered them into complete zero-input `unary` nodes that carried no
// record of the immediate, so the push decompiled as `...push(0)` instead of
// the pushed constant. The immediate value and its 32-bit int type must be
// preserved into the semantic IR node as a real constant.

function pushClass() {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'PushImmediateRepro',
    constantPool: [null,
      { tag: 1, value: 'PushImmediateRepro' },        // 1: owner class name
      { tag: 7, nameIndex: 1 },                       // 2: Class
    ],
    fields: [],
    methods: [{
      accessFlags: 0x0008,
      name: 'f',
      descriptor: '()I',
      code: {
        maxStack: 2,
        maxLocals: 0,
        bytecode: Uint8Array.from([
          0x10, 0x05,        // bipush 5
          0x11, 0x01, 0x2c,  // sipush 300
          0x60,              // iadd
          0xac,              // ireturn
        ]),
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  };
}

test('#8037 the frontend publishes the exact bipush/sipush immediates', () => {
  const fn = liftJvmMethod(0, pushClass());
  const bipush = fn.bundles.find((b) => b.mnemonic === 'bipush');
  const sipush = fn.bundles.find((b) => b.mnemonic === 'sipush');
  assert.equal(bipush.completeness, 'exact');
  assert.equal(bipush.producedValues[0].constant, 5);
  assert.equal(bipush.producedValues[0].bits, 32);
  assert.equal(sipush.completeness, 'exact');
  assert.equal(sipush.producedValues[0].constant, 300);
  assert.equal(sipush.producedValues[0].bits, 32);
});

test('#8037 the bridge preserves the immediate into the IR node', () => {
  const fn = liftJvmMethod(0, pushClass());
  const lowered = lowerVMEffectsToSemanticIr(fn);

  for (const [mnemonic, immediate] of [['bipush', '5'], ['sipush', '300']]) {
    const pushNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mnemonic);
    assert.ok(pushNode, `${mnemonic} node required`);
    assert.equal(pushNode.kind, 'const',
      `${mnemonic} must lower as a constant node, not a zero-input unary`);
    assert.equal(pushNode.inputs.length, 0);
    assert.equal(pushNode.completeness, 'complete');

    const output = lowered.semanticIr.values.find((v) => pushNode.outputs.includes(v.id));
    assert.ok(output, `${mnemonic} output value required`);
    assert.equal(output.metadata?.constant, immediate,
      `${mnemonic} immediate must survive onto the IR value`);
    assert.equal(output.machineType?.widthBits, 32,
      `${mnemonic} pushes a 32-bit int`);
  }
});

test('#8037 the decompiler renders the pushed immediates, never push(0)', () => {
  const fn = liftJvmMethod(0, pushClass());
  const decompiled = decompileManagedMethod(fn);
  assert.match(decompiled.pseudocode, /\b5\b/);
  assert.match(decompiled.pseudocode, /0x12C|300/);
  assert.doesNotMatch(decompiled.pseudocode, /bipush\(|sipush\(|push\(0\)/,
    `the fabricated zero-operand push must be gone: ${decompiled.pseudocode}`);
});
