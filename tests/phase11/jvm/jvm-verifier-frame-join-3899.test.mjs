import assert from 'node:assert/strict';
import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

function bundle(bytecodeOffset, opcode, controlEffects = []) {
  return { bytecodeOffset, opcode, completeness: 'exact', controlEffects };
}

function decoded({ bundles, codeLength, maxStack = 2, maxLocals = 2 }) {
  return {
    metadata: {
      descriptor: '()V',
      accessFlags: 0x0008,
      methodName: 'm',
      hasCode: true,
      codeLength,
      classMajorVersion: 49,
    },
    entryState: { maxStack, maxLocals },
    bundles,
    exceptionRegions: [],
  };
}

// Divergent dead locals merge to unusable state instead of invalidating the whole method.
{
  const report = verifyJvmMethod(decoded({
    maxStack: 1,
    maxLocals: 1,
    codeLength: 12,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
      bundle(4, 0x04),
      bundle(5, 0x3b),
      bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 11 }]),
      bundle(9, 0x01),
      bundle(10, 0x4b),
      bundle(11, 0xb1, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
}

// A category-2 local overlapping a category-1 local degrades the pair to unusable at the join.
{
  const report = verifyJvmMethod(decoded({
    codeLength: 12,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
      bundle(4, 0x09),
      bundle(5, 0x3f),
      bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 11 }]),
      bundle(9, 0x04),
      bundle(10, 0x3b),
      bundle(11, 0xb1, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
}

// If code later requires the lost category-2 local type, fail closed at that use.
{
  const report = verifyJvmMethod(decoded({
    codeLength: 14,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
      bundle(4, 0x09),
      bundle(5, 0x3f),
      bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 11 }]),
      bundle(9, 0x04),
      bundle(10, 0x3b),
      bundle(11, 0x1e),
      bundle(12, 0x58),
      bundle(13, 0xb1, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-local-type-mismatch' && error.offset === 11));
}

// Stack joins keep height/category strict: category-1 vs category-2 remains invalid.
{
  const report = verifyJvmMethod(decoded({
    codeLength: 12,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
      bundle(4, 0x04),
      bundle(5, 0x00),
      bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 10 }]),
      bundle(9, 0x09),
      bundle(10, 0x58),
      bundle(11, 0xb1, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-incompatible-frame-merge'));
}
