import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function ldrLiteral(pcRelTarget, address = 0x10n) {
  const instructionId = `ldr-literal-wrap-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic: 'ldr',
    address,
    pcRelTarget,
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'imm', value: pcRelTarget },
    ],
    origin: { instructionIds: [instructionId] },
  });
}

// #6044: the literal range gate used a raw BigInt subtraction while the
// architectural displacement is the modulo-2^64 signed difference. A valid
// LDR literal that wraps the 64-bit address boundary was misclassified as
// out-of-encoding-range and its valid memory read demoted to partial.
{
  const wrapped = ldrLiteral(0xfffffffffffffff0n, 0x10n);
  assert.equal(wrapped?.completeness, 'exact', wrapped?.unknownEffects?.reason);
  const read = wrapped.operations.find((operation) => operation.kind === 'memory-read');
  assert.ok(read, 'wrapped literal keeps its memory read');
  assert.equal(read.metadata.target, 18446744073709551600n.toString());
}
// Positive wrap: PC near the top adds a small positive displacement.
{
  const positive = ldrLiteral(0x0000000000000010n, 0xfffffffffffffff0n);
  assert.equal(positive?.completeness, 'exact', positive?.unknownEffects?.reason);
}
// Genuinely out-of-range targets stay rejected.
{
  const tooFar = ldrLiteral(0x10000000n, 0x0n);
  assert.equal(tooFar?.completeness, 'partial');
  assert.equal(tooFar.unknownEffects?.reason, 'arm64-ldr-literal-target-out-of-range-encoding');
  const farNegative = ldrLiteral(0xffffffff00000000n, 0x10n);
  assert.equal(farNegative?.completeness, 'partial');
  assert.equal(farNegative.unknownEffects?.reason, 'arm64-ldr-literal-target-out-of-range-encoding');
}
// Ordinary in-range behavior is unchanged.
{
  const plain = ldrLiteral(0x1004n, 0x1000n);
  assert.equal(plain?.completeness, 'exact');
  const minimum = ldrLiteral(BigInt.asUintN(64, 0x1000n - (1n << 20n)), 0x1000n);
  assert.equal(minimum?.completeness, 'exact', minimum?.unknownEffects?.reason);
  const maximum = ldrLiteral(0x1000n + ((1n << 20n) - 4n), 0x1000n);
  assert.equal(maximum?.completeness, 'exact', maximum?.unknownEffects?.reason);
}

console.log('ARM64 literal target 64-bit wraparound (#6044): PASS');
