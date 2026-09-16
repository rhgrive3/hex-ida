// Issue #8999 regression: the managed lowering must normalize the source-VM
// effective shift count before publishing a generic canonical shift, and must
// not claim complete / exact / vm-semantics-preservation when that count rule
// cannot be represented. Wasm i32 and JVM int (32-bit) shifts are in scope;
// DEX/CIL/i64/long are explicit non-goals and stay untouched.
import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import {
  lowerVMEffectsToSemanticIr,
  decompileManagedMethod,
} from '../../../js/managed/shared/bridge-v2.js';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
} from '../../../js/managed/index.js';

function wasmShift(mnemonic, count) {
  const methodId = createManagedMethodId('mod-8999', `${mnemonic}-${count}`);
  const bundle = (offset, m, extra) => createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset, mnemonic: m, completeness: 'exact', ...extra,
  });
  return createVMEffectFunction({
    methodId, frontendId: 'wasm', exceptionRegions: [], aggregateCompleteness: 'exact',
    bundles: [
      bundle(0, 'i32.const', { producedValues: [{ bits: 32, constant: 1 }] }),
      bundle(2, 'i32.const', { producedValues: [{ bits: 32, constant: count }] }),
      bundle(3, mnemonic, {
        consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
        producedValues: [{ bits: 32 }],
      }),
      bundle(4, 'return', { controlEffects: [{ kind: 'return' }] }),
    ],
  });
}

function shiftNode(lowered) {
  return lowered.semanticIr.nodes.find((n) => n.kind === 'binary' && ['shl', 'lshr', 'ashr'].includes(n.operator));
}
function rhsConst(lowered) {
  const n = shiftNode(lowered);
  const v = lowered.semanticIr.values.find((x) => x.id === n?.inputs?.[1]);
  return v?.metadata?.constant;
}

function wasmDynamicShift() {
  const methodId = createManagedMethodId('mod-8999', 'dyn-shl');
  const bundle = (offset, m, extra) => createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset, mnemonic: m, completeness: 'exact', ...extra,
  });
  return createVMEffectFunction({
    methodId, frontendId: 'wasm', exceptionRegions: [], aggregateCompleteness: 'exact',
    bundles: [
      bundle(0, 'i32.const', { producedValues: [{ bits: 32, constant: 1 }] }),
      bundle(2, 'i32.const', { producedValues: [{ bits: 32, constant: 2 }] }),
      bundle(4, 'i32.const', { producedValues: [{ bits: 32, constant: 3 }] }),
      bundle(6, 'i32.add', { consumedValues: [{ id: 'a', bits: 32 }, { id: 'b', bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(7, 'i32.shl', { consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(8, 'return', { controlEffects: [{ kind: 'return' }] }),
    ],
  });
}

function jvmIshrShift() {
  const cls = {
    moduleId: 'managed-mod:8999', vmSpecEdition: 'java-se-17', thisClassName: 'T',
    constantPool: [null], fields: [], methods: [{
      accessFlags: 0x0009, name: 'm', descriptor: '()I',
      code: { maxStack: 2, maxLocals: 0, offset: 0, exceptionTable: [], bytecode: Uint8Array.from([0x04, 0x10, 0x20, 0x78, 0xac]) },
    }],
  };
  return liftJvmMethod(0, cls);
}

test('#8999 Wasm i32.shl by 32 normalizes the effective count to 0 and stays complete', () => {
  const lowered = lowerVMEffectsToSemanticIr(wasmShift('i32.shl', 32));
  const node = shiftNode(lowered);
  assert.equal(node.operator, 'shl');
  assert.equal(rhsConst(lowered), '0');
  assert.equal(node.completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.deepEqual(lowered.semanticIr.unknowns, []);
});

test('#8999 Wasm i32.shr_s / i32.shr_u by 32 normalize to effective count 0', () => {
  for (const [mnemonic, operator] of [['i32.shr_s', 'ashr'], ['i32.shr_u', 'lshr']]) {
    const lowered = lowerVMEffectsToSemanticIr(wasmShift(mnemonic, 32));
    assert.equal(shiftNode(lowered).operator, operator, `${mnemonic} operator`);
    assert.equal(rhsConst(lowered), '0', `${mnemonic} effective count`);
    assert.equal(shiftNode(lowered).completeness, 'complete', `${mnemonic} node complete`);
    assert.equal(lowered.semanticIr.completeness, 'complete', `${mnemonic} fn complete`);
  }
});

test('#8999 Wasm i32.shl by 33 normalizes to 1 (33 & 31)', () => {
  const lowered = lowerVMEffectsToSemanticIr(wasmShift('i32.shl', 33));
  assert.equal(rhsConst(lowered), '1');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#8999 in-range Wasm shift counts are unchanged and remain complete', () => {
  for (const count of [0, 1, 31]) {
    const lowered = lowerVMEffectsToSemanticIr(wasmShift('i32.shl', count));
    assert.equal(rhsConst(lowered), String(count), `count ${count} unchanged`);
    assert.equal(lowered.semanticIr.completeness, 'complete', `count ${count} still complete`);
  }
});

test('#8999 JVM int ishl by 32 normalizes to the low-5-bits effective count', () => {
  const lowered = lowerVMEffectsToSemanticIr(jvmIshrShift());
  const node = shiftNode(lowered);
  assert.ok(node, 'jvm shl node exists');
  assert.equal(node.operator, 'shl');
  assert.equal(rhsConst(lowered), '0');
  assert.equal(node.completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#8999 dynamic Wasm shift count fails closed instead of claiming complete', () => {
  const lowered = lowerVMEffectsToSemanticIr(wasmDynamicShift());
  const node = shiftNode(lowered);
  assert.notEqual(node.completeness, 'complete', 'dynamic-count shift must not be complete');
  assert.equal(node.unknown?.reason, 'managed-shift-count-unnormalized');
  assert.notEqual(lowered.semanticIr.completeness, 'complete', 'function must not claim complete VM semantics');
  assert.ok((lowered.semanticIr.unknowns || []).some((u) => u.reason === 'managed-shift-count-unnormalized'));
});

test('#8999 managed decompiler does not emit a raw by-width shift for a normalized constant', () => {
  const out = decompileManagedMethod(wasmShift('i32.shl', 32));
  assert.doesNotMatch(out.pseudocode, /<<\s*32\b/, 'must not render a raw shift by 32');
  assert.match(out.pseudocode, /<<\s*0\b/, 'renders the VM-effective normalized count');
});

test('#8999 non-goal: DEX shifts are left untouched (still complete)', () => {
  const methodId = createManagedMethodId('mod-8999', 'dex-shl');
  const bundle = (offset, m, extra) => createVMEffectBundle({
    frontendId: 'dex', methodId, operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset, mnemonic: m, completeness: 'exact', ...extra,
  });
  const lowered = lowerVMEffectsToSemanticIr(createVMEffectFunction({
    methodId, frontendId: 'dex', exceptionRegions: [], aggregateCompleteness: 'exact',
    bundles: [
      bundle(0, 'const/4', { producedValues: [{ bits: 32, constant: 1 }] }),
      bundle(2, 'const/4', { producedValues: [{ bits: 32, constant: 32 }] }),
      bundle(4, 'shl-int/2addr', { consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(6, 'return-void', { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  const node = shiftNode(lowered);
  if (node) {
    assert.equal(node.completeness, 'complete', 'dex shift not downgraded by the #8999 (wasm/jvm-only) repair');
    assert.equal(lowered.semanticIr.completeness, 'complete');
  }
});
