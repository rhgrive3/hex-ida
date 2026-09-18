import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';
import { readDceResultProof, DCE_PASS, runDcePass } from '../../../js/decompiler/phase8/dce.js';
import { createAnalysisState, seedAnalysisState, runPassTransaction, forkAnalysisState, commitAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { printProgram } from '../../../js/decompiler/pretty/c.js';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function checkPrintedCalls(f, projected, bits) {
  const type = `uint${bits}_t`, input = f.result.semanticAst.values.find(row => row.valueId === f.input.id).expression.name;
  const render = (result, name) => {
    assert.equal(result.cAst.body[0].kind, 'sig'); assert.equal(result.cAst.body[1].text, '{');
    const body = result.cAst.body.map((node, index) => index === 0 ? { ...node, text:`static ${type} ${name}(${type} ${input})` }
      : index === 1 ? { ...node, text:`{\n${type} ${f.calls.map(call => `call_${call.id}`).join(', ')};` } : node);
    // Harness-only signature and local declarations. Every actual emitted
    // statement and its order is printed unchanged by the production printer.
    return printProgram({ ...result.cAst, body }).text;
  };
  const source = ['#include <stdint.h>', 'static uint64_t count, order;',
    `static ${type} callee(void) { ++count; order = order * 17 + 1; return (${type})(count * 3); }`,
    `static ${type} callee_second(void) { ++count; order = order * 17 + 2; return (${type})(count * 5); }`,
    render(f.result, 'before'), render(projected, 'after'),
    `int main(void) { for (uint32_t input = 0; input < 256; ++input) {`,
    'count = order = 0; uint64_t a = before(input), beforeCount = count, beforeOrder = order;',
    'count = order = 0; uint64_t b = after(input);',
    `if (a != b || a != 0 || count != ${f.calls.length} || count != beforeCount || order != beforeOrder) return 1;`,
    '} return 0; }'].join('\n');
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, 'hex-dce-calls-')), binary = join(directory, 'check');
  const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11', '-O2', '-fsanitize=undefined',
    '-fno-sanitize-recover=all', '-x', 'c', '-', '-o', binary], { input:source, encoding:'utf8', timeout:30000 });
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
  const executed = spawnSync(binary, [], { encoding:'utf8', timeout:30000 });
  assert.equal(executed.status, 0, executed.stderr || 'printed C changed the observable call count/order or return value');
}

function callFixture({ live = false, bits = 32, depth = 1, callCount = 1, trapping = false, renderOptions = {} } = {}) {
  const f = fixture('dead-call-result'); f.block(0);
  const input = f.opaque(bits); input.reg = 'x1';
  const calls = []; let derived;
  for (let i = 0; i < callCount; i++) {
    const call = f.call(bits); call.reg = `x${9 + i}`; call.def.extra.name = i === 0 ? 'callee' : 'callee_second'; calls.push(call);
    derived = call;
    for (let j = 0; j < depth; j++) derived = trapping ? f.divide(derived, input, bits) : f.binary('add', derived, input, bits);
  }
  const call = calls[0], zero = f.constant(0n, bits); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, i) => { inst.id = 100 + i; inst.row = i; inst.address = 0x6000n + BigInt(i * 4); });
  const ret = ir.instructions.at(-1), returned = live ? derived : zero;
  ret.args = [{ value:returned }]; returned.uses.push(ret);
  ir.blocks[0].startRow = 0; ir.blocks[0].endRow = ret.row;
  ir.args = new Map([['x1', input]]);
  const model = { name:'dead_call_result', instructions:ir.instructions, calls:[] };
  const options = { ir, deterministicTransforms:true, defaultCallArgs:0, ...renderOptions };
  const seed = decompileSemantic(model, options);
  const result = enhanceSemanticDecompilation(seed, model, options);
  const vertical = runPhase8Vertical({ ir });
  assert.equal(vertical.ledger.published, true, vertical.ledger.stopReason);
  return { ir, input, call, calls, derived, result, vertical };
}

test('C4-03 DCE removes a genuinely unused call-result assignment but executes the call', () => {
  const f = callFixture(), before = structuredClone(f.ir);
  const original = f.result.cAst.body.find(node => node.semantic?.ir === f.call.def.id);
  assert.ok(original.text.startsWith(`call_${f.call.id} = `), 'actual initial renderer must materialize the call through its dead scalar use');
  const facts = f.vertical.analysis.get('deadCode');
  assert.ok(facts.candidates.some(row => row.valueId === f.derived.id));
  assert.ok(facts.deadButObservable.some(row => row.valueId === f.call.id));
  const result = applyPhase8Projection(f.result, f.vertical.analysis);
  const retained = result.cAst.body.find(node => node.semantic?.ir === f.call.def.id);
  assert.equal(retained.text, 'callee();', 'remove the dead result binding, not the observable call');
  assert.equal(result.cAst.body.filter(node => node.semantic?.ir === f.call.def.id).length, 1);
  assert.equal(original.text.startsWith(`call_${f.call.id} = `), true, 'input AST must not be edited');
  assert.deepEqual(structuredClone(f.ir), before);
  const record = result.renderProvenance.ledger.find(row => row.rule === 'eliminate-dead-call-result');
  assert.ok(record); assert.equal(record.producedRefs.length, 1); assert.equal(record.removedRefs.length, 1);
  assert.equal(record.renderedBinding, 'producer-bound');
  assert.deepEqual(result.renderProvenance.reverse[`ir:${f.call.def.id}`], record.producedRefs);
  assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
  let replay = result;
  for (let i = 0; i < 3; i++) replay = applyPhase8Projection(replay, f.vertical.analysis);
  assert.equal(replay.pseudocode, result.pseudocode);
  assert.deepEqual(replay.renderProvenance.ledger.find(row => row.rule === record.rule), record);
});

test('C4-03 live call results are retained and candidate-shaped facts cannot authorize DCE', () => {
  for (const live of [false, true]) {
    const f = callFixture({ live });
    const analysis = live ? f.vertical.analysis : { get:key => key === 'deadCode'
      ? structuredClone(f.vertical.analysis.get(key)) : f.vertical.analysis.get(key) };
    const result = applyPhase8Projection(f.result, analysis);
    assert.ok(result.cAst.body.find(node => node.semantic?.ir === f.call.def.id).text.startsWith(`call_${f.call.id} = `));
    assert.equal(result.renderProvenance.ledger.some(row => row.rule === 'eliminate-dead-call-result'), false);
  }
});

const callNode = f => f.result.cAst.body.find(node => node.semantic?.ir === f.call.def.id);
function assertWithheld(f, analysis = f.vertical.analysis, options = {}) {
  const before = callNode(f).text;
  assert.ok(before.startsWith(`call_${f.call.id} = `), 'negative control must start with a real result assignment');
  const result = applyPhase8Projection(f.result, analysis, options);
  assert.equal(result.cAst.body.find(node => node.semantic?.ir === f.call.def.id).text, before);
  assert.ok(!result.renderProvenance?.ledger.some(row => row.rule === 'eliminate-dead-call-result'));
}

test('C4-03 DCE retains results used by a possibly trapping dead-looking expression', () => {
  const f = callFixture({ trapping:true });
  assert.ok(!f.vertical.analysis.get('deadCode').deadButObservable.some(row => row.valueId === f.call.id));
  assertWithheld(f);
});

test('C4-03 stale canonical uses, definitions, facts and copied emitters withhold dead-result removal', () => {
  for (const mutate of [
    f => { f.call.uses.push(f.ir.instructions.at(-1)); },
    f => { f.derived.def.extra.stateWrite = { key:'flags' }; },
    f => { f.vertical.analysis.get('deadCode').deadButObservable[0].valueId = -1; },
    f => { const index = f.result.cAst.body.indexOf(callNode(f)); f.result.cAst.body[index] = structuredClone(callNode(f)); },
    f => { f.result.cAst.body.push({ kind:'stmt', text:`consume(call_${f.call.id});`, source:{} }); },
  ]) {
    const f = callFixture(); assert.ok(readDceResultProof(f.vertical.analysis, f.ir)); mutate(f); assertWithheld(f);
  }
});

test('C4-03 canonical DCE observation is authority only after its actual transaction and fork commit', () => {
  const f = callFixture(), state = seedAnalysisState(f.ir), before = state.snapshot(), working = forkAnalysisState(state);
  let staged;
  runDcePass({ analysis:state, ir:f.ir }, {}, { stage:(key, value) => { if (key === 'deadCode') staged = value; } });
  assert.equal(readDceResultProof(createAnalysisState({ cfg:state.get('cfg'), ssa:state.get('ssa'), deadCode:staged }), f.ir), null);
  const impersonator = runPassTransaction(working, { descriptor:DCE_PASS, run:(context, budget, area) => runDcePass(context, budget, area) }, { analysis:working, ir:f.ir });
  assert.equal(impersonator.committed, true);
  assert.equal(readDceResultProof(working, f.ir), null);
  const committed = runPassTransaction(working, { descriptor:DCE_PASS, run:runDcePass }, { analysis:working, ir:f.ir });
  assert.equal(committed.committed, true);
  assert.ok(readDceResultProof(working, f.ir)); assert.equal(readDceResultProof(state, f.ir), null);
  assert.equal(commitAnalysisState(state, working, before), true);
  assert.ok(readDceResultProof(state, f.ir));
  const result = applyPhase8Projection(f.result, state);
  assert.equal(result.cAst.body.find(node => node.semantic?.ir === f.call.def.id).text, 'callee();');
});

test('C4-03 cancelled, partial and history-budget-limited work never publishes a result removal', () => {
  for (const options of [
    { shouldAbort:() => true },
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBudget:{ maxEntities:1 } },
  ]) assertWithheld(callFixture(), undefined, options);
  const f = callFixture(), state = seedAnalysisState(f.ir);
  const cancelled = runPassTransaction(state, { descriptor:DCE_PASS, run:runDcePass }, { analysis:state, ir:f.ir }, { shouldAbort:() => true });
  assert.equal(cancelled.committed, false); assertWithheld(f, state);
  let partial;
  runDcePass({ analysis:state, ir:f.ir }, { shouldAbort:() => true }, { stage:(key, value) => { if (key === 'deadCode') partial = value; } });
  assert.equal(partial.completeness, 'partial');
  assertWithheld(f, createAnalysisState({ cfg:state.get('cfg'), ssa:state.get('ssa'), deadCode:partial }));
});

test('C4-03 actual dead-result adoption covers widths, transitive chains and multiple observable calls', t => {
  const rows = [];
  for (const bits of [8, 16, 32, 64]) for (const depth of [1, 3]) for (const callCount of [1, 2]) {
    const f = callFixture({ bits, depth, callCount }), ir = structuredClone(f.ir), ast = structuredClone(f.result.cAst);
    const result = applyPhase8Projection(f.result, f.vertical.analysis);
    const records = result.renderProvenance.ledger.filter(row => row.rule === 'eliminate-dead-call-result');
    assert.equal(records.length, callCount, `${bits}/${depth}/${callCount}`);
    assert.equal(result.renderProvenance.completeness, 'complete');
    for (const call of f.calls) {
      const nodes = result.cAst.body.filter(node => node.semantic?.ir === call.def.id);
      assert.equal(nodes.length, 1); assert.equal(nodes[0].text, `${call.def.extra.name}();`);
      const record = records.find(row => row.valueId === call.id);
      assert.equal(record.producedRefs.length, 1); assert.equal(record.removedRefs.length, 1);
    }
    assert.deepEqual(structuredClone(f.ir), ir); assert.deepEqual(f.result.cAst, ast);
    const replay = applyPhase8Projection(result, f.vertical.analysis);
    assert.equal(replay.pseudocode, result.pseudocode);
    checkPrintedCalls(f, result, bits);
    rows.push({ bits, depth, callCount, removedBindings:records.length, retainedCalls:f.calls.length, compiledC:true, inputCases:256 });
  }
  assert.equal(rows.length, 16);
  t.diagnostic(JSON.stringify({ schema:'c4-dead-call-result-v1', rows }));
});

test('C4-03 late cancellation or liveness mutation rolls back the owned rendered transition', () => {
  const measured = callFixture({ callCount:2 }); let checks = 0;
  const positive = applyPhase8Projection(measured.result, measured.vertical.analysis, { shouldAbort:() => { checks++; return false; } });
  assert.equal(positive.renderProvenance.ledger.filter(row => row.rule === 'eliminate-dead-call-result').length, 2);
  assert.ok(checks > 100, 'measure a complete actual projection before selecting late cancellation positions');
  for (const fraction of [0.5, 0.9]) for (const mutate of [false, true]) {
    const f = callFixture({ callCount:2 }), before = structuredClone(f.result.cAst);
    const threshold = Math.floor(checks * fraction); let calls = 0;
    assertWithheld(f, f.vertical.analysis, { shouldAbort:() => {
      calls++;
      if (calls === threshold && mutate) f.call.uses.push(f.ir.instructions.at(-1));
      return !mutate && calls >= threshold;
    } });
    assert.ok(calls >= threshold, 'the negative must actually reach its late trigger');
    assert.deepEqual(f.result.cAst, before, 'rollback must not publish a partially edited input AST');
  }
});
