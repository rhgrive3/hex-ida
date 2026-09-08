import assert from 'node:assert/strict';
import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

function bundle(bytecodeOffset, opcode, controlEffects = []) {
  return { bytecodeOffset, opcode, completeness: 'exact', controlEffects };
}

function decoded({ bundles, codeLength, maxStack = 2, maxLocals = 2, descriptor = '()V' }) {
  return {
    metadata: {
      descriptor,
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

// Unresolved category-1 CP types stay unresolved through a same-category merge, so later use remains partial rather than invalid.
{
  const report = verifyJvmMethod(decoded({
    descriptor: '()I',
    maxStack: 1,
    maxLocals: 0,
    codeLength: 11,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
      bundle(4, 0x12),
      bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 10 }]),
      bundle(9, 0x03),
      bundle(10, 0xac, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((warning) => warning.code === 'ldc-type-resolution:4'));
}

// The same rule applies to category-2 CP values.
{
  const report = verifyJvmMethod(decoded({
    descriptor: '()J',
    maxStack: 2,
    maxLocals: 0,
    codeLength: 12,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 10 }]),
      bundle(4, 0x14),
      bundle(7, 0xa7, [{ kind: 'branch', targetOffset: 11 }]),
      bundle(10, 0x09),
      bundle(11, 0xad, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((warning) => warning.code === 'ldc2-type-resolution:4'));
}

function decodedWithVersion({ bundles, codeLength, classMajorVersion, maxStack = 2, maxLocals = 2, descriptor = '()V' }) {
  return {
    metadata: {
      descriptor,
      accessFlags: 0x0008,
      methodName: 'm',
      hasCode: true,
      codeLength,
      classMajorVersion,
    },
    entryState: { maxStack, maxLocals },
    bundles,
    exceptionRegions: [],
  };
}

function branchedExactMethod() {
  return [
    bundle(0, 0x03),
    bundle(1, 0x99, [{ kind: 'conditional-branch', targetOffset: 9 }]),
    bundle(4, 0x04),
    bundle(5, 0x3b),
    bundle(6, 0xa7, [{ kind: 'branch', targetOffset: 11 }]),
    bundle(9, 0x01),
    bundle(10, 0x4b),
    bundle(11, 0xb1, [{ kind: 'return' }]),
  ];
}

function dataflowFact(report) {
  return report.verifierFacts.find((fact) => fact.kind === 'jvm-stack-local-dataflow') ?? null;
}

// Missing class-version evidence must not be fabricated as major 0: the
// version-dependent StackMap obligation stays unproven, so an exact branched
// method degrades to partial instead of reaching valid.
{
  const report = verifyJvmMethod(decodedWithVersion({
    codeLength: 12,
    classMajorVersion: null,
    bundles: branchedExactMethod(),
  }));
  assert.notEqual(report.status, 'valid');
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((warning) => warning.code === 'class-version-evidence-missing'));
}

// Unknown version + InterfaceMethodref must not be hard-invalidated as an old
// version: the tag-11 reference is unproven, not a tag violation.
{
  const report = verifyJvmMethod(decodedWithVersion({
    codeLength: 4,
    maxStack: 2,
    maxLocals: 1,
    classMajorVersion: null,
    bundles: [
      { bytecodeOffset: 0, opcode: 0xb7, completeness: 'exact', controlEffects: [], callEffects: [{ cpIndex: 1 }] },
      bundle(3, 0xb1, [{ kind: 'return' }]),
    ],
  }), { image: { constantPool: [null, { tag: 11 }] } });
  assert.ok(!report.errors.some((error) => error.code === 'jvm-invalid-cp-operand-tag'));
  assert.ok(report.warnings.some((warning) => String(warning.code).startsWith('interface-methodref-version-unproven')));
  assert.notEqual(report.status, 'valid');
}

// A proven old version still hard-invalidates a tag-11 InterfaceMethodref.
{
  const report = verifyJvmMethod(decodedWithVersion({
    codeLength: 4,
    maxStack: 2,
    maxLocals: 1,
    classMajorVersion: 49,
    bundles: [
      { bytecodeOffset: 0, opcode: 0xb7, completeness: 'exact', controlEffects: [], callEffects: [{ cpIndex: 1 }] },
      bundle(3, 0xb1, [{ kind: 'return' }]),
    ],
  }), { image: { constantPool: [null, { tag: 11 }] } });
  assert.ok(report.errors.some((error) => error.code === 'jvm-invalid-cp-operand-tag'));
  assert.equal(report.status, 'invalid');
}

// Structural errors must not claim dataflow provenance: the dataflow pass
// never runs when an earlier error exists.
{
  const report = verifyJvmMethod(decodedWithVersion({
    codeLength: 6,
    classMajorVersion: 49,
    bundles: [
      bundle(0, 0xa7, [{ kind: 'branch', targetOffset: 99 }]),
      bundle(3, 0xb1, [{ kind: 'return' }]),
    ],
  }));
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-invalid-branch-target'));
  assert.equal(dataflowFact(report)?.checked, false);
}

// A clean dataflow pass keeps its positive provenance.
{
  const report = verifyJvmMethod(decodedWithVersion({
    codeLength: 12,
    classMajorVersion: 49,
    bundles: branchedExactMethod(),
  }));
  assert.equal(report.status, 'valid');
  assert.equal(dataflowFact(report)?.checked, true);
}
