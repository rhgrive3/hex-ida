import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { OP, VK } from '../../js/ir-core.js';
import { openProduct } from '../../tools/validation/public-benchmark/product-host.mjs';

function hasTool(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const HAS_AARCH64_GCC = hasTool('aarch64-linux-gnu-gcc');

function makeTestState(opts = {}) {
  return {
    expressionMemo: new Map(),
    expressionActive: new Set(),
    opts,
    types: { values: new Map() },
    highVariables: null,
    ir: { values: [], blocks: [], instructions: [] },
  };
}

test('1. phi cycle-break returns canonical phi_<id> and does not poison memoized backedge expressions with local_xN', () => {
  const c0 = { id: 10, bits: 32, signed: true, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c1 = { id: 11, bits: 32, signed: true, kind: VK.CONST, const: 1n, def: null, uses: [] };
  const phiVal = { id: 252, bits: 32, signed: true, kind: VK.REG, reg: 'x2', def: null, uses: [] };
  const nextVal = { id: 253, bits: 32, signed: true, kind: VK.REG, reg: 'x2', def: null, uses: [] };

  const iAdd = {
    id: 2,
    row: 1,
    address: 0x1004n,
    block: 1,
    op: OP.BIN,
    sub: 'add',
    dst: nextVal,
    args: [{ value: phiVal }, { value: c1 }],
  };
  const iPhi = {
    id: 1,
    row: 0,
    address: 0x1000n,
    block: 1,
    op: OP.PHI,
    dst: phiVal,
    incoming: [{ from: 0, value: c0 }, { from: 1, value: nextVal }],
  };
  phiVal.def = iPhi;
  nextVal.def = iAdd;

  // Default mode: canonical phi_252
  const state = makeTestState();
  const phiExpr = buildExpressionForTesting(phiVal, state);
  const nextExpr = buildExpressionForTesting(nextVal, state);
  assert.equal(printExpression(phiExpr), 'phi_252');
  const nextText = printExpression(nextExpr);
  assert.match(nextText, /\bphi_252\b/, `backedge expression should reference phi_252, got: ${nextText}`);
  assert.doesNotMatch(nextText, /\blocal_x2\b/, `backedge expression must not be poisoned with local_x2, got: ${nextText}`);

  // phase8Optimize mode: canonical local_phi_252
  const stateP8 = makeTestState({ phase8Optimize: true });
  const phiExprP8 = buildExpressionForTesting(phiVal, stateP8);
  const nextExprP8 = buildExpressionForTesting(nextVal, stateP8);
  assert.equal(printExpression(phiExprP8), 'local_phi_252');
  const nextTextP8 = printExpression(nextExprP8);
  assert.match(nextTextP8, /\blocal_phi_252\b/, `phase8Optimize backedge should reference local_phi_252, got: ${nextTextP8}`);
  assert.doesNotMatch(nextTextP8, /\blocal_x2\b/, `phase8Optimize backedge must not be poisoned with local_x2, got: ${nextTextP8}`);
});

test('2. mutually recursive loop phis resolve to canonical phi_<id> without poisoning or blowup', () => {
  const c0 = { id: 1, bits: 64, signed: false, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c1 = { id: 2, bits: 64, signed: false, kind: VK.CONST, const: 1n, def: null, uses: [] };
  const c2 = { id: 3, bits: 64, signed: false, kind: VK.CONST, const: 2n, def: null, uses: [] };
  const phiA = { id: 10, bits: 64, signed: false, kind: VK.REG, reg: 'x3', def: null, uses: [] };
  const phiB = { id: 11, bits: 64, signed: false, kind: VK.REG, reg: 'x4', def: null, uses: [] };
  const nextA = { id: 12, bits: 64, signed: false, kind: VK.REG, reg: 'x3', def: null, uses: [] };
  const nextB = { id: 13, bits: 64, signed: false, kind: VK.REG, reg: 'x4', def: null, uses: [] };

  nextA.def = { id: 3, row: 2, address: 0x1008n, block: 1, op: OP.BIN, sub: 'add', dst: nextA, args: [{ value: phiB }, { value: c1 }] };
  nextB.def = { id: 4, row: 3, address: 0x100cn, block: 1, op: OP.BIN, sub: 'add', dst: nextB, args: [{ value: phiA }, { value: c2 }] };
  phiA.def = { id: 1, row: 0, address: 0x1000n, block: 1, op: OP.PHI, dst: phiA, incoming: [{ from: 0, value: c0 }, { from: 1, value: nextA }] };
  phiB.def = { id: 2, row: 1, address: 0x1004n, block: 1, op: OP.PHI, dst: phiB, incoming: [{ from: 0, value: c1 }, { from: 1, value: nextB }] };

  const state = makeTestState();
  assert.equal(printExpression(buildExpressionForTesting(phiA, state)), 'phi_10');
  assert.equal(printExpression(buildExpressionForTesting(phiB, state)), 'phi_11');

  const nextAText = printExpression(buildExpressionForTesting(nextA, state));
  const nextBText = printExpression(buildExpressionForTesting(nextB, state));
  assert.match(nextAText, /\bphi_11\b/);
  assert.match(nextBText, /\bphi_10\b/);
  assert.doesNotMatch(nextAText, /\blocal_x[34]\b/);
  assert.doesNotMatch(nextBText, /\blocal_x[34]\b/);
});

test('3. non-phi cycle-break does not permanently poison expressionMemo', () => {
  const c1 = { id: 1, bits: 64, signed: false, kind: VK.CONST, const: 1n, def: null, uses: [] };
  const v1 = { id: 20, bits: 64, signed: false, kind: VK.REG, reg: 'x5', def: null, uses: [] };
  const v2 = { id: 21, bits: 64, signed: false, kind: VK.REG, reg: 'x6', def: null, uses: [] };

  v1.def = { id: 1, row: 0, address: 0x1000n, block: 0, op: OP.BIN, sub: 'add', dst: v1, args: [{ value: v2 }, { value: c1 }] };
  v2.def = { id: 2, row: 1, address: 0x1004n, block: 0, op: OP.MOV, dst: v2, args: [{ value: v1 }] };

  const state = makeTestState();
  buildExpressionForTesting(v1, state);
  assert.equal(state.expressionMemo.has('21:v'), false, 'non-phi cycle-broken descendant must not be permanently memoized');
  assert.equal(state.expressionMemo.has('20:v'), false, 'non-phi cycle root must not be permanently memoized');
});

test('4. trivial self-looping phi collapses to the single non-self incoming value instead of unassigned phi_<id>', () => {
  const callVal = { id: 355, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const iCall = { id: 10, row: 0, address: 0x2000n, block: 0, op: OP.CALL, dst: callVal, args: [], extra: { target: 'malloc' } };
  callVal.def = iCall;

  // Case 4a: incoming = [call_355, self]
  const phiA = { id: 480, bits: 64, signed: false, kind: VK.REG, reg: 'x25', def: null, uses: [] };
  phiA.def = {
    id: 11,
    row: 1,
    address: 0x2004n,
    block: 1,
    op: OP.PHI,
    dst: phiA,
    incoming: [{ from: 0, value: callVal }, { from: 1, value: phiA }],
  };
  const stateA = makeTestState();
  stateA.ir = { values: [callVal, phiA], blocks: [], instructions: [iCall, phiA.def] };
  const exprA = buildExpressionForTesting(phiA, stateA);
  assert.equal(printExpression(exprA), 'call_355');

  // Case 4b: self-edge first, incoming = [self, call_355]
  const phiB = { id: 481, bits: 64, signed: false, kind: VK.REG, reg: 'x25', def: null, uses: [] };
  phiB.def = {
    id: 12,
    row: 2,
    address: 0x2008n,
    block: 1,
    op: OP.PHI,
    dst: phiB,
    incoming: [{ from: 1, value: phiB }, { from: 0, value: callVal }],
  };
  const stateB = makeTestState();
  stateB.ir = { values: [callVal, phiB], blocks: [], instructions: [iCall, phiB.def] };
  const exprB = buildExpressionForTesting(phiB, stateB);
  assert.equal(printExpression(exprB), 'call_355');

  // Case 4c: duplicate equal non-self incoming values + self-edge
  const phiC = { id: 482, bits: 64, signed: false, kind: VK.REG, reg: 'x25', def: null, uses: [] };
  phiC.def = {
    id: 13,
    row: 3,
    address: 0x200cn,
    block: 1,
    op: OP.PHI,
    dst: phiC,
    incoming: [{ from: 0, value: callVal }, { from: 2, value: callVal }, { from: 1, value: phiC }],
  };
  const stateC = makeTestState();
  stateC.ir = { values: [callVal, phiC], blocks: [], instructions: [iCall, phiC.def] };
  const exprC = buildExpressionForTesting(phiC, stateC);
  assert.equal(printExpression(exprC), 'call_355');
});

test('5. compiled AArch64 regressions (HumanEval 694 & 774 patterns) avoid local_xN poisoning and unassigned phi_<id>', { skip: !HAS_AARCH64_GCC }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pass5-phi-'));
  try {
    // Pattern 694: running maximum loop with backedge select feeding both store and loop phi
    const src694 = `
#include <stdlib.h>
int *func0(int *numbers, int size) {
    if (size <= 0) return NULL;
    int *out = malloc(size * sizeof(int));
    if (!out) return NULL;
    int max = numbers[0];
    for (int i = 0; i < size; i++) {
        if (numbers[i] > max) max = numbers[i];
        out[i] = max;
    }
    return out;
}
int main(void) { return 0; }
`;
    const c694 = path.join(tmpDir, 'p694.c');
    const bin694 = path.join(tmpDir, 'p694.elf');
    fs.writeFileSync(c694, src694);
    execFileSync('aarch64-linux-gnu-gcc', ['-O2', '-fstack-protector-strong', c694, '-o', bin694]);
    const prod694 = await openProduct(bin694);
    try {
      const snap = await prod694.query.snapshot();
      const fns = (await prod694.query.functions(snap, {}, { offset: 0, limit: 1000 })).value;
      const fn = fns.find((f) => f.name === 'func0');
      assert.ok(fn, 'func0 should be discovered in p694');
      const dec = await prod694.query.decompile(snap, fn.address);
      const code = dec?.value?.pseudocode ?? '';
      assert.doesNotMatch(code, /\blocal_x2\b/, `694 func0 must not use uninitialized local_x2:\n${code}`);
    } finally {
      await prod694.close?.();
    }

    // Pattern 774: loop-invariant malloc pointer carried across loop header
    const src774 = `
#include <string.h>
#include <stdlib.h>
int func0(char** strings, int count, const char* prefix, char*** out) {
    int prefix_length = strlen(prefix);
    *out = (char**)malloc(count * sizeof(char*));
    int out_count = 0;
    for (int i = 0; i < count; i++) {
        if (strncmp(strings[i], prefix, prefix_length) == 0) {
            (*out)[out_count++] = strings[i];
        }
    }
    return out_count;
}
int main(void) { return 0; }
`;
    const c774 = path.join(tmpDir, 'p774.c');
    const bin774 = path.join(tmpDir, 'p774.elf');
    fs.writeFileSync(c774, src774);
    execFileSync('aarch64-linux-gnu-gcc', ['-O2', '-fstack-protector-strong', c774, '-o', bin774]);
    const prod774 = await openProduct(bin774);
    try {
      const snap = await prod774.query.snapshot();
      const fns = (await prod774.query.functions(snap, {}, { offset: 0, limit: 1000 })).value;
      const fn = fns.find((f) => f.name === 'func0');
      assert.ok(fn, 'func0 should be discovered in p774');
      const dec = await prod774.query.decompile(snap, fn.address);
      const code = dec?.value?.pseudocode ?? '';
      // Every declared phi_<id> must be assigned at least once
      const declaredPhis = [...code.matchAll(/\b(phi_\d+)\s*;/g)].map((m) => m[1]);
      for (const phiVar of declaredPhis) {
        assert.match(code, new RegExp(`\\b${phiVar}\\s*=`), `774 func0 has unassigned ${phiVar}:\n${code}`);
      }
    } finally {
      await prod774.close?.();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
