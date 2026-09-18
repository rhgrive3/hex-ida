/**
 * Independent synthetic AArch64 holdout functions for generalization checks.
 *
 * These fixtures are authored for this suite. They do not contain CodeFuse
 * binaries, addresses, case/function names, reference text, or benchmark data.
 * The assertions are semantic/architectural contracts rather than snapshots of
 * the current pseudocode renderer.
 */

export const HOLDOUT_BASE = 0x710000n;

export const ARM64_GENERALIZATION_HOLDOUT_FIXTURES = Object.freeze([
  Object.freeze({
    id: 'holdout-arithmetic-return',
    dimension: 'basic AArch64 arithmetic + return',
    lines: Object.freeze(['add x0, x0, #7', 'ret']),
    overfitGuard: 'Checks 64-bit add/return semantics over independent boundary values, not renderer text.',
  }),
  Object.freeze({
    id: 'holdout-conditional-cfg',
    dimension: 'conditional branch / CFG + condition flags',
    lines: Object.freeze([
      'cmp x0, #0',
      'b.eq #0x710010',
      'add x0, x0, #1',
      'b #0x710014',
      'sub x0, x0, #1',
      'ret',
    ]),
    overfitGuard: 'Checks fixed input/output branch semantics through the taken/fallthrough CFG and merged x0 return.',
  }),
  Object.freeze({
    id: 'holdout-loop-backedge',
    dimension: 'loop / CFG',
    lines: Object.freeze([
      'mov x1, #0',
      'cmp x1, x0',
      'b.ge #0x710014',
      'add x1, x1, #1',
      'b #0x710004',
      'mov x0, x1',
      'ret',
    ]),
    overfitGuard: 'Requires an independently authored back-edge and loop-header proof, not a particular loop spelling.',
  }),
  Object.freeze({
    id: 'holdout-stack-frame-memory',
    dimension: 'load/store + stack frame + callee-saved/SP alignment',
    lines: Object.freeze([
      'stp x29, x30, [sp, #-32]!',
      'mov x29, sp',
      'str x0, [sp, #16]',
      'ldr x1, [sp, #16]',
      'add x0, x1, #2',
      'ldp x29, x30, [sp], #32',
      'ret',
    ]),
    overfitGuard: 'Checks stack-memory forwarding plus IR-derived pre/post-index SP deltas and 16-byte alignment.',
  }),
  Object.freeze({
    id: 'holdout-aapcs64-call',
    dimension: 'call + AAPCS64 argument/return behavior',
    lines: Object.freeze([
      'mov x0, x1',
      'mov x1, x2',
      'bl #0x720000',
      'add x0, x0, #1',
      'ret',
    ]),
    overfitGuard: 'Checks the reaching SSA definitions that forward incoming x1/x2 into physical call x0/x1, plus x0 return flow.',
  }),
  Object.freeze({
    id: 'holdout-sign-zero-extension',
    dimension: 'sign/zero extension',
    lines: Object.freeze([
      'sxtw x1, w0',
      'uxtw x2, w0',
      'add x0, x1, x2',
      'ret',
    ]),
    overfitGuard: 'Uses 32-bit signed/unsigned boundary values to distinguish SXTW from UXTW semantically.',
  }),
  Object.freeze({
    id: 'holdout-w-write-zero-extends-x',
    dimension: 'W-register write zero-extends X register',
    lines: Object.freeze([
      'mov w0, #-1',
      'add w0, w0, #1',
      'ret',
    ]),
    overfitGuard: 'Requires the architectural 32-bit write result to materialize as a 64-bit x0 value equal to zero.',
  }),
  Object.freeze({
    id: 'holdout-pair-stack-roundtrip',
    dimension: 'pair load/store (stp/ldp)',
    lines: Object.freeze([
      'stp x0, x1, [sp, #-16]!',
      'ldp x2, x3, [sp], #16',
      'add x0, x2, x3',
      'ret',
    ]),
    overfitGuard: 'Requires both members of the pair to survive a stack roundtrip and contribute to the return value.',
  }),
  Object.freeze({
    id: 'holdout-indirect-open-target',
    dimension: 'switch/indirect control flow',
    lines: Object.freeze([
      'cmp x0, #1',
      'b.hi #0x710010',
      'br x1',
      'mov x0, #7',
      'ret',
    ]),
    expectFailClosed: true,
    overfitGuard: 'An unresolved BR target must stay open/unknown and may not be guessed into one CFG successor.',
  }),
  Object.freeze({
    id: 'holdout-unsupported-ldaxp',
    dimension: 'intentionally unsupported instruction fail-closed counterexample',
    lines: Object.freeze([
      'ldaxp x0, x1, [x2]',
      'ret',
    ]),
    expectFailClosed: true,
    overfitGuard: 'Uses an actual AArch64 pair-exclusive instruction whose exact effects are intentionally unowned; unknown must remain explicit.',
  }),
  Object.freeze({
    id: 'holdout-adrp-add-address',
    dimension: 'ADRP + ADD address formation',
    lines: Object.freeze([
      'adrp x0, #0x4000',
      'add x0, x0, #0x120',
      'ret',
    ]),
    overfitGuard: 'Checks architecture address formation as a numeric semantic fact (0x4120), not emitted source text.',
  }),
  Object.freeze({
    id: 'holdout-literal-load',
    dimension: 'literal load',
    lines: Object.freeze([
      'ldr x0, #0x710010',
      'ret',
    ]),
    overfitGuard: 'Requires a memory load from the literal address and a value flow into the return register.',
  }),
]);

export const HOLDOUT_PROVENANCE = Object.freeze({
  schemaVersion: 'arm64-generalization-holdout/v1',
  sourceKind: 'test-authored-synthetic-aarch64',
  codeFuseDerived: false,
  benchmarkArtifactsUsed: false,
  claim: 'Independent synthetic AArch64 holdout; not CodeFuse, competitor, reference-text, browser, or physical-device evidence.',
});
