// Regression for #7277: CIL `leave`/`leave.s` is an unconditional control
// transfer to its target with an emptied evaluation stack. The shared bridge
// used to ignore `kind:'leave'`: the instruction after `leave` stayed in the
// same basic block as executable code, the leave target got no predecessor,
// and the whole result was still published as `complete` with no unknowns.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-lowering-v2.js';
import { SEMANTIC_CFG_EDGE_KINDS } from '../js/semantics/cfg/index.js';

function cilImage(bytecode, exceptionClauses = []) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-7277',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 1,
      isTiny: false,
      exceptionClauses,
    }],
  };
}

// 00: leave.s +2 => target 0x04
// 02: ldc.i4.1     -- must not execute after the leave
// 03: ret
// 04: ldc.i4.2     -- leave target
// 05: ret
const NO_EH = Uint8Array.from([0xde, 0x02, 0x17, 0x2a, 0x18, 0x2a]);

test('#7277 canonical CFG contract carries the leave edge kind', () => {
  assert.ok(SEMANTIC_CFG_EDGE_KINDS.includes('leave'));
});

test('#7277 leave terminates its block and targets only the leave destination', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(NO_EH)));
  const entry = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.ok(entry, 'entry block exists');
  const successors = entry.successors.map((s) => `${s.to}:${s.kind}`);
  assert.ok(successors.includes('bb_0x4:leave'), `missing leave edge: ${JSON.stringify(successors)}`);
  assert.ok(!successors.some((s) => s.startsWith('bb_0x2:')), `no fallthrough may survive a leave: ${JSON.stringify(successors)}`);

  const leaveNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'leave.s');
  assert.ok(leaveNode, 'leave node exists');
  assert.equal(leaveNode.kind, 'branch');
  assert.deepEqual(leaveNode.targets, ['bb_0x4']);
  assert.equal(leaveNode.completeness, 'complete');
});

test('#7277 instructions after a leave are unreachable from the entry block', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(NO_EH)));
  // From bb_0x0 the only edge is the leave edge; offsets 0x02/0x03 (bb_0x2)
  // must have no inbound edge from the leave block. The ret at 0x03 sits in
  // bb_0x2 and no longer looks like live fallthrough code of the entry path.
  const entrySuccessors = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0').successors;
  assert.deepEqual(entrySuccessors.map((s) => s.to), ['bb_0x4']);
});

test('#7277 leave keeps the target block connected in the semantic IR graph', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(NO_EH)));
  const targetBlock = lowered.cfg.blocks.find((b) => b.id === 'bb_0x4');
  assert.ok(targetBlock, 'leave target block exists');
  const retNode = lowered.semanticIr.nodes.find((n) => n.kind === 'return'
    && n.blockId === 'bb_0x4');
  assert.ok(retNode, 'leave target block keeps its own return node');
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.deepEqual(lowered.semanticIr.unknowns, []);
});

test('#7277 leave with an out-of-range target degrades instead of fabricating an edge', () => {
  // leave.s +0x7f jumps far past the method body; the target block cannot
  // exist, so the bridge must fail closed rather than silently accept it.
  const bytecode = Uint8Array.from([0xde, 0x7f, 0x17, 0x2a]);
  assert.throws(
    () => lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode))),
    /managed-bridge-invalid-control-target/,
  );
});

test('#7277 leave inside a protected region still lowers its target edge', () => {
  // ECMA-335: leave inside a try exits the protected region; the target edge
  // remains an unconditional transfer (finally interception is a handler-side
  // concern and stays out of scope for the ordinary CFG edge).
  // 00: leave.s +3 => target 0x05      (inside try)
  // 02: ldc.i4.1; 03: ret              (rest of the protected region)
  // 04: pop                            (finally handler, consumes the slot)
  // 05: ldc.i4.2; 06: ret              (leave target, outside the try)
  const bytecode = Uint8Array.from([0xde, 0x03, 0x17, 0x2a, 0x26, 0x18, 0x2a]);
  const region = { kind: 'finally', tryOffset: 0, tryLength: 4, handlerOffset: 4, handlerLength: 1, classTokenOrFilter: 0 };
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode, [region])));
  const entry = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0');
  const kinds = entry.successors.map((s) => `${s.to}:${s.kind}`);
  assert.ok(kinds.includes('bb_0x5:leave'), `leave edge must survive inside a protected region: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('bb_0x4:exception'), `handler edge must stay wired: ${JSON.stringify(kinds)}`);
  assert.ok(!kinds.some((s) => s.startsWith('bb_0x2:')), `no fallthrough may survive a leave: ${JSON.stringify(kinds)}`);
  assert.equal(lowered.semanticIr.completeness, 'partial',
    'finally sequencing is not modeled by the shared bridge yet');
  assert.ok(lowered.semanticIr.unknowns.some((unknown) =>
    unknown.reason === 'cil-leave-finally-transfer-unmodeled'),
  'the unmodeled finally transfer must be explicit');
});

test('#7277 long-form leave preserves its unconditional target', () => {
  // 00: leave +2 => target 07 (five-byte instruction)
  // 05: ldc.i4.1; 06: ret (unreachable fallthrough)
  // 07: ldc.i4.2; 08: ret (target)
  const bytecode = Uint8Array.from([0xdd, 0x02, 0x00, 0x00, 0x00, 0x17, 0x2a, 0x18, 0x2a]);
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode)));
  const entry = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.deepEqual(entry.successors, [{ to: 'bb_0x7', kind: 'leave' }]);
  const leaveNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'leave');
  assert.equal(leaveNode.kind, 'branch');
  assert.deepEqual(leaveNode.targets, ['bb_0x7']);
});

test('#7277 leave empties stale source evaluation-stack state', () => {
  // 00: ldc.i4.1; 01: leave.s +2 => target 05
  // 03: ldc.i4.1; 04: ret (unreachable fallthrough)
  // 05: ldc.i4.2; 06: ret (target)
  const bytecode = Uint8Array.from([0x17, 0xde, 0x02, 0x17, 0x2a, 0x18, 0x2a]);
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode)));
  const sourceStackWrites = lowered.semanticIr.nodes.filter((node) =>
    node.blockId === 'bb_0x0'
      && node.kind === 'state-write'
      && node.variable?.key === 'vm:cil:stack:0');
  assert.deepEqual(sourceStackWrites, [], 'leave must not publish a stale source stack value');
  const targetStackReads = lowered.semanticIr.nodes.filter((node) =>
    node.blockId === 'bb_0x5'
      && node.kind === 'state-read'
      && node.variable?.key === 'vm:cil:stack:0');
  assert.deepEqual(targetStackReads, [], 'leave target starts with an empty evaluation stack');
});

test('#7277 leave across catch preserves the explicit target without false incompleteness', () => {
  // 00: leave.s +2 => target 04 (inside the try)
  // 02: ldc.i4.1; 03: ret (catch handler path, not leave fallthrough)
  // 04: ldc.i4.2; 05: ret (target)
  const bytecode = Uint8Array.from([0xde, 0x02, 0x17, 0x2a, 0x18, 0x2a]);
  const region = {
    kind: 'catch',
    tryOffset: 0,
    tryLength: 2,
    handlerOffset: 2,
    handlerLength: 2,
    classTokenOrFilter: 0x01000001,
  };
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(bytecode, [region])));
  const entry = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.ok(entry.successors.some((edge) => edge.to === 'bb_0x4' && edge.kind === 'leave'));
  assert.equal(lowered.semanticIr.completeness, 'complete');
});
