import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RISCV_LP64_ABI,
  RISCV_LP64F_ABI,
  RISCV_LP64D_ABI,
  RISCV_VECTOR_VSTART_CONTRACT,
} from '../../../js/targets/abi/riscv-lp64.js';

// #5707: the RISC-V psABI standard vector convention makes v0-v31 temporaries
// (not preserved across calls) and gives vl/vtype/vxrm/vxsat no cross-call
// guarantee. The riscv_vector_cc variant instead keeps v1-v7/v24-v31 alive
// across calls. `vstart` is neither caller- nor callee-saved: it carries a
// dedicated zero-on-call-boundary contract.

const VECTOR_CSRS = ['vl', 'vtype', 'vxrm', 'vxsat'];
const VECTOR_CC_ALIASES = ['riscv_vector_cc', 'riscv-vector-variant'];

test('#5707 standard lp64 call clobbers v0/v8/v31 and the vector CSRs', () => {
  const saved = RISCV_LP64_ABI.callerSaved();
  for (const reg of ['v0', 'v8', 'v31']) {
    assert.ok(saved.includes(reg), `${reg} must be caller-clobbered`);
  }
  for (const csr of VECTOR_CSRS) {
    assert.ok(saved.includes(csr), `${csr} must be caller-clobbered`);
  }
  assert.ok(saved.includes('x1'), 'integer caller-saved state is unchanged');
});

test('#5707 standard lp64d call keeps the fp width discipline while clobbering vector state', () => {
  const proven = RISCV_LP64D_ABI.callerSaved({ valueWidthBits: 64 });
  const unproven = RISCV_LP64D_ABI.callerSaved({ valueWidthBits: 128 });
  assert.ok(!proven.includes('f8') && unproven.includes('f8'),
    'the fp callee-saved-width discipline must be unchanged');
  for (const reg of ['v0', 'v15', 'v31']) {
    assert.ok(proven.includes(reg) && unproven.includes(reg),
      `${reg} stays caller-clobbered alongside the fp rules`);
  }
});

test('#5707 riscv_vector_cc clobbers v0 and the v8-v23 argument window', () => {
  for (const convention of VECTOR_CC_ALIASES) {
    const saved = RISCV_LP64_ABI.callerSaved({ callingConvention: convention });
    for (const reg of ['v0', 'v8', 'v23']) {
      assert.ok(saved.includes(reg), `${reg} must be caller-clobbered under ${convention}`);
    }
    for (const csr of VECTOR_CSRS) {
      assert.ok(saved.includes(csr), `${csr} must be caller-clobbered under ${convention}`);
    }
  }
});

test('#5707 riscv_vector_cc preserves v1-v7 and v24-v31 across calls', () => {
  for (const convention of VECTOR_CC_ALIASES) {
    const caller = RISCV_LP64_ABI.callerSaved({ callingConvention: convention });
    const callee = RISCV_LP64_ABI.calleeSaved({ callingConvention: convention });
    for (const reg of ['v1', 'v7', 'v24', 'v31']) {
      assert.ok(!caller.includes(reg), `${reg} must not be caller-clobbered under ${convention}`);
      assert.ok(callee.includes(reg), `${reg} must be callee-saved under ${convention}`);
    }
  }
});

test('#5707 standard convention preserves no vector register across calls', () => {
  const saved = RISCV_LP64_ABI.calleeSaved();
  for (const reg of ['v0', 'v8', 'v31']) {
    assert.ok(!saved.includes(reg), `${reg} must not survive a standard-convention call`);
  }
  // Requests without a convention id use the standard convention's wider
  // (safer) caller-clobber set.
  assert.ok(RISCV_LP64_ABI.callerSaved().includes('v31'));
});

test('#5707 vstart is excluded from every preservation set and pinned by its own contract', () => {
  for (const request of [{}, { callingConvention: 'riscv_vector_cc' }]) {
    assert.ok(!RISCV_LP64_ABI.callerSaved(request).includes('vstart'),
      'vstart is not a plain caller-saved register');
    assert.ok(!RISCV_LP64_ABI.calleeSaved(request).includes('vstart'),
      'vstart is not callee-saved either');
  }
  assert.deepEqual(RISCV_VECTOR_VSTART_CONTRACT, {
    register: 'vstart',
    contract: 'zero-on-call-boundary',
    preservedAcrossCalls: false,
    zeroAssumedAtProcedureEntry: true,
    mustZeroBeforeReturnOrCall: true,
  });
});

test('#5707 defaultUnknownCallEffects registerClobbers equal the callerSaved truth', () => {
  for (const abi of [RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    const effects = abi.defaultUnknownCallEffects();
    assert.deepEqual([...effects.registerClobbers], [...abi.callerSaved()],
      'unknown calls must use the same canonical preservation source');
    assert.ok(effects.registerClobbers.includes('v5') && effects.registerClobbers.includes('v17'));
    assert.equal(effects.memoryEffects, 'unknown');
  }
});
