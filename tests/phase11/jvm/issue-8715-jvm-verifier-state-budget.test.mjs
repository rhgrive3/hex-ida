import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

function bundle(bytecodeOffset, opcode, extra = {}) {
  return { bytecodeOffset, opcode, completeness: 'exact', controlEffects: [], ...extra };
}

function decoded({ bundles, codeLength, maxStack = 0, maxLocals = 2, descriptor = '()V' }) {
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

function dataflowFact(report) {
  return report.verifierFacts.find((fact) => fact.kind === 'jvm-stack-local-dataflow') ?? null;
}

// #8715 regression 1/2: max_locals is a semantic bound, not an eager per-state
// storage size. A straight-line 65535-locals method must verify while retaining
// O(1) frames, so a budget far below max_locals x instructions still completes
// (the old per-instruction dense clone needed > 65535 per program point).
test('#8715 JVM dense untouched locals share structurally and stay under an aggregate budget', () => {
  const nops = 300;
  const bundles = Array.from({ length: nops }, (_, i) => bundle(i, 0x00));
  bundles.push(bundle(nops, 0xb1, { controlEffects: [{ kind: 'return' }] }));
  const case1 = decoded({ bundles, codeLength: nops + 1, maxStack: 0, maxLocals: 65535 });
  const report = verifyJvmMethod(case1, {});
  assert.equal(report.status, 'valid');
  assert.equal(dataflowFact(report).checked, true);

  // 65535 initial + 65535 one COW write = 131070, far below 4M default.
  const tight = verifyJvmMethod(case1, { maxVerifierStateCells: 100_000 });
  assert.equal(tight.status, 'valid', 'untouched locals must not multiply by instruction count');
  assert.equal(dataflowFact(tight).checked, true);

  // Once the method actually writes locals, the single COW copy is charged,
  // so a budget between the shared and written totals fails closed instead
  // of trusting unbounded churn.
  const writeBundles = [bundle(0, 0x09), bundle(1, 0x37, { locationWrites: [{ kind: 'local', index: 3, bits: 64 }] }), bundle(3, 0xb1, { controlEffects: [{ kind: 'return' }] })];
  const writeCase = decoded({ bundles: writeBundles, codeLength: 4, maxStack: 2, maxLocals: 65535 });
  assert.equal(verifyJvmMethod(writeCase, {}).status, 'valid');
  assert.equal(verifyJvmMethod(writeCase, { maxVerifierStateCells: 100_000 }).status, 'partial');
});

// #8715 regression 9: a deliberately low verifier-state budget rejects before
// the large snapshots are allocated, and the pass degrades to explicit
// unverified partial — never a fake valid and never an "invalid" verdict for
// a method that is spec-clean.
test('#8715 JVM aggregate state budget fails closed before materializing frames', () => {
  const nops = 300;
  const bundles = Array.from({ length: nops }, (_, i) => bundle(i, 0x00));
  bundles.push(bundle(nops, 0xb1, { controlEffects: [{ kind: 'return' }] }));
  const report = verifyJvmMethod(decoded({ bundles, codeLength: nops + 1, maxLocals: 65535 }), { maxVerifierStateCells: 1000 });
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0);
  assert.equal(dataflowFact(report).checked, false);
  assert.ok(report.warnings.some((warning) => warning.code === 'jvm-verifier-state-budget-exceeded'));
});

// #8715 regression 3: legal accesses near a huge declared frame stay exact;
// the copy-on-write path preserves category-2 head/tail semantics.
test('#8715 JVM high-index category-2 local access remains valid on a dense frame', () => {
  const bundles = [
    bundle(0, 0x09),
    bundle(1, 0x37, { locationWrites: [{ kind: 'local', index: 65533, bits: 64 }] }),
    bundle(3, 0x16, { locationReads: [{ kind: 'local', index: 65533, bits: 64 }] }),
    bundle(5, 0x58),
    bundle(6, 0xb1, { controlEffects: [{ kind: 'return' }] }),
  ];
  const report = verifyJvmMethod(decoded({ bundles, codeLength: 7, maxStack: 2, maxLocals: 65535 }), {});
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);

  // Out-of-range reads/writes still fail closed with the existing codes.
  const outOfRange = [
    bundle(0, 0x09),
    bundle(1, 0x37, { locationWrites: [{ kind: 'local', index: 65534, bits: 64 }] }),
    bundle(3, 0xb1, { controlEffects: [{ kind: 'return' }] }),
  ];
  const bad = verifyJvmMethod(decoded({ bundles: outOfRange, codeLength: 4, maxStack: 2, maxLocals: 65535 }), {});
  assert.equal(bad.status, 'invalid');
  assert.ok(bad.errors.some((error) => error.code === 'jvm-local-index-out-of-range'));
});

// #8715 regression 4: branch/join merge authority is unchanged by the
// shared/charged representation: incompatible stacks still invalidate, and a
// clean join still completes the dataflow pass.
test('#8715 JVM frame-join semantics survive the shared-locals representation', () => {
  const join = decoded({
    codeLength: 12,
    maxStack: 2,
    maxLocals: 4,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      bundle(4, 0x04),
      bundle(5, 0x3b),
      bundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 11 }] }),
      bundle(9, 0x01),
      bundle(10, 0x4b),
      bundle(11, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  });
  const ok = verifyJvmMethod(join, {});
  assert.equal(ok.status, 'valid');
  assert.equal(dataflowFact(ok).checked, true);

  const incompatible = decoded({
    codeLength: 12,
    maxStack: 2,
    maxLocals: 4,
    bundles: [
      bundle(0, 0x03),
      bundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      bundle(4, 0x04),
      bundle(5, 0x00),
      bundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 10 }] }),
      bundle(9, 0x09),
      bundle(10, 0x58),
      bundle(11, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  });
  const bad = verifyJvmMethod(incompatible, {});
  assert.equal(bad.status, 'invalid');
  assert.ok(bad.errors.some((error) => error.code === 'jvm-incompatible-frame-merge'));
});
