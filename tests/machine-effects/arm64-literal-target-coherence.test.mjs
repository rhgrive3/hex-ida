import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';

const base = 0x1000n;
let sequence = 0;

function ldrLiteral({ pcRelTarget, literalTarget, immediate = 0x1004n, rawBytes = [0x20, 0x00, 0x00, 0x58], address = base } = {}) {
  const instructionId = `ldr-literal-coherence-${++sequence}`;
  return {
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic: 'ldr',
    address,
    ...(pcRelTarget === undefined ? {} : { pcRelTarget }),
    ...(literalTarget === undefined ? {} : { literalTarget }),
    ...(rawBytes === undefined ? {} : { rawBytes }),
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      ...(immediate === undefined ? [] : [{ k: 'imm', value: immediate }]),
    ],
    origin: { instructionIds: [instructionId] },
  };
}

function prfmLiteral({ pcRelTarget, rawBytes = [0x20, 0x00, 0x00, 0xd8], immediate = 0x1004n, address = base } = {}) {
  const instructionId = `prfm-literal-coherence-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic: 'prfm',
    address,
    ...(pcRelTarget === undefined ? {} : { pcRelTarget }),
    ...(rawBytes === undefined ? {} : { rawBytes }),
    ops: [{ k: 'other', text: 'pldl1keep' }, { k: 'imm', value: immediate }],
    origin: { instructionIds: [instructionId] },
  });
}

function memoryReadTarget(bundle) {
  return bundle?.operations?.find((operation) => operation.kind === 'memory-read')?.metadata?.target;
}

// #6078: the literal path used a first-present priority over the four
// canonical target evidences (encoding imm19, immediate operand, pcRelTarget,
// literalTarget). A contradictory redundant field silently relocated an exact
// memory read to a different literal-pool slot.

// Encoding + operand agree on 0x1004; contradictory pcRelTarget must fail closed.
{
  const conflict = liftArm64MachineEffects(ldrLiteral({ pcRelTarget: 0x1008n }));
  assert.equal(conflict?.completeness, 'partial', 'contradictory pcRelTarget must fail closed');
  assert.equal(conflict.operations.length, 0, 'contradictory evidence emits zero definite operations');
}
// Same for literalTarget.
{
  const conflict = liftArm64MachineEffects(ldrLiteral({ pcRelTarget: 0x1004n, literalTarget: 0x1008n }));
  assert.equal(conflict?.completeness, 'partial', 'contradictory literalTarget must fail closed');
}
// All evidences agree → exact read at the agreed slot.
{
  const agree = liftArm64MachineEffects(ldrLiteral({ pcRelTarget: 0x1004n, literalTarget: 0x1004n }));
  assert.equal(agree?.completeness, 'exact', agree?.unknownEffects?.reason);
  assert.equal(memoryReadTarget(agree), '4100');
}
// Encoding and immediate agree without structured fields: exact at imm19 target.
{
  const encodingOnly = liftArm64MachineEffects(ldrLiteral({ pcRelTarget: undefined, literalTarget: undefined }));
  assert.equal(encodingOnly?.completeness, 'exact');
  assert.equal(memoryReadTarget(encodingOnly), '4100');
}
// Structured + operand agreement without encoding evidence keeps working.
{
  const structured = liftArm64MachineEffects(ldrLiteral({ rawBytes: undefined, pcRelTarget: 0x1004n }));
  assert.equal(structured?.completeness, 'exact');
  assert.equal(memoryReadTarget(structured), '4100');
}
// Negative imm19 displacement decodes and must agree with the structured target.
{
  // ldr x0, <PC-4> → imm19 = -1 → target = 0x1000 - 4 = 0x0ffc
  const negativeWord = [0xe0, 0xff, 0xff, 0x58];
  const negative = liftArm64MachineEffects(ldrLiteral({ rawBytes: negativeWord, pcRelTarget: 0xffcn, immediate: 0xffcn }));
  assert.equal(negative?.completeness, 'exact', negative?.unknownEffects?.reason);
  assert.equal(memoryReadTarget(negative), '4092');
  const contradictory = liftArm64MachineEffects(ldrLiteral({ rawBytes: negativeWord, pcRelTarget: 0x1004n, immediate: 0xffcn }));
  assert.equal(contradictory?.completeness, 'partial', 'contradictory negative-displacement evidence fails closed');
}
// 64-bit wraparound evidence uses one unsigned architectural representation
// before equality. PC=0x10 with imm19=-8 reaches 0xfffffffffffffff0.
{
  const target = 0xfffffffffffffff0n;
  const rawBytes = [0x00, 0xff, 0xff, 0x58];
  const wrapped = liftArm64MachineEffects(ldrLiteral({ rawBytes, address: 0x10n, pcRelTarget: target, immediate: target }));
  assert.equal(wrapped?.completeness, 'exact', wrapped?.unknownEffects?.reason);
  assert.equal(memoryReadTarget(wrapped), target.toString());

  const mismatch = liftArm64MachineEffects(ldrLiteral({ rawBytes, address: 0x10n, pcRelTarget: target - 4n, immediate: target }));
  assert.equal(mismatch?.completeness, 'partial', 'genuinely different wrapped literal target stays contradictory');
  assert.equal(mismatch.operations.length, 0);
}
// PRFM has the same imm19 target authority and must accept the equivalent
// unsigned target while retaining fail-closed disagreement.
{
  const target = 0xfffffffffffffff0n;
  const rawBytes = [0x00, 0xff, 0xff, 0xd8];
  const wrapped = prfmLiteral({ rawBytes, address: 0x10n, pcRelTarget: target, immediate: target });
  assert.equal(wrapped?.completeness, 'exact-with-intrinsic', wrapped?.unknownEffects?.reason);
  const mismatch = prfmLiteral({ rawBytes, address: 0x10n, pcRelTarget: target - 4n, immediate: target });
  assert.equal(mismatch?.completeness, 'partial', 'PRFM wrapped target disagreement stays fail closed');
}
// Non-literal-class encoding word is invalidity evidence, not a match oracle.
{
  const notLiteral = liftArm64MachineEffects(ldrLiteral({ rawBytes: [0x00, 0x00, 0x80, 0xd2] }));
  assert.equal(notLiteral?.completeness, 'partial', 'non-literal word with a literal claim must fail closed');
}
// PRFM (literal) coherence: 0xd8000020 → imm19=1 → 0x1004.
{
  const agree = prfmLiteral({ pcRelTarget: 0x1004n });
  assert.equal(agree?.completeness, 'exact-with-intrinsic', agree?.unknownEffects?.reason);
  const conflict = prfmLiteral({ pcRelTarget: 0x1008n });
  assert.equal(conflict?.completeness, 'partial', 'PRFM literal contradictory target must fail closed');
}

// Redundant malformed evidence is not absent evidence. Exercise both the
// architecture dispatcher and the canonical family provider: valid encoding
// or immediate evidence must never mask a malformed structured target.
for (const mnemonic of ['ldr', 'ldrsw', 'prfm']) {
  for (const withEncoding of [false, true]) {
    const decoded = ldrLiteral({ pcRelTarget: 0x1004n, literalTarget: 0x1004n });
    decoded.mnemonic = mnemonic;
    decoded.rawBytes[3] = { ldr: 0x58, ldrsw: 0x98, prfm: 0xd8 }[mnemonic];
    if (!withEncoding) delete decoded.rawBytes;
    if (mnemonic === 'prfm') decoded.ops[0] = { k: 'other', text: 'pldl1keep' };
    for (const lift of [liftArm64MachineEffects, liftArm64MemoryEffects]) {
      const expected = mnemonic === 'prfm' ? 'exact-with-intrinsic' : 'exact';
      for (const valid of [4100n, 4100, '4100', '0x1004']) {
        const result = lift({ ...decoded, pcRelTarget: valid, literalTarget: valid });
        assert.equal(result?.completeness, expected, `${mnemonic}: canonical target must remain exact`);
        assert.equal(result.metadata.target, '4100');
      }
      for (const field of ['pcRelTarget', 'literalTarget', 'immediate']) {
        for (const invalid of [[4100], ['4100'], true, false, { value: 4100 }, '',
          '4100junk', '-0x1004', Number.NaN, 4100.5, Number.MAX_SAFE_INTEGER + 1,
          1n << 64n, -(1n << 63n) - 1n, (1n << 64n).toString()]) {
          const input = field === 'immediate'
            ? { ...decoded, ops: [decoded.ops[0], { k: 'imm', value: invalid }] }
            : { ...decoded, [field]: invalid };
          const result = lift(input);
          const label = `${mnemonic}/${withEncoding ? 'encoded' : 'structured'}/${field}`;
          assert.equal(result?.completeness, 'partial', `${label}: malformed evidence must not be ignored`);
          assert.equal(result.operations.length, 0, `${label}: no definite operations`);
        }
      }
      // Nullable structured fields mean no additional evidence; an existing
      // immediate operand, however, must contain a valid value.
      assert.equal(lift({ ...decoded, pcRelTarget: null, literalTarget: undefined }).completeness, expected);
      for (const value of [null, undefined]) {
        const result = lift({ ...decoded, ops: [decoded.ops[0], { k: 'imm', value }] });
        assert.equal(result.completeness, 'partial');
        assert.equal(result.operations.length, 0);
      }
      if (withEncoding) {
        const result = lift({ ...decoded, pcRelTarget: undefined, literalTarget: undefined });
        assert.equal(result.completeness, expected, 'encoding and immediate suffice without structured fields');
      }
    }
  }
}

console.log('ARM64 literal target evidence coherence (#6078): PASS');
