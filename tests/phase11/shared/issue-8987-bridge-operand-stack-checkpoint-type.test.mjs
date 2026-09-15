import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #8987 — the managed bridge enables a cross-block operand-stack checkpoint for
// every frontend except DEX, reconstructing each incoming stack slot with a
// hard-coded `{kind:'bitvector',widthBits:32}` machine type and never marking it
// partial. A value carried across a block boundary therefore lost its true type
// (float64 / float32 / managed-heap reference / int64 → 32-bit bitvector) yet the
// function still published `completeness:'complete'` under vm-semantics-preservation
// provenance. The checkpoint must preserve the exact reaching machine type, derive a
// lossless common type at joins, and fail closed (partial) when it cannot — never
// silently launder bitvector32 as authoritative.

const CODE_OFFSET = 0x180;
const pool = [null, { tag: 1, value: 'T' }, { tag: 6, value: 1.25 }, { tag: 8, stringIndex: 1 }]; // #2 double, #3 string ref

function method(bytecode, descriptor = '()V', maxLocals = 1) {
  return {
    moduleId: 'managed-mod:8987:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    constantPool: pool,
    methods: [{
      accessFlags: 0x0008, name: 'm', descriptor,
      code: { maxStack: 4, maxLocals, bytecode: Uint8Array.from(bytecode), exceptionTable: [], offset: CODE_OFFSET },
    }],
  };
}

function loweredStackSlots(fn) {
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const reads = lowered.semanticIr.nodes
    .filter((n) => n.kind === 'state-read' && /:stack:/.test(n.variable?.key || ''))
    .map((n) => {
      const value = lowered.semanticIr.values.find((v) => n.outputs.includes(v.id));
      return { blockId: n.blockId, key: n.variable.key, machineType: value?.machineType };
    });
  return {
    completeness: lowered.semanticIr.completeness,
    unresolved: (lowered.semanticIr.unknowns || []).some((u) => /stack-slot-type-unresolved/.test(u.reason)),
    reads,
  };
}

test('#8987 a float64 operand carried across a goto keeps its exact machine type', () => {
  // 0 ldc2_w #2(double) ; 3 goto 7 ; 6 nop ; 7 dreturn  -> block 7 reconstructs slot 0
  const bytecode = [0x14, 0x00, 0x02, 0xa7, 0x00, 0x04, 0x01, 0xaf];
  const fn = liftJvmMethod(0, method(bytecode, '()D', 0));
  const { completeness, reads } = loweredStackSlots(fn);
  const carried = reads.find((r) => r.blockId === 'bb_0x7' && /stack:0$/.test(r.key));
  assert.ok(carried, 'the carried slot must be reconstructed at the join block');
  assert.deepEqual(carried.machineType, { kind: 'float', widthBits: 64, format: 'binary64' },
    'carried stack slot must preserve the reaching float64 type, not bitvector32');
  assert.equal(completeness, 'complete', 'a fully-proven single-type carry stays complete');
});

test('#8987 a managed-heap reference carried across a goto keeps its address type', () => {
  // 0 ldc #3(String ref) ; 2 goto 5 ; 5 astore_1
  const bytecode = [0x12, 0x03, 0xa7, 0x00, 0x03, 0x4c];
  const fn = liftJvmMethod(0, method(bytecode, '()V', 2));
  const { completeness, reads } = loweredStackSlots(fn);
  const carried = reads.find((r) => r.blockId === 'bb_0x5' && /stack:0$/.test(r.key));
  assert.ok(carried, 'the carried reference slot must be reconstructed');
  assert.deepEqual(carried.machineType, { kind: 'address', widthBits: 32, addressSpace: 'managed-heap' },
    'a carried managed-heap reference must not collapse to an ordinary bitvector');
  assert.equal(completeness, 'complete');
});

test('#8987 a join with conflicting reaching types fails closed instead of laundering complete', () => {
  // 0 iload_0 ; 1 ifne 10 ; 4 ldc2_w #2(double) ; 7 goto 11 ; 10 iconst_1 ; 11 pop ; 12 return
  // bb_0xb is reached with slot 0 = float64 (double path) AND bitvector32 (int path).
  const bytecode = [0x1a, 0x9a, 0x00, 0x09, 0x14, 0x00, 0x02, 0xa7, 0x00, 0x04, 0x04, 0x57, 0xb1];
  const fn = liftJvmMethod(0, method(bytecode, '()V', 1));
  const { completeness, unresolved, reads } = loweredStackSlots(fn);
  assert.equal(unresolved, true, 'an unprovable join slot must be reported as an unresolved machine type');
  assert.equal(completeness, 'partial', 'the function must NOT publish complete provenance when a carried type is unproven');
  assert.ok(reads.some((r) => r.blockId === 'bb_0xb'), 'the conflicting join block reconstructs its stack slot');
});

process.stdout.write('[phase11] issue-8987 bridge operand-stack checkpoint type tests passed\n');
