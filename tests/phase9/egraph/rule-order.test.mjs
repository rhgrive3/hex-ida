import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../js/symbolic/expr/index.js';
import { queryEqualitySaturation } from '../../../js/symbolic/query/equality-saturation.js';
import { querySymbolicAnalysis } from '../../../js/symbolic/query/analysis.js';
import { isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { EGRAPH_RULE_ORDERS, EGRAPH_LIMITS, orderEqualityProposals, saturatePureExpression } from '../../../js/symbolic/egraph/graph.js';
import { createQueryGuard } from '../../../js/symbolic/memory/query-state.js';
import { WIDTHS, FAMILY_IDS, fixture, boundedProofCell, assertWithheld, checkConcrete, publishMatrixReport, boolFixtures } from '../helpers/egraph-family-fixtures.mjs';
import { identity, scalarFixture } from '../taint/fixtures.mjs';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';

const unsupported = f => f.width === 64 && ['trunc-zext','trunc-sext','concat-constant'].includes(f.family);
const run = (f,ruleOrder,extra = {}) => queryEqualitySaturation({expression:f.before,valueId:f.id,identity,
  memoryObservables:[],effectObservables:[],timeoutMs:2000,backendTier:'tiered',ruleOrder,...extra});
const guard = () => createQueryGuard({identity,timeoutMs:2000},EGRAPH_LIMITS);
const choices = search => search.choices.map(c => ({digest:c.digest,cost:c.cost}));

test('C4-05 rule scheduling actually permutes the same completed proposal batch with no callbacks or changed default cost',() => {
  assert.deepEqual(EGRAPH_RULE_ORDERS,['canonical','reverse','discovery']);
  assert.ok(Object.isFrozen(EGRAPH_RULE_ORDERS));
  const proposals = [{rule:'a',owner:2,after:{}},{rule:'z',owner:3,after:{}},{rule:'a',owner:1,after:{}}];
  const expected = {canonical:[2,0,1],reverse:[1,0,2],discovery:[0,1,2]};
  for (const order of EGRAPH_RULE_ORDERS) {
    const pending = [...proposals], g = guard();
    assert.equal(orderEqualityProposals(pending,g,order),pending);
    assert.deepEqual(pending.map(p => proposals.indexOf(p)),expected[order]);
    assert.equal(g.metrics().workItems,6);
    assert.equal(new Set(pending).size,proposals.length);
  }
  const pending = [...proposals];
  orderEqualityProposals(pending,guard());
  assert.deepEqual(pending.map(p => proposals.indexOf(p)),expected.canonical);
  let reads = 0;
  const invalid = {toString() {reads++;return 'canonical';}};
  assert.throws(() => orderEqualityProposals([...proposals],guard(),invalid),/invalid-egraph-rule-order/);
  assert.equal(reads,0);
});

test('C4-05 all 272 frozen scalar cells retain their bounded Pareto extraction under three actual rule schedules',async t => {
  let searches = 0, refused = 0;
  for (const family of FAMILY_IDS) for (const width of WIDTHS) {
    const f = fixture(family,width);
    if (unsupported(f)) {
      for (const order of EGRAPH_RULE_ORDERS) {
        const r = await run(f,order);
        assert.equal(r.status,'partial',f.id);assert.equal(r.reason,'unsupported-width');
        assert.deepEqual(r.candidates,[]);refused++;
      }
      continue;
    }
    const baseline = saturatePureExpression(f.before,guard());
    for (const order of EGRAPH_RULE_ORDERS) {
      const search = saturatePureExpression(f.before,guard(),order);
      assert.equal(search.ruleOrder,order);
      assert.equal(search.saturated,true);
      assert.deepEqual(choices(search),choices(baseline),`${f.id}/${order}`);
      searches++;
    }
  }
  assert.equal(searches,807);assert.equal(refused,9);
  t.diagnostic(JSON.stringify({denominator:'c4-05-rule-order-v1',families:34,widths:8,orders:3,searches,refused}));
});

test('C4-05 every schedule independently verifies its candidates over the full frozen scalar denominator',async t => {
  const rows = [];
  let cells = 0, proofs = 0, unchanged = 0, withheld = 0, comparisons = 0;
  for (const family of FAMILY_IDS) for (const width of WIDTHS) {
    const f = fixture(family,width);
    for (const order of EGRAPH_RULE_ORDERS) {
      const r = await run(f,order);cells++;
      rows.push({id:`${f.id}/${order}`,ruleOrder:order,status:r.status,reason:r.reason,
        disposition:r.status !== 'complete' ? 'unknown-withheld' : r.candidates.length ? 'proved-candidate' : 'unchanged-no-candidate',
        beforeHash:E.computeStructuralHash(f.before),metrics:r.metrics,rules:r.rules,
        candidates:r.candidates.map(c => ({candidateId:c.candidateId,ruleOrder:c.ruleOrder,eligible:c.eligible,
          afterHash:E.computeStructuralHash(c.after),queryHash:c.verification.evidence?.queryHash,
          verdict:c.verification.verdict,cost:c.cost}))});
      assert.equal(r.ruleOrder,order);
      if (unsupported(f)) {
        assert.equal(r.status,'partial');assert.equal(r.reason,'unsupported-width');
        assert.deepEqual(r.candidates,[]);withheld++;continue;
      }
      if (boundedProofCell(family,width) && r.status !== 'complete') {
        assertWithheld(r,`${f.id}/${order}`);withheld++;continue;
      }
      assert.equal(r.status,'complete',`${f.id}/${order}:${r.reason}`);
      if (family === 'double-add' && !r.candidates.length) {unchanged++;continue;}
      assert.ok(r.candidates.length,`${f.id}/${order}:missing candidate`);
      for (const candidate of r.candidates) {
        assert.equal(candidate.ruleOrder,order);
        assert.equal(candidate.eligible,true,`${f.id}/${order}:${candidate.verification.reason}`);
        assert.equal(isAdoptableCandidate(candidate.verification,{identity,before:f.before,after:candidate.after}),true);
        assert.equal(isAdoptableCandidate({...candidate.verification}),false);
        assert.ok(candidate.verification.evidence.queryHash);
        comparisons += checkConcrete(f,candidate.after);proofs++;
      }
    }
  }
  assert.equal(cells,816);assert.ok(proofs>=711);
  assert.equal(new Set(rows.map(row=>row.id)).size,816);
  publishMatrixReport({denominator:'c4-05-rule-order-v1',scope:'candidate-proof-not-render-adoption',
    widths:WIDTHS,families:FAMILY_IDS,orders:EGRAPH_RULE_ORDERS,cells,proofs,unchanged,withheld,comparisons,
    completeProofCoverage:rows.every(row=>row.status==='complete'),rows},process.env.HEX_EGRAPH_RULE_ORDER_REPORT);
  t.diagnostic(JSON.stringify({denominator:'c4-05-rule-order-v1',cells,proofs,unchanged,withheld,comparisons,
    scope:'candidate-proof-not-render-adoption'}));
});

test('C4-05 all 14 Bool families retain their extracted meaning and actual receipts across all schedules',async () => {
  const {p,q,cases} = boolFixtures();
  assert.equal(cases.length,14);
  for (const [id,before,expected] of cases) {
    const baseline = choices(saturatePureExpression(before,guard()));
    for (const order of EGRAPH_RULE_ORDERS) {
      assert.deepEqual(choices(saturatePureExpression(before,guard(),order)),baseline,`${id}/${order}`);
      const r = await run({id:`bool/${id}`,before},order);
      assert.equal(r.status,'complete',`${id}/${order}:${r.reason}`);
      assert.ok(r.candidates.length);
      for (const candidate of r.candidates) {
        assert.equal(candidate.after.sort.kind,'bool');assert.equal(candidate.ruleOrder,order);
        assert.equal(isAdoptableCandidate(candidate.verification,{identity,before,after:candidate.after}),true);
        for (const a of [false,true]) for (const d of [false,true]) {
          const actual = E.evaluateExpr(candidate.after,new Map([[p.symbolId,a],[q.symbolId,d]]));
          assert.equal(actual.status,E.EVAL_STATUS.VALUE);assert.equal(actual.value,expected(a,d));
        }
      }
    }
  }
});

test('C4-05 each schedule retains exact N-1/N/N+1 work/allocation bounds and deterministic replay',async () => {
  const f = fixture('factor-mul',4);
  for (const order of EGRAPH_RULE_ORDERS) {
    const baseline = await run(f,order), replay = await run(f,order);
    assert.equal(baseline.status,'complete',baseline.reason);assert.equal(replay.status,'complete',replay.reason);
    assert.deepEqual(baseline.candidates.map(c=>c.candidateId),replay.candidates.map(c=>c.candidateId));
    for (const counter of ['workItems','allocationUnits']) {
      const ceiling = baseline.metrics[counter];
      assert.ok(Number.isSafeInteger(ceiling) && ceiling > 0);
      for (const delta of [-1,0,1]) {
        const r = await run(f,order,{limits:{[counter]:ceiling+delta}});
        assert.equal(r.status,delta < 0 ? 'partial' : 'complete',`${order}/${counter}/${delta}:${r.reason}`);
        assert.ok(r.metrics[counter] <= ceiling+delta);
        if (delta < 0) assert.deepEqual(r.candidates,[]);
        else assert.ok(r.candidates.every(c=>isAdoptableCandidate(c.verification,{identity})));
      }
    }
  }
});

test('C4-05 rule order cannot inject code, change strategies silently, or publish after cancellation/budget/staleness',async () => {
  const f = fixture('xor-self',4);
  let reads = 0;
  for (const invalid of [null,'random',1,{},['reverse'],() => {reads++;}, {toString() {reads++;return 'reverse';}}]) {
    const r = await run(f,invalid);
    assert.equal(r.status,'partial');assert.equal(r.reason,'invalid-egraph-rule-order');
    assert.deepEqual(r.candidates,[]);
  }
  const options = {expression:f.before,valueId:f.id,identity,memoryObservables:[],effectObservables:[],
    get ruleOrder() {reads++;return 'reverse';}};
  const getter = await queryEqualitySaturation(options);
  assert.equal(getter.status,'partial');assert.deepEqual(getter.candidates,[]);assert.equal(reads,0);
  const models = createTaintModels({id:'order-invalid',version:'1',provenance:'test-fixture',sources:[],sinks:[]});
  for (const candidateStrategy of ['local-rewrites','translate-only']) {
    const ir = scalarFixture(), r = await querySymbolicAnalysis(ir,{identity,models,memory:{addressBits:8},
      targets:[ir.instructions[0].dst],candidateStrategy,ruleOrder:'reverse'});
    assert.equal(r.status,'partial');assert.equal(r.reason,'invalid-egraph-rule-order');assert.deepEqual(r.targets,[]);
  }
  for (const order of EGRAPH_RULE_ORDERS) {
    for (const extra of [{limits:{workItems:0}},{limits:{candidates:0}},{timeoutMs:0},
      {isCancelled:() => true},{getCurrentIdentity:() => ({...identity,snapshotId:'stale'})},{rules:[]}]) {
      const r = await run(f,order,extra);
      assert.equal(r.status,'partial',`${order}/${r.reason}`);assert.deepEqual(r.candidates,[]);
    }
  }
});

test('C4-05 schedule choice is snapshotted before the asynchronous verifier',async () => {
  const f = fixture('xor-self',4), options = {expression:f.before,valueId:f.id,identity,
    memoryObservables:[],effectObservables:[],timeoutMs:2000,ruleOrder:'reverse'};
  const pending = queryEqualitySaturation(options);options.ruleOrder = 'discovery';
  const r = await pending;
  assert.equal(r.status,'complete',r.reason);assert.equal(r.ruleOrder,'reverse');
  assert.ok(r.candidates.length);
  assert.ok(r.candidates.every(c => c.ruleOrder === 'reverse' && isAdoptableCandidate(c.verification)));
});
