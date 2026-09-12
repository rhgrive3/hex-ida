import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis, proofOnlySpillFixture, suppressedSpillFixture } from './fixture.js';

test('C4-03 actual proof-only statement removal retains an old-position tombstone and the surviving return', () => {
  const f = proofOnlySpillFixture(), canonical = structuredClone(f.result.ir);
  recoverExactStackReturn(f.result);
  assert.ok(!f.result.cAst.body.includes(f.removedNode));
  assert.equal(f.result.cAst.body[0].text, 'local_other = 1;');
  let result = applyPhase8Projection(f.result, analysis());
  const map = result.renderProvenance, record = map.ledger.find(record => record.rule === 'remove-proof-only-stack-spill');
  assert.deepEqual(record.renderedRemoval, { scope:'pre-transform-render', operation:'remove', lineIndex:0, kind:'stmt' });
  assert.equal(record.renderedBinding, 'producer-bound');
  assert.deepEqual(record.producedRefs, ['L1:stmt']);
  assert.deepEqual(record.removedRefs, [`before:${map.ledger.indexOf(record)}:L0:stmt`]);
  assert.ok(!Object.hasOwn(map.entities, record.removedRefs[0]));
  assert.deepEqual(map.reverse[`addr:${f.store.address}`], ['L1:stmt']);
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.deepEqual(f.result.ir, canonical);
  for (let i = 0; i < 4; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger.find(record => record.renderedRemoval).removedRefs, record.removedRefs);
});

test('C4-03 real core suppression binds its history to the return, not a current line with the old position', () => {
  const f = suppressedSpillFixture();
  assert.equal(f.result.cAst.body[0].text, '');
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  const record = map.ledger.find(record => record.rule === 'suppress-return-spill-statement');
  assert.equal(record.renderedRemoval.operation, 'suppress');
  assert.deepEqual(record.producedRefs, ['L2:stmt']);
  assert.deepEqual(record.removedRefs, [`before:${map.ledger.indexOf(record)}:L0:stmt`]);
  assert.ok(map.reverse[`addr:${f.store.address}`].includes('L2:stmt'));
  assert.equal(validateRenderProvenance(map).state, 'complete');
});

test('C4-03 no successful removal predicate means no removed-statement history', () => {
  const f = proofOnlySpillFixture({ committed:false });
  recoverExactStackReturn(f.result);
  assert.ok(f.result.cAst.body.includes(f.removedNode));
  assert.ok(!f.result.rewriteProof?.some(record => record.renderedRemoval));
  const core = suppressedSpillFixture({ matching:false });
  assert.notEqual(core.result.cAst.body[0].text, '');
  assert.ok(!core.result.rewriteProof.some(record => record.renderedRemoval));
});

test('C4-03 copied return metadata or changed canonical evidence cannot certify a removed render reference', () => {
  for (const mutate of [
    f => { f.returnNode.semantic = { ...f.returnNode.semantic }; },
    f => { f.store.loc.size = 4; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = proofOnlySpillFixture();
    recoverExactStackReturn(f.result);
    mutate(f);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    const record = map.ledger.find(record => record.renderedRemoval);
    assert.equal(record.renderedBinding, 'unresolved');
    assert.deepEqual(record.removedRefs, []);
  }
});

test('C4-03 removal history budgets do not retain a removed statement just to keep evidence complete', () => {
  const f = proofOnlySpillFixture({ duplicate:true });
  recoverExactStackReturn(f.result, { renderProvenanceBudget:{ maxTransformRecords:1 } });
  assert.equal(f.result.cAst.body.length, 2, 'both matching proof-only statements are still removed');
  assert.equal(f.result.rewriteProof.filter(record => record.renderedRemoval).length, 1);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('render-removal-history-budget'));
  assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
});

test('C4-03 validator rejects current-line aliases and malformed removal tombstones', () => {
  const f = proofOnlySpillFixture();
  recoverExactStackReturn(f.result);
  const original = applyPhase8Projection(f.result, analysis()).renderProvenance;
  for (const mutate of [
    record => { record.removedRefs = ['L0:stmt']; },
    record => { record.removedRefs = []; },
    record => { record.renderedRemoval.lineIndex = -1; },
    record => { record.renderedRemoval.scope = 'canonical-ir'; },
    record => { delete record.renderedRemoval; },
  ]) {
    const map = structuredClone(original);
    mutate(map.ledger.find(record => record.renderedRemoval));
    assert.ok(validateRenderProvenance(map).reasons.includes('invalid-render-removal'));
  }
});

test('C4-03 already-hidden core statements do not acquire another suppression event', () => {
  const f = suppressedSpillFixture({ alreadyHidden:true });
  assert.equal(f.result.cAst.body[0].text, '');
  assert.ok(!f.result.rewriteProof.some(record => record.renderedRemoval));
});

test('C4-03 unavailable suppression observations and exhausted removal history remain incomplete', () => {
  for (const options of [
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
  ]) {
    const f = suppressedSpillFixture({ options });
    assert.equal(f.result.cAst.body[0].text, '');
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    const result = applyPhase8Projection(f.result, analysis());
    assert.equal(result.renderProvenance.completeness, 'incomplete');
    assert.ok(result.renderProvenance.ledger.every(record => record.removedRefs.length === 0));
  }
});
