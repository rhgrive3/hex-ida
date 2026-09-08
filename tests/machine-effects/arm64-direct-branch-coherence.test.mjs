import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function branch({ mnemonic = 'b', rawBytes, explicitKind = 'branchTarget', explicitTarget, operandTarget = 0x1004n, extraOps = [], address = 0x1000n } = {}) {
  const instructionId = `direct-branch-coherence-${++sequence}`;
  const ops = [];
  if (mnemonic === 'cbz' || mnemonic === 'tbz' || mnemonic === 'tbnz') {
    ops.push({ k: 'reg', cls: 'gp', num: 1, bits: 64, text: 'x1' });
    if (mnemonic === 'tbz' || mnemonic === 'tbnz') ops.push({ k: 'imm', value: 0n });
  }
  if (operandTarget !== undefined) ops.push({ k: 'imm', value: operandTarget });
  ops.push(...extraOps);
  return liftArm64MachineEffects({
    instructionId,
    mode: 'a64',
    address,
    mnemonic,
    ...(rawBytes === undefined ? {} : { rawBytes }),
    ...(explicitTarget === undefined ? {} : { [explicitKind]: explicitTarget }),
    ops,
    origin: { instructionIds: [instructionId] },
  });
}

function targetOf(bundle) {
  return bundle?.controlEffect?.target?.value;
}

// #6067: `branchTarget`/`callTarget` took priority over operand and encoding
// evidence without any equality check, so a single contradictory redundant
// field relocated an exact control edge.

// B: encoding imm26=1 and operand both say 0x1004; contradictory
// branchTarget=0x1008 must fail closed instead of exacting 0x1008.
{
  const conflict = branch({ rawBytes: [0x01, 0x00, 0x00, 0x14], explicitTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial', 'contradictory branchTarget must fail closed');
  assert.match(conflict.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
  assert.equal(targetOf(conflict), undefined, 'no definite control edge from contradictory evidence');
}
// Agreeing evidence keeps the exact edge.
{
  const agree = branch({ rawBytes: [0x01, 0x00, 0x00, 0x14], explicitTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact');
  assert.equal(targetOf(agree), '4100');
}
// Encoding-only and operand-only records keep their exact behavior.
{
  const encodingOnly = branch({ rawBytes: [0x01, 0x00, 0x00, 0x14], explicitTarget: undefined });
  assert.equal(encodingOnly?.completeness, 'exact');
  assert.equal(targetOf(encodingOnly), '4100');
  const operandOnly = branch({ rawBytes: undefined, explicitTarget: 0x1004n });
  assert.equal(operandOnly?.completeness, 'exact');
  assert.equal(targetOf(operandOnly), '4100');
}
// BL symmetry with callTarget.
{
  const conflict = branch({ mnemonic: 'bl', rawBytes: [0x01, 0x00, 0x00, 0x94], explicitKind: 'callTarget', explicitTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial');
  assert.match(conflict.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
  const agree = branch({ mnemonic: 'bl', rawBytes: [0x01, 0x00, 0x00, 0x94], explicitKind: 'callTarget', explicitTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact');
  assert.equal(targetOf(agree), '4100');
}
// B.cond symmetry (imm19): word 0x54000020 = b.eq +4.
{
  const conflict = branch({ mnemonic: 'b.eq', rawBytes: [0x20, 0x00, 0x00, 0x54], explicitTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial');
  const agree = branch({ mnemonic: 'b.eq', rawBytes: [0x20, 0x00, 0x00, 0x54], explicitTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact');
  assert.equal(targetOf(agree), '4100');
}
// CBZ symmetry (imm19): word 0x34000021 = cbz x1, +4.
{
  const conflict = branch({ mnemonic: 'cbz', rawBytes: [0x21, 0x00, 0x00, 0x34], explicitTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial');
  const agree = branch({ mnemonic: 'cbz', rawBytes: [0x21, 0x00, 0x00, 0x34], explicitTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact');
  assert.equal(targetOf(agree), '4100');
}
// TBNZ symmetry (imm14): word 0x37000021 = tbnz x1, #0, +4.
{
  const conflict = branch({ mnemonic: 'tbnz', rawBytes: [0x21, 0x00, 0x00, 0x37], explicitTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial');
  const agree = branch({ mnemonic: 'tbnz', rawBytes: [0x21, 0x00, 0x00, 0x37], explicitTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact');
  assert.equal(targetOf(agree), '4100');
}
// Backward branch (negative imm26) with agreeing evidence stays exact.
{
  // b .-4 → imm26 = -1 → word 0x17ffffff
  const backward = branch({ rawBytes: [0xff, 0xff, 0xff, 0x17], explicitTarget: 0xffcn, operandTarget: 0xffcn });
  assert.equal(backward?.completeness, 'exact', backward?.unknownEffects?.reason);
  assert.equal(targetOf(backward), '4092');
  const contradictory = branch({ rawBytes: [0xff, 0xff, 0xff, 0x17], explicitTarget: 0x1004n });
  assert.equal(contradictory?.completeness, 'partial');
}
// 64-bit target evidence must compare modulo the architectural address width.
// Negative wrap: PC=0x10, B/BL -0x20 reach unsigned 0xfffffffffffffff0.
{
  const target = 0xfffffffffffffff0n;
  const b = branch({ rawBytes: [0xf8, 0xff, 0xff, 0x17], explicitTarget: target, operandTarget: target, address: 0x10n });
  assert.equal(b?.completeness, 'exact', b?.unknownEffects?.reason);
  assert.equal(targetOf(b), target.toString());
  const bl = branch({ mnemonic: 'bl', rawBytes: [0xf8, 0xff, 0xff, 0x97], explicitKind: 'callTarget', explicitTarget: target, operandTarget: target, address: 0x10n });
  assert.equal(bl?.completeness, 'exact', bl?.unknownEffects?.reason);
  assert.equal(targetOf(bl), target.toString());
}
// Positive wrap: PC near 2^64 with +0x20 reaches canonical unsigned 0x10.
{
  const target = 0x10n;
  const b = branch({ rawBytes: [0x08, 0x00, 0x00, 0x14], explicitTarget: target, operandTarget: target, address: 0xfffffffffffffff0n });
  assert.equal(b?.completeness, 'exact', b?.unknownEffects?.reason);
  assert.equal(targetOf(b), target.toString());
  const bl = branch({ mnemonic: 'bl', rawBytes: [0x08, 0x00, 0x00, 0x94], explicitKind: 'callTarget', explicitTarget: target, operandTarget: target, address: 0xfffffffffffffff0n });
  assert.equal(bl?.completeness, 'exact', bl?.unknownEffects?.reason);
  assert.equal(targetOf(bl), target.toString());
}
// Canonicalization is equivalence-only: a genuinely different aligned target
// remains contradictory instead of being laundered into the encoded edge.
{
  const target = 0xfffffffffffffff0n;
  const mismatch = branch({ rawBytes: [0xf8, 0xff, 0xff, 0x17], explicitTarget: target - 4n, operandTarget: target, address: 0x10n });
  assert.equal(mismatch?.completeness, 'partial');
  assert.match(mismatch.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
}
// Encoding word contradicting the claimed class is invalidity evidence.
{
  const notBranch = branch({ rawBytes: [0x20, 0x00, 0x00, 0x58], explicitTarget: 0x1004n });
  assert.equal(notBranch?.completeness, 'partial', 'a non-branch word with a branch claim must fail closed');
}

// #6067: target authority must not coerce arrays, booleans, or objects through
// BigInt(). Invalid structured or operand evidence is present evidence and must
// fail closed rather than being ignored in favor of another source.
for (const hostile of [[0x1004n], true, { toString: () => '4100' }]) {
  const invalidStructured = branch({ explicitTarget: hostile });
  assert.equal(invalidStructured?.completeness, 'partial');
  assert.match(invalidStructured.unknownEffects?.reason ?? '', /target-unavailable|target-evidence-mismatch/);

  const invalidOperand = branch({ explicitTarget: 0x1004n, operandTarget: hostile });
  assert.equal(invalidOperand?.completeness, 'partial');
  assert.match(invalidOperand.unknownEffects?.reason ?? '', /operand-shape-unmodelled|target-evidence-mismatch/);
}

console.log('ARM64 direct branch target evidence coherence (#6067): PASS');
