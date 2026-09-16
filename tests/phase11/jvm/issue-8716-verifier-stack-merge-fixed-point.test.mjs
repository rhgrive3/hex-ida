import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

function exactBundle(bytecodeOffset, opcode, extra = {}) {
  return { bytecodeOffset, opcode, completeness: 'exact', controlEffects: [], ...extra };
}

test('#8716 stack-only widening republishes the joined frame before downstream verification', () => {
  // Real bytecode boundaries:
  //   0 iconst_0
  //   1 ifeq 9
  //   4 ldc        -> unknown1
  //   6 goto 13
  //   9 iconst_1   -> int
  //  10 goto 13
  //  13 fstore_0
  //  14 return
  //
  // The branch target is queued first, so the join at 13 is initially
  // published with stack ['int']. Before offset 13 is dequeued, the fallthrough
  // path merges ['unknown1'] into the same frame while locals remain identical.
  // mergeStates() must treat that stack widening as a state change and replace
  // the published frame. Otherwise fstore_0 sees stale 'int' and reports a
  // false jvm-stack-type-mismatch.
  const report = verifyJvmMethod({
    metadata: {
      descriptor: '()V',
      accessFlags: 0x0008,
      methodName: 'm',
      hasCode: true,
      codeLength: 15,
      classMajorVersion: 49,
    },
    entryState: { maxStack: 1, maxLocals: 1 },
    bundles: [
      exactBundle(0, 0x03),
      exactBundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      exactBundle(4, 0x12),
      exactBundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 13 }] }),
      exactBundle(9, 0x04),
      exactBundle(10, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 13 }] }),
      exactBundle(13, 0x43),
      exactBundle(14, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
    exceptionRegions: [],
  });

  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.equal(report.status, 'partial', 'ldc type resolution remains conservatively partial');
  assert.ok(report.warnings.some((warning) => warning.code === 'ldc-type-resolution:4'));
  assert.equal(report.verifierFacts.find((fact) => fact.kind === 'jvm-stack-local-dataflow')?.checked, true);
});
