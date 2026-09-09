import assert from 'node:assert/strict';
import test from 'node:test';
import { readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { analysis, consumerFixture as fixture, expr, resultWith, source } from './fixture.js';


function identityRecord(map) { return map.ledger.find(record => record.rule === 'add-zero-right' && record.valueId === 3); }

test('C4-03 actual store and return consumers bind the same rewritten value, not an unrelated shared input', () => {
  const f = fixture();
  const result = applyPhase8Projection(f.enhanced, analysis());
  const map = result.renderProvenance, record = identityRecord(map);
  assert.equal(record.renderedBinding, 'producer-bound');
  assert.deepEqual(record.producedRefs, ['L0:stmt', 'L2:stmt']);
  assert.deepEqual(map.reverse[`addr:${f.add.address}`], ['L0:stmt', 'L2:stmt']);
  assert.deepEqual(map.entities['L1:stmt'].recordRefs, [], 'reading the same input does not consume the add rewrite');
  assert.equal(validateRenderProvenance(map).state, 'complete');
});

test('C4-03 consumer binding preserves the surviving load identity and source arrays', () => {
  const f = fixture({ load:true });
  const expression = f.enhanced.cAst.body[0].semantic.expression;
  assert.equal(expression.kind, 'load');
  const key = structuralKey(expression), source = structuredClone(expression.source);
  const result = applyPhase8Projection(f.enhanced, analysis());
  assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'producer-bound');
  assert.equal(structuralKey(expression), key);
  assert.deepEqual(expression.source, source);
  assert.equal(structuralKey(result.cAst.body[0].semantic.expression), key);
});

test('C4-03 query navigation reaches the real consumers of an elided operator origin', async () => {
  const f = fixture();
  const result = applyPhase8Projection(f.enhanced, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'bound-expression', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:result, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.add.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0, 2]);
  assert.equal(selected.transforms.find(record => record.rule === 'add-zero-right').renderedBinding, 'producer-bound');
  const opened = [];
  await navigation.openAddress(f.add.address, address => opened.push(address));
  assert.deepEqual(opened, [f.add.address]);
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.add.address)).reason, 'stale-query-snapshot');
});

test('C4-03 replacement, in-place mutation, changed IR and altered records invalidate producer bindings', () => {
  for (const mutate of [
    f => { f.enhanced.cAst.body[0].semantic.expression = { ...f.enhanced.cAst.body[0].semantic.expression }; },
    f => { f.enhanced.cAst.body[0].semantic.expression.bits = 32; },
    f => { f.sum.def.args[1].value = f.input; },
    f => { f.enhanced.rewriteProof.find(record => record.rule === 'add-zero-right').rule = 'changed'; },
    f => { f.enhanced.ir = { ...f.ir }; },
  ]) {
    const f = fixture();
    assert.ok(readExpressionHistoryConsumer(f.enhanced.cAst.body[0].semantic, f.enhanced.ir));
    mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.enhanced.cAst.body[0].semantic, f.enhanced.ir), null);
  }
});

test('C4-03 copying a producer descriptor or record does not copy binding authority', () => {
  for (const mode of ['descriptor', 'record']) {
    const f = fixture();
    if (mode === 'descriptor') {
      f.enhanced.cAst.body = f.enhanced.cAst.body.map(node => ({ ...node, semantic:{ ...node.semantic } }));
    } else f.enhanced.rewriteProof = f.enhanced.rewriteProof.map(record => ({ ...record }));
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.equal(identityRecord(map).renderedBinding, 'unresolved');
    assert.deepEqual(identityRecord(map).producedRefs, []);
  }
});

test('C4-03 a recovered/replaced consumer does not inherit the previous expression history', () => {
  const f = fixture();
  // Both values legitimately reduce to the same input object. A replacement
  // must actually change the expression, not assign that identical object.
  f.enhanced.cAst.body[0].semantic.expression = { ...f.enhanced.cAst.body[1].semantic.expression };
  const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
  assert.deepEqual(identityRecord(map).producedRefs, ['L2:stmt']);
});

test('C4-03 copied or edited rendered lines cannot replay a producer binding', () => {
  for (const mode of ['copy', 'edit']) {
    const f = fixture();
    const projected = applyPhase8Projection(f.enhanced, analysis());
    if (mode === 'copy') projected.lines = projected.lines.map(line => ({ ...line }));
    else projected.lines[0].text = 'unrelated();';
    const map = buildRenderProvenance({ result:projected, snapshotId:projected.renderProvenance.snapshotId });
    assert.deepEqual(identityRecord(map).producedRefs, mode === 'copy' ? [] : ['L2:stmt']);
  }
});

test('C4-03 a late IR mutation invalidates the map instead of publishing stale bound edges', () => {
  const f = fixture();
  const projected = applyPhase8Projection(f.enhanced, analysis());
  let checks = 0;
  const map = buildRenderProvenance({ result:projected, snapshotId:projected.renderProvenance.snapshotId,
    shouldAbort:() => { if (++checks === 5) f.sum.def.sub = 'sub'; return false; } });
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('stale-expression-binding'));
});

test('C4-03 validator rejects a bound record whose actual consumer back-reference is missing', () => {
  const map = structuredClone(applyPhase8Projection(fixture().enhanced, analysis()).renderProvenance);
  assert.equal(validateRenderProvenance(map).state, 'complete');
  map.entities['L0:stmt'].recordRefs = [];
  assert.equal(validateRenderProvenance(map).state, 'incomplete');
});

test('C4-03 direct-value branch conditions carry the actual nested expression consumer', () => {
  const f = fixture({ branch:true });
  const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
  assert.deepEqual(identityRecord(map).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
  assert.deepEqual(map.entities['L4:stmt'].recordRefs, [], 'the other branch returns the shared input without consuming the add');
});

test('C4-03 already-correct condition text binds, but malformed or ambiguous replacements do not', () => {
  for (const mode of ['same-text', 'malformed', 'ambiguous']) {
    const f = fixture({ branch:true });
    if (mode === 'same-text') {
      f.enhanced.cAst.body[2].text = `if (${f.enhanced.semanticAst.conditions[0].text}) goto loc_taken;`;
    } else if (mode === 'malformed') f.enhanced.cAst.body[2].text = 'if (missing closing parenthesis';
    else f.enhanced.semanticAst.conditions.push({ ...f.enhanced.semanticAst.conditions[0] });
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.equal(identityRecord(map).producedRefs.includes('L2:ctrl'), mode === 'same-text', mode);
  }
});

test('C4-03 bound consumer origins retain the existing truncation and cancellation boundary', () => {
  const limited = applyPhase8Projection(fixture().enhanced, analysis(), { renderProvenanceBudget:{ maxOriginsPerEntity:2 } });
  assert.equal(identityRecord(limited.renderProvenance).renderedBinding, 'producer-bound');
  assert.equal(limited.renderProvenance.completeness, 'incomplete');
  assert.equal(validateRenderProvenance(limited.renderProvenance).state, 'incomplete');
  const cancelled = applyPhase8Projection(fixture().enhanced, analysis(), { shouldAbort:() => true });
  assert.deepEqual(cancelled.renderProvenance.reasons, ['cancelled']);
  assert.deepEqual(cancelled.renderProvenance.ledger, []);
});

test('C4-03 cumulative binding budgets stop new observations without changing decompilation', () => {
  const normal = fixture();
  for (const [bindingBudget, expected] of [
    [{ maxConsumers:1 }, ['L0:stmt']],
    [{ maxEdges:0 }, []],
    [{ maxEdges:1 }, []],
  ]) {
    const f = fixture({ bindingBudget });
    assert.equal(f.enhanced.pseudocode, normal.enhanced.pseudocode);
    assert.equal(f.enhanced.expressionHistoryBinding.completeness, 'incomplete');
    assert.ok(f.enhanced.expressionHistoryBinding.reasons.includes('binding-budget'));
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.deepEqual(identityRecord(map).producedRefs, expected);
    assert.equal(identityRecord(map).renderedBinding, expected.length ? 'producer-bound' : 'unresolved');
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('incomplete-expression-binding'));
  }
});

test('C4-03 successive owned projections retain store, return and branch history without accumulating records', () => {
  const f = fixture({ branch:true });
  let result = f.enhanced;
  let originalText, originalCount;
  for (let generation = 0; generation < 12; generation++) {
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.history.completeness, 'complete');
    assert.equal(result.renderProvenance.completeness, 'complete');
    assert.deepEqual(identityRecord(result.renderProvenance).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
    originalText ??= result.pseudocode;
    originalCount ??= result.renderProvenance.ledger.length;
    assert.equal(result.pseudocode, originalText);
    assert.equal(result.renderProvenance.ledger.length, originalCount);
  }
});

test('C4-03 no-op re-projection retains actual earlier view transforms and their reverse map', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const expression = expr.unary('trunc', expr.unary('trunc', value, 32, false, source(2, 2)), 8, false, source(3, 3));
  let result = applyPhase8Projection(resultWith(expression), analysis());
  assert.equal(result.phase8Projection.transforms.length, 1);
  const record = result.phase8Projection.transforms[0];
  const reverse = result.renderProvenance.reverse;
  for (let generation = 0; generation < 8; generation++) {
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.transforms.length, 0, 'old transforms must not be counted as newly applied');
    assert.equal(result.phase8Projection.history.transforms.length, 1);
    assert.equal(result.phase8Projection.history.transforms[0], record, 'retain the actual record, not a guessed equivalent');
    assert.equal(result.renderProvenance.ledger.length, 1);
    assert.deepEqual(result.renderProvenance.reverse, reverse);
  }
});

test('C4-03 ordinary result envelopes preserve the exact owned AST transition', () => {
  let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
  result = applyPhase8Projection({ ...result, ctx:{ ...result.ctx, wrapper:'phase-envelope' } }, analysis());
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.deepEqual(identityRecord(result.renderProvenance).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
});

test('C4-03 re-projection refuses altered or copied transition data, even when expressions look equal', () => {
  for (const mutate of [
    result => { result.cAst = { ...result.cAst }; },
    result => { result.cAst.body = [...result.cAst.body]; },
    result => { result.cAst.body[0].semantic.expression = { ...result.cAst.body[0].semantic.expression }; },
    result => { result.semanticAst.conditions[0].row++; },
    result => { result.rewriteProof = result.rewriteProof.map(record => ({ ...record })); },
    result => { result.phase8Projection = { ...result.phase8Projection }; },
    result => { result.expressionHistoryBinding = { ...result.expressionHistoryBinding }; },
    result => { result.ir = { ...result.ir }; },
  ]) {
    let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
    mutate(result);
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.history.completeness, 'incomplete');
    assert.equal(result.renderProvenance.completeness, 'incomplete');
    assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'unresolved');
  }
});

test('C4-03 projection retention caps and cancellation cannot become complete on a later no-op', () => {
  let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis(), { renderProvenanceBindingBudget:{ maxEdges:1 } });
  assert.ok(result.phase8Projection.history.reasons.includes('projection-history-budget'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  result = applyPhase8Projection(result, analysis());
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  const valid = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
  const cancelled = applyPhase8Projection(valid, analysis(), { shouldAbort:() => true });
  assert.deepEqual(cancelled.renderProvenance.reasons, ['cancelled']);
  assert.deepEqual(cancelled.renderProvenance.ledger, []);
});

test('C4-03 repeated projection leaves the original surviving load and canonical IR unchanged', () => {
  const f = fixture({ load:true, branch:true });
  const original = f.enhanced.cAst.body[0].semantic.expression;
  const key = structuralKey(original), originalSource = structuredClone(original.source);
  let result = f.enhanced;
  for (let generation = 0; generation < 6; generation++) result = applyPhase8Projection(result, analysis());
  assert.equal(result.ir, f.ir);
  assert.equal(f.sum.def.sub, 'add');
  assert.equal(structuralKey(original), key);
  assert.deepEqual(original.source, originalSource);
  assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'producer-bound');
});
