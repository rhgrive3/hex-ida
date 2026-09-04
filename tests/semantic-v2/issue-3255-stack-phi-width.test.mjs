import assert from 'node:assert/strict';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { recoverExactStackPhiExpressions } from '../../js/decompiler/passes/stack-phi-recovery.js';

function mismatchResult(storeBytes, loadBytes, suffix) {
  const key = `stack:width-${suffix}`;
  const storedValue = { id:`stored-${suffix}`, bits:storeBytes * 8 };
  const storedExpression = expr.variable(`stored_${suffix}`, storeBytes * 8, false);
  const store = {
    id:`store-${suffix}`,
    op:'store',
    block:0,
    row:0,
    loc:{ kind:'stack', key, size:storeBytes },
    size:storeBytes,
    args:[{ value:storedValue }],
  };
  const load = {
    id:`load-${suffix}`,
    op:'load',
    block:0,
    row:1,
    loc:{ kind:'stack', key, size:loadBytes },
    size:loadBytes,
  };
  const ret = { id:`ret-${suffix}`, op:'ret', block:0, row:2, args:[] };
  const loadExpression = expr.load(
    { kind:'stack', key, name:`slot_${suffix}`, text:`slot_${suffix}` },
    loadBytes * 8,
    { row:load.row, ir:load.id },
  );
  const returnNode = {
    kind:'statement',
    indent:0,
    text:`return slot_${suffix};`,
    semantic:{ op:'return', expression:loadExpression },
    source:{ rows:[ret.row], ir:[ret.id], addresses:[] },
  };
  const result = {
    semantic:true,
    ir:{
      instructions:[store, load, ret],
      blocks:[{ index:0, pred:[], succ:[], insts:[store, load, ret] }],
    },
    semanticAst:{
      values:[{ valueId:storedValue.id, expression:storedExpression }],
      conditions:[],
      outputs:[{ name:'return', expression:loadExpression }],
    },
    cAst:{ body:[returnNode] },
  };
  return { result, loadExpression, returnNode };
}

for (const [storeBytes, loadBytes, suffix] of [
  [4, 8, 'narrow-store-wide-load'],
  [8, 4, 'wide-store-narrow-load'],
]) {
  const { result, loadExpression, returnNode } = mismatchResult(storeBytes, loadBytes, suffix);
  assert.equal(recoverExactStackPhiExpressions(result, { deterministicTransforms:true }), result);
  assert.equal(result.semanticAst.outputs[0].expression, loadExpression);
  assert.equal(returnNode.semantic.expression, loadExpression);
  assert.equal(returnNode.text, `return slot_${suffix};`);
  assert.equal(result.rewriteProof, undefined);
}

{
  const returnKey = 'stack:return';
  const sourceKey = 'stack:source';
  const sourceStoredValue = { id:'source-stored', bits:32 };
  const sourceStore = {
    id:'source-store',
    op:'store',
    block:0,
    row:0,
    loc:{ kind:'stack', key:sourceKey, size:4 },
    size:4,
    args:[{ value:sourceStoredValue }],
  };
  const sourceLoad = {
    id:'source-load',
    op:'load',
    block:0,
    row:1,
    loc:{ kind:'stack', key:sourceKey, size:8 },
    size:8,
  };
  const nestedValue = { id:'nested-load-value', bits:64, def:sourceLoad };
  const returnStore = {
    id:'return-store',
    op:'store',
    block:0,
    row:2,
    loc:{ kind:'stack', key:returnKey, size:4 },
    size:4,
    args:[{ value:nestedValue }],
  };
  const returnLoad = {
    id:'return-load',
    op:'load',
    block:0,
    row:3,
    loc:{ kind:'stack', key:returnKey, size:4 },
    size:4,
  };
  const ret = { id:'nested-ret', op:'ret', block:0, row:4, args:[] };
  const nestedExpression = expr.load(
    { kind:'stack', key:sourceKey, name:'source_slot', text:'source_slot' },
    64,
    { row:sourceLoad.row, ir:sourceLoad.id },
  );
  const returnExpression = expr.load(
    { kind:'stack', key:returnKey, name:'return_slot', text:'return_slot' },
    32,
    { row:returnLoad.row, ir:returnLoad.id },
  );
  const returnNode = {
    kind:'statement',
    indent:0,
    text:'return return_slot;',
    semantic:{ op:'return', expression:returnExpression },
    source:{ rows:[ret.row], ir:[ret.id], addresses:[] },
  };
  const result = {
    semantic:true,
    ir:{
      instructions:[sourceStore, sourceLoad, returnStore, returnLoad, ret],
      blocks:[{
        index:0,
        pred:[],
        succ:[],
        insts:[sourceStore, sourceLoad, returnStore, returnLoad, ret],
      }],
    },
    semanticAst:{
      values:[
        { valueId:sourceStoredValue.id, expression:expr.variable('source_value', 32, false) },
        { valueId:nestedValue.id, expression:nestedExpression },
      ],
      conditions:[],
      outputs:[{ name:'return', expression:returnExpression }],
    },
    cAst:{ body:[returnNode] },
  };

  assert.equal(recoverExactStackPhiExpressions(result, { deterministicTransforms:true }), result);
  assert.equal(result.semanticAst.outputs[0].expression, returnExpression);
  assert.equal(returnNode.semantic.expression, returnExpression);
  assert.equal(returnNode.text, 'return return_slot;');
  assert.equal(result.rewriteProof, undefined);
}

console.log('Phase 8 stack PHI access-width identity: PASS');
