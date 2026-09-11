import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedRuntimeBinding,
  validateManagedRuntimeState,
} from '../../../js/managed/runtime-binding.js';

const baseInput = Object.freeze({
  frontendId: 'wasm',
  runtimeImplementation: 'wasmtime',
  runtimeVersion: '1',
  staticModuleIdentity: 'module-A',
  runtimeModuleIdentity: 'module-A',
  providerIdentity: 'provider-A',
  buildIdentity: 'build-A',
  runtimeInstanceIdentity: 'runtime-A',
  targetIdentity: 'target-A',
  binaryIdentity: 'binary-A',
  loadMappingIdentity: 'mapping-A',
  sessionIdentity: 'session-A',
  capabilityVersion: '1',
});

const limits = Object.freeze({
  maxThreads: { valid: 2, max: 4096, fallback: 256, error: /managed-runtime-max-threads-invalid/ },
  maxFramesPerThread: { valid: 2, max: 16384, fallback: 1024, error: /managed-runtime-max-frames-invalid/ },
  maxLocalsPerFrame: { valid: 2, max: 65536, fallback: 4096, error: /managed-runtime-max-locals-invalid/ },
  maxOperandStack: { valid: 2, max: 65536, fallback: 4096, error: /managed-runtime-max-stack-invalid/ },
});

function make(overrides = {}) {
  return createManagedRuntimeBinding({ ...baseInput, ...overrides });
}

test('#4924 managed runtime resource limits accept only primitive positive safe integers', () => {
  for (const [field, spec] of Object.entries(limits)) {
    assert.equal(make({ [field]: spec.valid })[field], spec.valid, `${field}: primitive integer preserved`);
    assert.equal(make({ [field]: spec.max })[field], spec.max, `${field}: inclusive maximum preserved`);

    for (const value of [0, -1, 1.5, NaN, Infinity, spec.max + 1, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => make({ [field]: value }), spec.error, `${field}: invalid primitive ${String(value)}`);
    }

    let conversions = 0;
    const coercibleObject = {
      valueOf() { conversions++; return spec.valid; },
      toString() { conversions++; return String(spec.valid); },
    };
    for (const value of [String(spec.valid), [spec.valid], true, false, coercibleObject, new Number(spec.valid)]) {
      assert.throws(() => make({ [field]: value }), spec.error, `${field}: structured/coercible input must fail closed`);
    }
    assert.equal(conversions, 0, `${field}: rejected objects must not be coerced`);
  }
});

test('#4924 nullish limits keep existing defaults', () => {
  for (const [field, spec] of Object.entries(limits)) {
    assert.equal(make({ [field]: null })[field], spec.fallback, `${field}: null uses fallback`);
    assert.equal(make({ [field]: undefined })[field], spec.fallback, `${field}: undefined uses fallback`);
  }
});

test('#4924 valid primitive limits still bound published runtime state', () => {
  const binding = make({
    maxThreads: 1,
    maxFramesPerThread: 1,
    maxLocalsPerFrame: 1,
    maxOperandStack: 1,
  });
  const frame = { moduleIdentity: 'module-A', locals: [1], operandStack: [2] };
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [frame] }] }).ok, true);
  assert.equal(validateManagedRuntimeState(binding, { threads: [{}, {}] }).reason, 'managed-runtime-thread-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [frame, frame] }] }).reason, 'managed-runtime-frame-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ ...frame, locals: [1, 2] }] }] }).reason, 'managed-runtime-local-budget-exceeded');
  assert.equal(validateManagedRuntimeState(binding, { threads: [{ frames: [{ ...frame, operandStack: [1, 2] }] }] }).reason, 'managed-runtime-stack-budget-exceeded');
});
