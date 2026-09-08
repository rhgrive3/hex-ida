// Regression for #7239: the CIL lifter must publish the switch default path.
// ECMA-335 `switch` continues at the instruction after the table when the
// unsigned selector is >= the target count, so the effect record needs
// `defaultTargetOffset` and the CFG/IR must keep the default block reachable.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-7239',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      exceptionClauses: [],
    }],
  };
}

// 00: ldc.i4.0           selector
// 01: switch (1 target)  45 01 00 00 00
// 06: +2 -> case at 0x0c
// 0a: ldc.i4.1           default block
// 0b: ret
// 0c: ldc.i4.2           case 0 block
// 0d: ret
const bytecode = new Uint8Array([
  0x16,
  0x45, 0x01, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x17, 0x2a,
  0x18, 0x2a,
]);

test('#7239 switch effect carries defaultTargetOffset at the table base', () => {
  const effects = liftCilMethod(0, cilImage(bytecode));
  const bundle = effects.bundles.find((b) => b.mnemonic === 'switch');
  assert.ok(bundle, 'switch bundle exists');
  const control = bundle.controlEffects[0];
  assert.equal(control.kind, 'switch');
  assert.deepEqual(control.targetOffsets, [0x0c]);
  assert.equal(control.defaultTargetOffset, 0x0a);
});

test('#7239 switch defaultTargetOffset resolves inside the operand table bounds', () => {
  // defaultTargetOffset must equal the offset immediately after the table,
  // not the instruction after the whole switch (the table is the switch's
  // own operand stream).
  const effects = liftCilMethod(0, cilImage(bytecode));
  const bundle = effects.bundles.find((b) => b.mnemonic === 'switch');
  const control = bundle.controlEffects[0];
  assert.equal(control.defaultTargetOffset, control.targetOffsets[0] - 2);
});

test('#7239 CFG keeps the switch default block reachable', () => {
  const bridged = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode)));
  const switchBlock = bridged.cfg.blocks.find((b) => b.id === 'bb_0x0');
  const successorKinds = new Map(switchBlock.successors.map((s) => [`${s.to}:${s.kind}`, s]));
  assert.ok(successorKinds.has('bb_0xc:switch-case'), `missing case edge: ${JSON.stringify(switchBlock.successors)}`);
  assert.ok(successorKinds.has('bb_0xa:switch-default'), `missing default edge: ${JSON.stringify(switchBlock.successors)}`);
});

test('#7239 Semantic IR switch node targets include the default block', () => {
  const bridged = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode)));
  const switchNode = bridged.semanticIr.nodes.find((n) => n.kind === 'switch');
  assert.ok(switchNode, 'switch node exists');
  assert.deepEqual([...switchNode.targets].sort(), ['bb_0x0', 'bb_0xa', 'bb_0xc'].filter((id) => id !== 'bb_0x0' || switchNode.targets.includes('bb_0x0')).sort());
  assert.ok(switchNode.targets.includes('bb_0xa'), `default block missing from targets: ${JSON.stringify(switchNode.targets)}`);
  assert.ok(switchNode.targets.includes('bb_0xc'), 'case block missing from targets');
});

