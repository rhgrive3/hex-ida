import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as E from '../../../js/symbolic/expr/index.js';
import { compileProofExpression, renderProofExpression, sameProofExpression } from '../../../js/decompiler/phase8/proof-expression.js';
import { expr } from '../../../js/decompiler/ast/nodes.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { printExpression } from '../../../js/decompiler/pretty/c.js';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation, isProducerProjection } from '../../../js/decompiler/pipeline.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan } from '../../../js/decompiler/phase8/pass-validation.js';

function scalarInputs(bits) {
  const a = E.createFreshSymbol(E.bvSort(bits),'a'), b = E.createFreshSymbol(E.bvSort(bits),'b');
  return { a,b,binding:{inputs:[{symbol:a},{symbol:b}]},inputs:[expr.variable('a',bits,true),expr.variable('b',bits,true)] };
}
function checkLowering(term, f, values) {
  const recipe = compileProofExpression(term,f.binding);
  assert.ok(recipe, `${term.kind}/${term.op}`);
  const rendered = renderProofExpression(recipe,f.inputs);
  assert.ok(rendered);
  assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.nodes) && recipe.nodes.every(Object.isFrozen));
  assert.doesNotMatch(printExpression(rendered), /\b(?:u?int)(?:1|2|3|4|5|6|7|9|31|63)_t\b/);
  for (const a of values) for (const b of values) {
    const expected = E.evaluateExpr(term,new Map([[f.a.symbolId,a],[f.b.symbolId,b]]));
    assert.equal(expected.status, E.EVAL_STATUS.VALUE);
    assert.equal(evaluateExpression(rendered,{a,b}),BigInt(expected.value), `${term.kind}/${term.op} BV${f.a.sort.width} a=${a} b=${b}`);
  }
  return rendered;
}

test('C4-04 scalar lowering agrees exhaustively with canonical Bool/BV evaluation at small widths', () => {
  for (const bits of [1,2,3,4,5]) {
    const f = scalarInputs(bits), values = Array.from({length:2 ** bits},(_,i) => BigInt(i));
    for (const op of ['add','sub','mul','and','or','xor','shl','lshr','ashr']) checkLowering(E.createBinary(op,f.a,f.b),f,values);
    for (const op of ['not','neg']) checkLowering(E.createUnary(op,f.a),f,values);
    for (const op of ['eq','ne','ult','ule','ugt','uge','slt','sle','sgt','sge']) checkLowering(E.createCompare(op,f.a,f.b),f,values);
    checkLowering(E.createIte(E.createCompare('slt',f.a,f.b),f.a,f.b),f,values);
  }
});

test('C4-04 native-width wrap, signed inputs and saturating shift boundaries use the same lowering', () => {
  for (const bits of [8,16,32,64]) {
    const f = scalarInputs(bits), mask = (1n << BigInt(bits)) - 1n;
    const values = [0n,1n,BigInt(bits - 1),BigInt(bits),BigInt(bits + 1),mask,1n << BigInt(bits - 1)];
    for (const op of ['add','sub','mul','and','or','xor','shl','lshr','ashr']) checkLowering(E.createBinary(op,f.a,f.b),f,values);
    for (const op of ['not','neg']) checkLowering(E.createUnary(op,f.a),f,values);
    for (const op of ['ult','slt']) checkLowering(E.createCompare(op,f.a,f.b),f,values);
  }
});

test('C4-04 extraction, concatenation, width changes and Boolean terms preserve their canonical meaning', () => {
  for (const bits of [1,4,8,16,32]) {
    const f = scalarInputs(bits), values = [0n,1n,(1n << BigInt(bits)) - 1n,1n << BigInt(bits - 1)];
    for (const op of ['zext','sext']) checkLowering(E.createCast(op,f.a,bits * 2),f,values);
    if (bits > 1) checkLowering(E.createCast('trunc',f.a,bits - 1),f,values);
    checkLowering(E.createExtract(f.a,bits - 1,Math.floor(bits / 2)),f,values);
    checkLowering(E.createConcat(f.a,f.b),f,values);
    const left = E.createCompare('ult',f.a,f.b), right = E.createCompare('slt',f.a,f.b);
    for (const op of ['and','or','xor','implies','eq','ne']) checkLowering(E.createConnective(op,left,right),f,values);
    checkLowering(E.createConnective('not',left),f,values);
  }
});

test('C4-04 printed C preserves signed input selects and 32-to-64 sign extension at the real compiler boundary', () => {
  const source = ['#include <stdint.h>'], checks = [];
  let index = 0;
  for (const bits of [8,16,32,64]) {
    const f = scalarInputs(bits), terms = [f.a,E.createIte(E.createCompare('slt',f.a,f.b),f.a,f.b)];
    if (bits < 64) terms.push(E.createCast('sext',f.a,bits * 2));
    const values = [0n,(1n << BigInt(bits)) - 1n,1n << BigInt(bits - 1)];
    for (const term of terms) {
      const rendered = renderProofExpression(compileProofExpression(term,f.binding),f.inputs), name = `scalar_${index++}`;
      source.push(`static uint64_t ${name}(int${bits}_t a,int${bits}_t b) { return (uint64_t)(${printExpression(rendered)}); }`);
      for (const a of values) for (const b of values) {
        const expected = E.evaluateExpr(term,new Map([[f.a.symbolId,a],[f.b.symbolId,b]]));
        assert.equal(expected.status,E.EVAL_STATUS.VALUE);
        checks.push(`if (${name}((int${bits}_t)UINT64_C(${a}),(int${bits}_t)UINT64_C(${b})) != UINT64_C(${BigInt(expected.value)})) return ${index};`);
      }
    }
  }
  source.push('int main(void) {',...checks,'return 0; }');
  // Agent execution supplies a verified persistent TMPDIR. The compiler sees
  // the actual printer output and UBSan; AST evaluation alone missed this bug.
  const directory = mkdtempSync(join(tmpdir(),'hex-proof-scalar-c-')), binary = join(directory,'check');
  const compiled = spawnSync(process.env.CC || 'cc',['-std=c11','-O2','-fsanitize=undefined','-fno-sanitize-recover=all','-x','c','-','-o',binary],
    {input:source.join('\n'),encoding:'utf8',timeout:30000});
  assert.equal(compiled.status,0,compiled.stderr || String(compiled.error));
  const executed = spawnSync(binary,[],{encoding:'utf8',timeout:30000});
  assert.equal(executed.status,0,executed.stderr || `printed C mismatch case ${executed.status}`);
});

test('C4-04 display recipes cannot manufacture inputs or silently lower unsupported effects and division', () => {
  const f = scalarInputs(4);
  assert.equal(compileProofExpression(E.createFreshSymbol(E.bvSort(4),'a'),f.binding),null);
  assert.equal(compileProofExpression(E.createBinary('udiv',f.a,f.b),f.binding),null);
  assert.equal(compileProofExpression(E.createUnknownSemantic(E.bvSort(4),'memory'),f.binding),null);
  const recipe = compileProofExpression(f.a,f.binding);
  assert.equal(renderProofExpression(recipe,[]),null);
  assert.equal(renderProofExpression(recipe,[expr.variable('a',8)]),null);
  assert.equal(renderProofExpression(recipe,[{...f.inputs[0],effect:'read'}]),null);
  assert.equal(renderProofExpression(recipe,f.inputs,() => true),null);
  assert.equal(sameProofExpression(recipe,f.inputs,recipe,[{...f.inputs[0]}]),false);
  assert.equal(sameProofExpression(recipe,f.inputs,recipe,f.inputs),true);
});

test('C4-04 display compilation bounds depth and shared-DAG print expansion', () => {
  const f = scalarInputs(4);
  let term = f.a;
  for (let i = 0; i < 23; i++) term = E.createUnary('not',term);
  assert.ok(compileProofExpression(term,f.binding));
  term = E.createUnary('not',term);
  assert.equal(compileProofExpression(term,f.binding),null);
  term = f.a;
  for (let i = 0; i < 8; i++) term = E.createBinary('add',term,term);
  assert.ok(compileProofExpression(term,f.binding));
  term = E.createBinary('add',term,term);
  assert.equal(compileProofExpression(term,f.binding),null);
  term = f.a;
  for (let i = 0; i < 12; i++) term = E.createBinary('ashr',term,f.b);
  assert.equal(compileProofExpression(term,f.binding),null);
  assert.throws(() => compileProofExpression(f.a,f.binding,{take() { throw new Error('budget'); }}),/budget/);
});

function mbaFixture(bits = 4) {
  const f = fixture('nonconstant_mba'); f.block(0);
  const a = f.opaque(bits), b = f.opaque(bits);
  a.index = 0; a.reg = 'x0'; b.index = 1; b.reg = 'x1';
  const xor = f.binary('xor',a,b,bits), and = f.binary('and',a,b,bits);
  const shift = f.binary('shl',and,f.constant(1n,bits),bits);
  const target = f.binary('add',xor,shift,bits); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis,...block.insts]);
  ir.instructions.forEach((inst,index) => { inst.id = `mba_${index}`; inst.address = 0x1000n + BigInt(index * 4); });
  const ret = ir.instructions.at(-1); ret.args = [{value:target}];
  const result = enhanceSemanticDecompilation({semantic:true,ir,types:null,lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}],metrics:{},ctx:{}},null,
    {phase8PrepareProof:true,decompilerTimeBudgetMs:1000,returnType:`uint${Math.max(8,bits)}_t`});
  return {ir,target,a,b,result,options:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],timeoutMs:1000,backendTier:'tiered',candidateStrategy:'equality-saturation'}};
}

test('C4-04 production optimizer actually publishes a proved nonconstant MBA replacement and its origins', async () => {
  const f = mbaFixture(), before = f.result.pseudocode;
  assert.match(before,/\^/);
  const result = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(result.proofOptimization.status,'complete',result.proofOptimization.reason);
  assert.equal(result.proofOptimization.adopted,1);
  assert.equal(result.proofOptimization.targetDecisions[0].disposition,'adopted');
  assert.notEqual(result.pseudocode,before); assert.doesNotMatch(result.pseudocode,/\^/);
  assert.match(result.pseudocode,/\+/);
  assert.equal(result.ir,f.ir); assert.equal(f.result.pseudocode,before);
  const record = result.phase8Projection.transforms.find(record => record.kind === 'solver-scalar');
  assert.ok(record.queryHash && record.beforeHash && record.afterHash && record.planId);
  assert.ok(record.origin.rows.includes(f.target.def.row));
  assert.ok(result.renderProvenance.ledger.some(row => row.kind === 'solver-scalar' && row.queryHash === record.queryHash));
  assert.ok(isProducerProjection(result));
  const expression = result.semanticAst.values.find(item => item.valueId === f.target.id).expression;
  const inputs = f.result.semanticAst.values.filter(item => [f.a.id,f.b.id].includes(item.valueId)).map(item => item.expression.name);
  for (let a = 0n; a < 16n; a++) for (let b = 0n; b < 16n; b++) {
    assert.equal(evaluateExpression(expression,{[inputs[0]]:a,[inputs[1]]:b}),(a+b)&15n);
  }
  const replay = await optimizeSemanticDecompilation(result,f.options);
  assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted,0);
  assert.equal(replay.pseudocode,result.pseudocode);
  assert.ok(replay.phase8Projection.history.transforms.includes(record));
  assert.ok(replay.renderProvenance.ledger.some(row => row.kind === 'solver-scalar' && row.queryHash === record.queryHash));
});

test('C4-04 nonconstant plans retain private proof authority and failed publication leaves source untouched', async () => {
  const f = mbaFixture(), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  assert.equal(plan.entries[0].kind,'solver-scalar');
  const context = {ir:f.ir,proofIdentity:identity,abiId:'generic-v1'};
  assert.equal(isPhase8RewritePlan({...plan},context),false);
  assert.equal(isPhase8RewritePlan(plan,context),true);
  const failed = await optimizeSemanticDecompilation(f.result,{...f.options,phase8WorkBudget:0});
  assert.equal(failed.proofOptimization.adopted,0);
  assert.equal(failed.pseudocode,f.result.pseudocode);
  assert.ok(failed.proofOptimization.targetDecisions.every(row => row.disposition === 'unknown'));
  f.a.bits = 8;
  assert.equal(isPhase8RewritePlan(plan,context),false);
});

test('C4-05 full frozen MBA width axis reaches the real producer/transaction/projection, including withheld wide cells', async t => {
  const rows = [];
  for (const bits of [1,2,3,4,8,16,32,64]) {
    const f = mbaFixture(bits), text = f.result.pseudocode;
    const instructions = [...f.ir.instructions];
    const expressions = f.result.semanticAst.values.map(item => item.expression);
    const r = await optimizeSemanticDecompilation(f.result,f.options);
    rows.push({bits,status:r.proofOptimization.status,reason:r.proofOptimization.reason,adopted:r.proofOptimization.adopted});
    assert.equal(r.ir,f.ir);
    assert.deepEqual(f.ir.instructions,instructions);
    assert.equal(f.target.def.sub,'add');
    assert.equal(f.result.pseudocode,text);
    assert.deepEqual(f.result.semanticAst.values.map(item => item.expression),expressions);
    if (bits >= 8 && r.proofOptimization.status !== 'complete') {
      assert.equal(r.proofOptimization.status,'partial');
      assert.match(r.proofOptimization.reason,/^(cancelled|timeout|deadline-exceeded|budget:.*)$/);
      assert.equal(r.proofOptimization.adopted,0);
      assert.equal(r.pseudocode,text);
      assert.ok(r.proofOptimization.targetDecisions.every(row => row.disposition === 'unknown'));
      continue;
    }
    assert.equal(r.proofOptimization.status,'complete',`${bits}:${r.proofOptimization.reason}`);
    assert.equal(r.proofOptimization.adopted,1,`${bits}:real projection adoption`);
    const record = r.phase8Projection.transforms.find(record => record.kind === 'solver-scalar');
    assert.ok(record?.queryHash && record.beforeHash && record.afterHash && record.planId);
    assert.ok(r.renderProvenance.ledger.some(row => row.queryHash === record.queryHash));
    const expression = r.semanticAst.values.find(item => item.valueId === f.target.id).expression;
    const names = f.result.semanticAst.values.filter(item => [f.a.id,f.b.id].includes(item.valueId)).map(item => item.expression.name);
    const count = bits <= 4 ? 2 ** bits : 16, mask = (1n << BigInt(bits)) - 1n;
    for (let a=0;a<count;a++) for (let b=0;b<count;b++) {
      assert.equal(evaluateExpression(expression,{[names[0]]:BigInt(a),[names[1]]:BigInt(b)}),(BigInt(a)+BigInt(b))&mask);
    }
  }
  assert.equal(rows.length,8);
  t.diagnostic(JSON.stringify({denominator:'c4-05-mba-production-widths-v1',rows}));
});
