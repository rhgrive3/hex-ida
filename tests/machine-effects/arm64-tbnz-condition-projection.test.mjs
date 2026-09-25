// AArch64 TBNZ/TBZ control conditions.
//
// TBNZ lifts its control condition to the tested bit value itself: the branch
// is taken exactly when `extract-bit(value, bit)` is nonzero. TBZ is the same
// shape wrapped in `is-zero`. Neither instruction sets NZCV, so no flag source
// may be invented for them, and the v2->v1 projection must publish the branch
// as a tested-value branch (`cbz`/`cbnz`) instead of a flag predicate with no
// producer (which renders as `__arm64_condition_unknown(/* NZCV */)`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { renderBranchCondition } from '../../js/decompiler/semantic.js';

const bit1 = { kind: 'predicate', widthBits: 1 };
const bit64 = { kind: 'bitvector', widthBits: 64 };

function origin(id, address) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}
function definitionValue(id, definitionNodeId, machineType, at) {
  return { id, kind:'definition', machineType, definitionNodeId, sourceEntityId:definitionNodeId, variableKey:null, origin:origin(`ins_${id}`, at) };
}
function intrinsicNode(id, operator, inputs, outputs, at, attributes = {}) {
  return {
    id, kind:'intrinsic', blockId:'b0', inputs, outputs, operator,
    intrinsic:{
      inputs:inputs.map((id) => id), outputs:outputs.map((id) => id), stateReads:[], stateWrites:[],
      memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, controlEffects:[],
      determinism:'deterministic', symbolicDetail:'summary-only',
    },
    attributes:{ machineEffects:{ operationMetadata:{ ...attributes } } },
    origin:origin(`ins_${id}`, at),
  };
}

// Project a conditional branch fed by the given condition-producing nodes.
// The last producer must write the `tested` predicate value.
function projectConditional(producers) {
  const w = { id:'w', kind:'entry', machineType:bit64, sourceEntityId:'fn', variableKey:null, origin:origin('ins_w', 0x1000n) };
  const tested = definitionValue('tested', producers.at(-1).id, bit1, 0x1100n);
  const intermediate = producers.slice(0, -1).flatMap((producer) => (producer.outputs || []).map(
    (id) => definitionValue(id, producer.id, bit1, 0x10f0n),
  ));
  const nodes = [
    ...producers,
    { id:'n_br', kind:'conditional-branch', blockId:'b0', inputs:['tested'], targets:['b1','b2'],
      origin:origin('ins_br', 0x1104n), attributes:{ machineControlEffect:{ kind:'conditional-branch' } } },
    { id:'n_ret1', kind:'return', blockId:'b1', inputs:[], outputs:[], origin:origin('ins_ret1', 0x1200n) },
    { id:'n_ret2', kind:'return', blockId:'b2', inputs:[], outputs:[], origin:origin('ins_ret2', 0x1300n) },
  ];
  const ir = {
    schemaVersion:2, contractVersion:'2.0.0', functionId:'fn', entryBlockId:'b0',
    blocks:[
      { id:'b0', nodeIds:[...producers.map((node) => node.id), 'n_br'], origin:origin('block_b0', 0x1000n) },
      { id:'b1', nodeIds:['n_ret1'], origin:origin('block_b1', 0x1200n) },
      { id:'b2', nodeIds:['n_ret2'], origin:origin('block_b2', 0x1300n) },
    ],
    values:[w, ...intermediate, tested],
    nodes,
    completeness:'complete', unknowns:[],
    origin:origin('function_fn', 0x1000n),
  };
  const projected = projectSemanticIrV2ToLegacyV1(ir);
  const branch = projected.instructions.find((inst) => inst.semanticNodeId === 'n_br');
  assert.ok(branch, 'conditional branch must project to a legacy instruction');
  return branch;
}

test('TBNZ condition projects as a tested-value branch, not an NZCV predicate', () => {
  const branch = projectConditional([intrinsicNode('n_cond', 'extract-bit', ['w'], ['tested'], 0x1100n, { bit:31 })]);
  assert.equal(branch.op, 'cbr');
  assert.equal(branch.extra.kind, 'cbnz', 'TBNZ must publish a nonzero test of the lifted bit value');
  assert.equal(branch.cond ?? null, null, 'no NZCV condition code exists for TBNZ');
  assert.equal(branch.args.length, 1, 'the tested value is the only condition input');
});

test('TBZ condition still projects as the zero test of the lifted bit value', () => {
  const branch = projectConditional([
    intrinsicNode('n_bit', 'extract-bit', ['w'], ['bit'], 0x10f0n, { bit:0 }),
    intrinsicNode('n_cond', 'is-zero', ['bit'], ['tested'], 0x1100n),
  ]);
  assert.equal(branch.extra.kind, 'cbz');
  assert.equal(branch.cond ?? null, null);
});

test('an opaque predicate stays a semantic condition instead of borrowing a flag', () => {
  const branch = projectConditional([intrinsicNode('n_cond', 'clz', ['w'], ['tested'], 0x1100n)]);
  assert.notEqual(branch.extra.kind, 'cbnz', 'only a proven bit projection may become a tested-value branch');
  assert.equal(branch.extra.kind, 'semantic-condition');
  assert.equal(branch.cond ?? null, null, 'the condition must stay explicitly unresolved');
});

test('a tested-value branch renders as the value test, never as an NZCV call', () => {
  const ctx = { opts:{}, exprCache:new Map(), exprActive:new Set(), exprNodes:0, materialNames:new Map(), evidence:[] };
  const rendered = renderBranchCondition({
    op:'cbr', cond:null, extra:{ kind:'cbnz' }, args:[{ value:{ id:1, kind:'const', value:5n, bits:64 } }],
  }, ctx);
  assert.match(rendered, /!= 0/);
  assert.doesNotMatch(rendered, /__arm64_condition/);
});

console.log('arm64 TBNZ/TBZ tested-value condition projection: PASS');
