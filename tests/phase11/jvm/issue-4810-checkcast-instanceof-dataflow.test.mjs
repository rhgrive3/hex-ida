import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #4810 — JVM `checkcast`/`instanceof` must record the objectref they pop:
// instanceof consumes the objectref and produces the 32-bit int result;
// checkcast consumes the objectref and produces the cast reference back
// (refining the same stack slot), and its unmodeled ClassCastException
// control effect must not publish as false `exact`.

function castClass(bytecode, descriptor, name) {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'CastFixture',
    constantPool: [null,
      { tag: 1, value: 'CastFixture' },        // 1: owner class name
      { tag: 7, nameIndex: 1 },                // 2: Class
    ],
    fields: [],
    methods: [{
      accessFlags: 0x0000,
      name,
      descriptor,
      code: {
        maxStack: 2,
        maxLocals: 1,
        bytecode: Uint8Array.from(bytecode),
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  };
}

test('#4810 checkcast consumes the objectref and produces a typed reference, never false-exact', () => {
  const fn = liftJvmMethod(0, castClass([
    0x2a,              // aload_0
    0xc0, 0x00, 0x02,  // checkcast #2
    0xb0,              // areturn
  ], '()Ljava/lang/Object;', 'f'));
  const checkcast = fn.bundles.find((b) => b.mnemonic === 'checkcast');
  assert.ok(checkcast, 'checkcast bundle must be published');
  assert.ok((checkcast.consumedValues?.length ?? 0) >= 1, 'checkcast must consume the objectref');
  assert.ok((checkcast.producedValues?.length ?? 0) >= 1, 'checkcast must produce the cast reference');
  assert.equal(checkcast.producedValues[0].cpClassIndex, 2, 'class CP operand must be published as type evidence');
  assert.notEqual(checkcast.completeness, 'exact', 'unmodeled ClassCastException must not publish exact');
});

test('#4810 instanceof consumes the objectref and produces the 32-bit int result', () => {
  const fn = liftJvmMethod(0, castClass([
    0x2a,              // aload_0
    0xc1, 0x00, 0x02,  // instanceof #2
    0xac,              // ireturn
  ], '()I', 'g'));
  const instanceofOp = fn.bundles.find((b) => b.mnemonic === 'instanceof');
  assert.ok(instanceofOp, 'instanceof bundle must be published');
  assert.ok((instanceofOp.consumedValues?.length ?? 0) >= 1, 'instanceof must consume the objectref');
  assert.ok((instanceofOp.producedValues?.length ?? 0) >= 1, 'instanceof must produce the int result');
  assert.equal(instanceofOp.producedValues[0].bits, 32);
  assert.equal(instanceofOp.producedValues[0].cpClassIndex, 2, 'class CP operand must be published as type evidence');
});

test('#4810 lowered cast nodes keep the objectref dependency edge', () => {
  const fn = liftJvmMethod(0, castClass([
    0x2a,              // aload_0
    0xc0, 0x00, 0x02,  // checkcast #2
    0xb0,              // areturn
  ], '()Ljava/lang/Object;', 'f'));
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const operationId = fn.bundles.find((b) => b.mnemonic === 'checkcast').operationId;
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds.includes(operationId) && n.kind !== 'state-read' && n.kind !== 'state-write');
  assert.ok(node, 'checkcast must lower to a semantic node');
  assert.ok(node.inputs.length > 0, 'the lowered cast must depend on the input objectref value');
  assert.ok(node.outputs.length > 0, 'the lowered cast must produce the result reference');
});
