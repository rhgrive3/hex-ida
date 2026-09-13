import assert from 'node:assert/strict';
import test from 'node:test';
import { OP, VK } from '../../js/ir-core.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

/* A canonical Semantic IR intrinsic may pair a deterministic value operator
 * (for example not-bool) with declared state/memory effects in its intrinsic
 * summary. The v2-to-v1 projection's deterministicIntrinsicProjection()
 * special-cased such nodes into plain v1 value ops and skipped the
 * conservative intrinsic branch entirely, silently discarding the declared
 * clobbers and memory barrier while publishing an exact-looking instruction
 * (#5386). A deterministic value projection is only faithful when the
 * intrinsic declares no side effects; anything else must project through the
 * conservative CLOBBER path that preserves the effect summary. */

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit64 = { kind: 'bitvector', widthBits: 64 };

function origin(id, address = 0x1000n) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}
function defValue(id, definitionNodeId, machineType = bit64) {
  return { id, kind: 'definition', machineType, definitionNodeId, sourceEntityId: definitionNodeId, origin: origin(`ins_${id}`) };
}
function entryValue(id, machineType = bit64) {
  return { id, kind: 'entry', machineType, sourceEntityId: 'fn', origin: origin(`ins_${id}`) };
}

function buildIntrinsicIr(intrinsicOverrides) {
  const input = entryValue('x');
  const output = defValue('y', 'n1');
  const intrinsic = {
    inputs: ['x'],
    outputs: ['y'],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'available',
    ...intrinsicOverrides,
  };
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_5386',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n1', 'n2'], origin: origin('block_b0') }],
    values: [input, output],
    nodes: [
      { id: 'n1', kind: 'intrinsic', blockId: 'b0', inputs: ['x'], outputs: ['y'], operator: 'not-bool', intrinsic, completeness: 'complete', origin: origin('ins_n1', 0x1004n) },
      { id: 'n2', kind: 'return', blockId: 'b0', inputs: ['y'], outputs: [], origin: origin('ins_n2', 0x1008n) },
    ],
    completeness: 'complete',
    unknowns: [],
    origin: origin('function_fn_5386'),
  };
}

function intrinsicInst(out) {
  return out.instructions.find((inst) => inst.semanticNodeId === 'n1');
}

test('#5386: deterministic intrinsic with declared memory write must not drop the effect', () => {
  const ir = buildIntrinsicIr({ memoryWrite: { scope: 'all', addressSpaces: ['memory'] } });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.CLOBBER, 'must take the conservative intrinsic path');
  assert.equal(inst.memoryBarrier, true, 'declared memory write must become a memory barrier');
  assert.ok(inst.extra?.intrinsic, 'intrinsic summary must be retained');
});

test('#5386: deterministic intrinsic with declared state writes must publish clobbers', () => {
  const ir = buildIntrinsicIr({ stateWrites: [{ key: 'state:nzcv', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'flag', flagId: 'nzcv' } }] });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.CLOBBER);
  assert.deepEqual(inst.clobbers, ['nzcv'], 'physical flag state publishes its public identity');
  assert.ok(inst.extra?.intrinsic);
});

test('#5386: effect-free deterministic intrinsic still projects to the exact value op', () => {
  const ir = buildIntrinsicIr({});
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.UN);
  assert.equal(inst.sub, 'not');
  assert.equal(inst.dst?.kind, VK.DEF);
});

test('#5386: deterministic intrinsic with declared control effects takes the conservative path', () => {
  const ir = buildIntrinsicIr({ controlEffects: [{ kind: 'trap', reason: 'declared' }] });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.CLOBBER);
  assert.ok(inst.extra?.intrinsic);
});

test('#5386: nondeterministic intrinsic must retain determinism authority', () => {
  const ir = buildIntrinsicIr({ determinism: 'nondeterministic' });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.CLOBBER);
  assert.equal(inst.extra?.intrinsic?.determinism, 'nondeterministic');
});

test('#5386: input-dependent intrinsic must not project as deterministic value op', () => {
  const ir = buildIntrinsicIr({ determinism: 'input-dependent' });
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = intrinsicInst(out);
  assert.equal(inst.op, OP.CLOBBER);
  assert.equal(inst.extra?.intrinsic?.determinism, 'input-dependent');
});
