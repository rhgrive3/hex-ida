import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/index.js';

// #8790: CIL `brfalse(.s)` / `brtrue(.s)` must not collapse onto one generic
// conditional branch with the taken target forced onto the `conditional-true`
// edge. `brfalse` takes its operand address on a zero/null condition, so that
// address is the `conditional-false` edge, and the fall-through is the
// `conditional-true` edge; `brtrue` is the opposite.

const SIG_STATIC_INT = [0x00, 0x00, 0x08]; // static int32()

function lowerBranch(opcodes) {
  const image = parseCil(buildCil({
    methods: [{ name: 'F', signature: SIG_STATIC_INT, body: opcodes.body }],
  }).bytes);
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, image));
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === opcodes.mnemonic);
  assert.ok(node, `expected a ${opcodes.mnemonic} conditional-branch node`);
  const block = lowered.cfg.blocks.find((b) => b.id === node.blockId);
  const kindTo = new Map((block.successors || []).map((s) => [s.kind, s.to]));
  return { node, lowered, kindTo };
}

function assertPolarity({ kindTo, node, lowered }, { expectedTrue, expectedFalse, mnemonic, takenBlock, fallthroughBlock }) {
  assert.equal(kindTo.get('conditional-true'), expectedTrue, `${mnemonic}: conditional-true edge`);
  assert.equal(kindTo.get('conditional-false'), expectedFalse, `${mnemonic}: conditional-false edge`);
  // The taken target and fall-through are distinct, proven edges -> the branch
  // polarity is representable, so the node/CFG may remain complete.
  assert.equal(node.completeness, 'complete', `${mnemonic}: node completeness`);
  assert.equal(node.attributes?.predicate ?? null, null, `${mnemonic}: no fabricated predicate attribute`);
  const unresolved = (lowered.semanticIr.unknowns || []).some((u) => /unresolved-conditional-branch-target/.test(u.reason || ''));
  assert.equal(unresolved, false, `${mnemonic}: no unresolved conditional-branch-target`);
  assert.ok(takenBlock !== fallthroughBlock, `${mnemonic}: taken and fall-through blocks differ`);
}

test('brfalse.s: taken target is the conditional-false edge, fall-through is conditional-true', () => {
  // ldc.i4.0 ; brfalse.s +2 -> target(offset 5) ; ldc.i4.1 ; ret ; target: ldc.i4.2 ; ret
  const { node, lowered, kindTo } = lowerBranch({ mnemonic: 'brfalse.s', body: [0x16, 0x2c, 0x02, 0x17, 0x2a, 0x18, 0x2a] });
  assert.equal(node.targets[0], 'bb_0x3', 'brfalse.s: conditional-true target is the fall-through');
  assertPolarity({ node, lowered, kindTo }, { expectedTrue: 'bb_0x3', expectedFalse: 'bb_0x5', mnemonic: 'brfalse.s', takenBlock: 'bb_0x5', fallthroughBlock: 'bb_0x3' });
});

test('brtrue.s: taken target is the conditional-true edge, fall-through is conditional-false', () => {
  const { node, lowered, kindTo } = lowerBranch({ mnemonic: 'brtrue.s', body: [0x16, 0x2d, 0x02, 0x17, 0x2a, 0x18, 0x2a] });
  assertPolarity({ node, lowered, kindTo }, { expectedTrue: 'bb_0x5', expectedFalse: 'bb_0x3', mnemonic: 'brtrue.s', takenBlock: 'bb_0x5', fallthroughBlock: 'bb_0x3' });
});

test('brfalse and brtrue of the same body no longer lower to an identical CFG', () => {
  const bf = lowerBranch({ mnemonic: 'brfalse.s', body: [0x16, 0x2c, 0x02, 0x17, 0x2a, 0x18, 0x2a] });
  const bt = lowerBranch({ mnemonic: 'brtrue.s', body: [0x16, 0x2d, 0x02, 0x17, 0x2a, 0x18, 0x2a] });
  const enc = (x) => JSON.stringify([...x.kindTo.entries()].sort());
  assert.notEqual(enc(bf), enc(bt), 'brfalse/brtrue must produce opposite branch polarity');
});

test('long brfalse/brtrue (0x39/0x3a) mirror the short-form polarity', () => {
  // long offset = target - (pc after the 4-byte operand). Body layout:
  //   op0 ldc.i4.0 ; op1 brfalse/brtrue ; op2..op5 delta ; op6 fall-through
  //   ldc.i4.1 ; op7 ret ; op8 taken ldc.i4.2 ; op9 ret
  // pc after operand = 6; delta = +2 -> target = 8.
  const body = (op) => [0x16, op, 0x02, 0x00, 0x00, 0x00, 0x17, 0x2a, 0x18, 0x2a];
  const bf = lowerBranch({ mnemonic: 'brfalse', body: body(0x39) });
  const bt = lowerBranch({ mnemonic: 'brtrue', body: body(0x3a) });
  assert.equal(bf.kindTo.get('conditional-false'), 'bb_0x8', 'long brfalse: taken target is conditional-false');
  assert.equal(bf.kindTo.get('conditional-true'), 'bb_0x6', 'long brfalse: fall-through is conditional-true');
  assert.equal(bt.kindTo.get('conditional-true'), 'bb_0x8', 'long brtrue: taken target is conditional-true');
  assert.equal(bt.kindTo.get('conditional-false'), 'bb_0x6', 'long brtrue: fall-through is conditional-false');
});
