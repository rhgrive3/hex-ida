import assert from 'node:assert/strict';
import test from 'node:test';
import { RewriteEngine } from '../../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import { structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis, expr, resultWith, source } from './fixture.js';

function rewrite(root, rules = DEFAULT_RULES, budget = {}) {
  return new RewriteEngine(rules, { deterministic:true, ...budget }).rewrite(root);
}

function identityRewrite() {
  const value = expr.variable('a1', 64, false, source(1, 1));
  const zero = expr.constant(0, 64, false, source(2, 2));
  const root = expr.binary('add', value, zero, 64, false, source(3, 3));
  return { value, zero, root, rewritten:rewrite(root) };
}

function project(rewritten, opts = {}) {
  const result = resultWith(rewritten.root);
  result.rewriteProof = rewritten.proof.map(record => ({ ...record, valueId:99 }));
  return applyPhase8Projection(result, analysis(), opts);
}

test('C4-03 actual expression rewrite captures consumed and surviving canonical origins', () => {
  const { value, root, rewritten } = identityRewrite();
  const record = rewritten.proof.find(item => item.rule === 'add-zero-right');
  assert.ok(record);
  assert.deepEqual(record.originHistory.before.rows, [3, 1, 2]);
  assert.deepEqual(record.originHistory.after.rows, [1]);
  assert.equal(record.before, structuralKey(root));
  assert.equal(record.after, structuralKey(value));
  assert.equal(rewritten.root, value, 'history must not replace or wrap the rewritten expression');
  assert.deepEqual(value.source.rows, [1], 'do not change SSA or load identity through source union');
});

test('C4-03 historical snapshots are immutable and detached from later source mutations', () => {
  const { value, root, rewritten } = identityRewrite();
  const history = rewritten.proof[0].originHistory;
  root.source.rows.push(999);
  value.source.addresses.length = 0;
  assert.deepEqual(history.before.rows, [3, 1, 2]);
  assert.deepEqual(history.after.addresses, [0x1004n]);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history.before));
  assert.throws(() => history.after.rows.push(999), TypeError);
  assert.equal(Object.hasOwn(history.before, 'evidence'), false, 'do not retain recursive evidence chains');
});

test('C4-03 rejected, no-op and cancelled rewrites never create removal history', () => {
  const { root } = identityRewrite();
  const identity = DEFAULT_RULES.find(rule => rule.name === 'add-zero-right');
  assert.deepEqual(rewrite(root, [{ ...identity, proof:() => null }]).proof, []);
  assert.deepEqual(rewrite(root, [{ ...identity, rewrite:node => node }]).proof, []);
  assert.deepEqual(new RewriteEngine(DEFAULT_RULES).rewrite(root, { shouldAbort:() => true }).proof, []);
});

test('C4-03 projection publishes rewrite-engine history without guessing a rendered replacement', () => {
  const result = project(identityRewrite().rewritten);
  const map = result.renderProvenance;
  const record = map.ledger.find(item => item.kind === 'expression-rewrite');
  assert.equal(record.rule, 'add-zero-right');
  assert.equal(record.proof, 'integer-algebra');
  assert.equal(record.valueId, 99);
  assert.equal(record.originHistory.scope, 'replacement-expression-source');
  assert.deepEqual(record.originHistory.producedRefs, ['row:1', 'addr:4100', 'ssa:def:1']);
  for (const ref of ['row:2', 'row:3', 'addr:4104', 'addr:4108', 'ssa:def:2', 'ssa:def:3']) {
    assert.ok(record.originHistory.elidedRefs.includes(ref), ref);
    assert.deepEqual(map.transformReverse[ref], [map.ledger.indexOf(record)]);
  }
  assert.equal(record.renderedBinding, 'unresolved');
  assert.deepEqual(record.producedRefs, [], 'shared a1 input is not evidence of the specific result consumer');
  assert.deepEqual(record.removedRefs, [], 'canonical semantic entities were not deleted');
  assert.equal(map.reverse['row:2'], undefined, 'do not silently attach removed zero/operator to a nearby line');
  assert.deepEqual(map.entities['L0:stmt'].origins.rows, [1, 4]);
  assert.ok(Object.isFrozen(record.originHistory.elidedRefs));
  assert.ok(Object.isFrozen(map.transformReverse['row:2']));
  assert.doesNotThrow(() => JSON.stringify(map), 'public histories retain serializable decimal addresses');
});

test('C4-03 a real rewrite chain retains each step rather than a final before/after guess', () => {
  const first = identityRewrite();
  const outer = expr.binary('mul', first.root, expr.constant(1, 64, false, source(4, 5)), 64, false, source(5, 6));
  const rewritten = rewrite(outer);
  assert.deepEqual(rewritten.proof.map(record => record.rule), ['add-zero-right', 'mul-one-right']);
  const map = project(rewritten).renderProvenance;
  assert.deepEqual(map.ledger.map(record => record.rule), ['add-zero-right', 'mul-one-right']);
  assert.equal(map.ledger[0].after, map.ledger[1].after);
  assert.deepEqual(map.transformReverse['row:6'], [1]);
});

test('C4-03 expression history survives the real query envelope with distinct snapshot identity', async () => {
  const result = project(identityRewrite().rewritten);
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'expression-history', projectRevision:1, analysisEpoch:1, artifactVersions:{} }),
    decompile:async () => ({ value:result, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot();
  const query = await api.decompile(snapshot, 'function');
  assert.equal(query.snapshotId, snapshot.snapshotId);
  assert.deepEqual(query.value.renderProvenance.transformReverse['row:2'], [0]);
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', 0x1008n);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities, []);
  assert.equal(selected.transforms[0].rule, 'add-zero-right');
  assert.equal((await navigation.openAddress(0x1008n, () => assert.fail('history is not rendered navigation authority'))).reason, 'address-not-in-selection');
  assert.equal(validateRenderProvenance(query.value.renderProvenance, { snapshotId:'stale' }).state, 'incomplete');
});

test('C4-03 history origin truncation cannot certify an absent replacement origin as elided', () => {
  const map = project(identityRewrite().rewritten, { renderProvenanceBudget:{ maxOriginsPerEntity:2 } }).renderProvenance;
  const history = map.ledger[0].originHistory;
  assert.equal(history.consumedRefs.length, 2);
  assert.equal(history.producedRefs.length, 2);
  assert.deepEqual(history.elidedRefs, []);
  assert.equal(history.completeness, 'incomplete');
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.budget.truncatedScopes.includes('expression-history-origins'));
});

test('C4-03 history and final projection share one ledger budget and chronology', () => {
  const rewritten = identityRewrite().rewritten;
  const result = resultWith(rewritten.root);
  result.rewriteProof = [...rewritten.proof, ...rewritten.proof, ...rewritten.proof];
  result.phase8Projection = { transforms:[{ kind:'later', proof:'fixture', targets:['row:1'], origin:{ rows:[1] } }] };
  result.lines = [{ kind:'stmt', text:'return a1;', source:source(1, 1) }];
  const map = buildRenderProvenance({ result, snapshotId:'current', budget:{ maxTransformRecords:2 } });
  assert.equal(map.ledger.length, 2);
  assert.equal(map.transformCount, 4);
  assert.equal(map.counts.ledgerTruncated, 2);
  assert.ok(map.ledger.every(record => record.kind === 'expression-rewrite'));
  assert.equal(map.completeness, 'incomplete');
});

test('C4-03 a historical proof without origin snapshots remains explicitly unavailable', () => {
  const rewritten = identityRewrite().rewritten;
  delete rewritten.proof[0].originHistory;
  const map = project(rewritten).renderProvenance;
  assert.equal(map.counts.unavailableExpressionHistory, 1);
  assert.ok(map.reasons.includes('missing-expression-history'));
  assert.equal(map.completeness, 'incomplete');
  assert.equal(map.ledger.length, 0);
  assert.equal(map.counts.ledgerTruncated, 0, 'missing evidence is not a budget truncation');
});

test('C4-03 cancellation withholds expression history and both reverse indexes together', () => {
  const result = resultWith(identityRewrite().rewritten.root);
  result.rewriteProof = identityRewrite().rewritten.proof;
  result.lines = [];
  let checks = 0;
  const map = buildRenderProvenance({ result, snapshotId:'current', shouldAbort:() => ++checks > 1 });
  assert.deepEqual(map.ledger, []);
  assert.deepEqual(map.reverse, {});
  assert.deepEqual(map.transformReverse, {});
  assert.deepEqual(map.reasons, ['cancelled']);
});

test('C4-03 inconsistent or malformed history is rejected before UI consumption', () => {
  const original = project(identityRewrite().rewritten).renderProvenance;
  for (const changes of [
    { elidedRefs:['row:1'] },
    { consumedRefs:'row:1' },
    { producedRefs:[{}] },
    { elidedRefs:['row:2', 'row:2'] },
    { scope:'canonical-ir-deletion' },
  ]) {
    const map = structuredClone(original);
    Object.assign(map.ledger[0].originHistory, changes);
    assert.equal(validateRenderProvenance(map).state, 'incomplete');
  }
});

test('C4-03 producer bounds each retained source snapshot without changing the rewrite', () => {
  const { root, value } = identityRewrite();
  const rewritten = rewrite(root, DEFAULT_RULES, { maxHistoryOrigins:2 });
  assert.equal(rewritten.root, value);
  const history = rewritten.proof[0].originHistory;
  assert.equal(history.truncated, true);
  for (const state of [history.before, history.after]) {
    assert.equal(Object.values(state).reduce((count, values) => count + values.length, 0), 2);
  }
  const map = project(rewritten).renderProvenance;
  assert.equal(map.ledger[0].originHistory.completeness, 'incomplete');
  assert.deepEqual(map.ledger[0].originHistory.elidedRefs, [], 'producer truncation must not become a complete deletion claim');
  assert.equal(map.completeness, 'incomplete');
});
