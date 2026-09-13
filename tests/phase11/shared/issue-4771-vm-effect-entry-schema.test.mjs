import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectBundle,
} from '../../../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const identity = {
  frontendId: 'jvm',
  methodId: 'managed-method:issue-4771',
  operationId: 'vm-op:managed-method:issue-4771:0x0:0',
};

function bundle(overrides = {}) {
  return createVMEffectBundle({
    ...identity,
    bytecodeOffset: 0,
    mnemonic: 'synthetic-memory-op',
    completeness: 'exact',
    ...overrides,
  });
}

test('#4771 non-boolean isWrite ("false") is rejected by the canonical constructor', () => {
  assert.throws(
    () => bundle({ memoryEffects: [{ space: 'memory', isWrite: 'false' }] }),
    (error) => error instanceof TypeError && error.message === 'vm-effect-memory-effect-is-write-invalid',
  );
  for (const isWrite of ['true', 1, 0, null, {}, []]) {
    assert.throws(
      () => bundle({ memoryEffects: [{ space: 'memory', isWrite }] }),
      /vm-effect-memory-effect-is-write-invalid/,
      `isWrite=${JSON.stringify(isWrite)} must not be promoted to a boolean authority`,
    );
  }
});

test('#4771 boolean isWrite keeps load/store semantics through the bridge', () => {
  for (const [isWrite, kind] of [[false, 'load'], [true, 'store']]) {
    const fn = createVMEffectFunction({
      frontendId: identity.frontendId,
      methodId: identity.methodId,
      bundles: [bundle({ locationReads: [{ kind: 'register', index: 0 }], memoryEffects: [{ space: 'memory', isWrite, byteWidth: 4 }] })],
    });
    const lowered = lowerVMEffectsToSemanticIr(fn);
    const memory = lowered.semanticIr.nodes.filter((n) => n.kind === 'store' || n.kind === 'load');
    assert.equal(memory.length, 1, `${kind} node emitted`);
    assert.equal(memory[0].kind, kind);
  }
});

test('#4771 non-object memory/call/control/location entries are rejected', () => {
  for (const entry of [null, 5, 'x', true, [{}]]) {
    assert.throws(() => bundle({ memoryEffects: [entry] }), /vm-effect-invalid-memory-effect/);
    assert.throws(() => bundle({ callEffects: [entry] }), /vm-effect-invalid-call-effect/);
    assert.throws(() => bundle({ controlEffects: [entry] }), /vm-effect-invalid-control-effect/);
    assert.throws(() => bundle({ locationReads: [entry] }), /vm-effect-invalid-location-entry/);
    assert.throws(() => bundle({ locationWrites: [entry] }), /vm-effect-invalid-location-entry/);
  }
});

test('#4771 location kind outside VM_LOCATION_KINDS is rejected', () => {
  assert.throws(
    () => bundle({ locationReads: [{ kind: 'not-a-real-location', index: 0 }] }),
    (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-location-kind',
  );
  assert.equal(bundle({ locationReads: [{ kind: 'register', index: 0 }] }).locationReads[0].kind, 'register');
});

test('#4771 validateVMEffectBundle detects element-level tampering', () => {
  const tampered = {
    ...bundle({ locationReads: [{ kind: 'register', index: 0 }], memoryEffects: [{ space: 'memory', isWrite: true, byteWidth: 4 }] }),
  };
  assert.equal(validateVMEffectBundle(tampered), true);
  assert.throws(
    () => validateVMEffectBundle({ ...tampered, memoryEffects: [{ space: 'memory', isWrite: 'false' }] }),
    /vm-effect-memory-effect-is-write-invalid/,
  );
  assert.throws(
    () => validateVMEffectBundle({ ...tampered, locationWrites: ['nope'] }),
    /vm-effect-invalid-location-entry/,
  );
});

console.log('[phase11] issue #4771 vm-effect entry schema regression passed');
