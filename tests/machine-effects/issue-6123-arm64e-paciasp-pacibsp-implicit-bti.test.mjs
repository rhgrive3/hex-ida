import assert from "node:assert/strict";
import { liftArm64eEffects } from "../../js/targets/architecture/arm64e/effects.js";
import { decorateArm64BtiGuardedPageEffects } from "../../js/targets/architecture/arm64/effects/bti-guard-state.js";

function liftWithBti(insn, context = {}) {
  const base = liftArm64eEffects(insn, context);
  if (!base) return null;
  return decorateArm64BtiGuardedPageEffects(insn, base, context);
}

const paciasp = {
  mnemonic: "paciasp",
  rawBytes: Uint8Array.from([0x7f, 0x23, 0x03, 0xd5]),
  address: 0x1000n,
  ops: [],
};

const pacibsp = {
  mnemonic: "pacibsp",
  rawBytes: Uint8Array.from([0x7f, 0x23, 0x03, 0xd5]),
  address: 0x1004n,
  ops: [],
};

function btypeWrites(bundle) {
  return bundle.operations.filter(op =>
    op.kind === "register-write" && op.register?.registerId === "pstate.btype"
  );
}

function hasBranchTargetFault(bundle) {
  return bundle?.possibleFaults?.some(f => f.kind === "branch-target-exception") ?? false;
}

// 0: PACIASP: guarded + BTYPE=0 -> implicit BTI check is skipped; PAC and BTYPE reset still execute.
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guarded-zero-btype",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 0,
  });
  assert.ok(result);
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result), "BTYPE=0 must not trigger a Branch Target Exception");
  assert.equal(btypeWrites(result).length, 1, "must still reset pstate.btype");
  assert.equal(btypeWrites(result)[0].value.value, "0");
  assert.ok(result.operations.some(op => op.kind === "intrinsic" && op.intrinsicId === "arm64e.pointer.sign"));
}

// 1: PACIASP: guarded + compatible call BTYPE (0b01 = 1) -> PAC path + no triggered Branch Target Exception
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guarded-compatible-1",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 1,
  });
  assert.ok(result, "result must not be null");
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result), "compatible BTYPE=1 must not trigger branch target exception");
  assert.equal(btypeWrites(result).length, 1, "must reset pstate.btype");
  assert.equal(btypeWrites(result)[0].value.value, "0");
  // Check PAC sign intrinsic is present
  assert.ok(result.operations.some(op => op.kind === "intrinsic" && op.intrinsicId === "arm64e.pointer.sign"));
}

// 1b: PACIASP: guarded + compatible call BTYPE (0b10 = 2)
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guarded-compatible-2",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 2,
  });
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result));
}

// 2: PACIASP: guarded + BTYPE=0b11 + incompatible SCTLR policy (sctlrBt=true/1) -> Branch Target Exception pathあり
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guarded-btype3-incompatible",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 3,
    sctlrBt: true,
  });
  assert.ok(result);
  assert.ok(hasBranchTargetFault(result), "BTYPE=3 with incompatible SCTLR policy must have branch target exception");
}

// 2b: PACIASP: guarded + BTYPE=0b11 + compatible SCTLR policy (sctlrBt=false/0) -> no fault
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guarded-btype3-compatible",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 3,
    sctlrBt: false,
  });
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result), "BTYPE=3 with compatible SCTLR must not trigger fault");
}

// 3: PACIBSP symmetry
{
  // Zero BTYPE: no implicit BTI fault, but PAC/BTYPE reset stay live.
  const resZero = liftWithBti(pacibsp, {
    instructionId: "test:pacibsp:zero-btype",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 0,
  });
  assert.equal(resZero.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(resZero));
  assert.equal(btypeWrites(resZero).length, 1);

  // Compatible
  const resCompat = liftWithBti(pacibsp, {
    instructionId: "test:pacibsp:compatible",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 1,
  });
  assert.equal(resCompat.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(resCompat));

  // Incompatible
  const resIncompat = liftWithBti(pacibsp, {
    instructionId: "test:pacibsp:incompatible",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 3,
    sctlrBt: true,
  });
  assert.ok(hasBranchTargetFault(resIncompat));
}

// 4: unguarded page -> implicit BTIによるfaultなし, PAC semantics維持
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:unguarded",
    btiGuardedPage: { mappedPageGuarded: false },
    incomingBtype: 3,
    sctlrBt: true,
  });
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result), "unguarded page must never trigger branch target exception");
  assert.equal(btypeWrites(result).length, 1);
}

// 5: guard unknown -> false-exactにしない (completeness is partial)
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:guard-unknown",
    btiGuardedPage: { state: "unknown" },
  });
  assert.equal(result.completeness, "partial", "unknown guard state must not be exact");
  assert.ok(hasBranchTargetFault(result), "unknown guard state must carry conditional fault");
}

// 5b: policy unknown when BTYPE=3 -> false-exactにしない
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:policy-unknown",
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 3,
    sctlrBt: null,
  });
  assert.equal(result.completeness, "partial", "unknown SCTLR policy with BTYPE=3 must not be exact");
  assert.ok(hasBranchTargetFault(result));
}

// 6: FEAT_BTI false -> implicit BTI check is not required
{
  const result = liftWithBti(paciasp, {
    instructionId: "test:paciasp:feat-bti-false",
    featBti: false,
    btiGuardedPage: { mappedPageGuarded: true },
    incomingBtype: 3,
    sctlrBt: true,
  });
  assert.equal(result.completeness, "exact-with-intrinsic");
  assert.ok(!hasBranchTargetFault(result), "featBti=false must not perform implicit BTI check");
}

console.log("issue #6123 ARM64e PACIASP/PACIBSP implicit BTI tests: PASS");
