import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../js/symbolic/expr/index.js';
import { queryEqualitySaturation } from '../../../js/symbolic/query/equality-saturation.js';
import { verifyDeobfuscationCandidate, isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { EGRAPH_LIMITS, saturatePureExpression } from '../../../js/symbolic/egraph/graph.js';
import { createQueryGuard } from '../../../js/symbolic/memory/query-state.js';
import { identity } from '../taint/fixtures.mjs';

// An explicit Cartesian denominator, not a sample selected from successful
// extractions. Family expectations are direct integer formulas, independent of
// the candidate rules. This is synthetic scalar evidence, not compiler/device
// coverage or a theorem about every legacy representation rewrite.
import { WIDTHS, FAMILY_IDS, fixture, boundedProofCell, assertWithheld, checkConcrete, publishMatrixReport, boolFixtures } from '../helpers/egraph-family-fixtures.mjs';
const b = E.createBinary;


function query(f,options = {}) {
  return queryEqualitySaturation({expression:f.before,valueId:f.id,identity,
    memoryObservables:[],effectObservables:[],timeoutMs:2000,backendTier:'tiered',...options});
}


test('C4-05 frozen scalar family x width denominator checks every extracted proof and independent formula',async t => {
  assert.equal(FAMILY_IDS.length,34);
  assert.equal(new Set(FAMILY_IDS).size,34);
  const rows = [], ids = new Set();
  let comparisons = 0;
  for (const family of FAMILY_IDS) for (const width of WIDTHS) {
    const f = fixture(family,width), r = await query(f);
    assert.ok(!ids.has(f.id)); ids.add(f.id);
    const row = {id:f.id,status:r.status,reason:r.reason,eligible:r.candidates.filter(c => c.eligible).length,
      disposition:r.status !== 'complete' ? 'unknown-withheld' : r.candidates.length ? 'proved-candidate' : 'unchanged-no-candidate',
      beforeHash:E.computeStructuralHash(f.before),rules:r.rules,metrics:r.metrics,
      candidates:r.candidates.map(c => ({candidateId:c.candidateId,eligible:c.eligible,
        afterHash:E.computeStructuralHash(c.after),cost:c.cost,verdict:c.verification.verdict,
        queryHash:c.verification.evidence?.queryHash,reason:c.verification.reason}))};
    rows.push(row);
    comparisons += checkConcrete(f,f.before);
    for (const [counter,ceiling] of Object.entries(EGRAPH_LIMITS)) {
      if (typeof r.metrics[counter] === 'number') assert.ok(r.metrics[counter] <= ceiling,`${f.id}:${counter}`);
    }
    // BV65 is deliberately in the denominator: proving the truncated result
    // does not authorize silently dropping an unsupported intermediate width.
    const unsupported = width === 64 && ['trunc-zext','trunc-sext','concat-constant'].includes(family);
    if (unsupported) {
      assert.equal(r.status,'partial',f.id);
      assert.match(r.reason,/unsupported-width/,f.id);
      assert.deepEqual(r.candidates,[]);
      row.disposition = 'unsupported-withheld';
      continue;
    }
    if (boundedProofCell(family,width) && r.status !== 'complete') {
      assertWithheld(r,f.id);
      continue;
    }
    assert.equal(r.status,'complete',`${f.id}:${r.reason}`);
    // Add and shift have equal extraction costs: retaining the original is a
    // legitimate hash tie-break, but it must not be counted as a proved rewrite.
    if (family === 'double-add' && !r.candidates.length) {
      assert.equal(r.metrics.verificationQueries,0,f.id);
      assert.ok(r.rules.includes('double-add'),f.id);
      continue;
    }
    assert.ok(r.candidates.length > 0,`${f.id}:missing candidate`);
    for (const candidate of r.candidates) {
      assert.equal(candidate.eligible,true,`${f.id}:${candidate.verification.reason}`);
      assert.equal(isAdoptableCandidate(candidate.verification,{identity,before:f.before,after:candidate.after}),true,f.id);
      assert.equal(isAdoptableCandidate({...candidate.verification}),false);
      assert.equal(candidate.verification.evidence.verdict,'proved');
      comparisons += checkConcrete(f,candidate.after);
    }
  }
  assert.equal(rows.length,272);
  assert.equal(ids.size,272);
  assert.equal(rows.filter(row => row.disposition === 'unsupported-withheld').length,3);
  assert.ok(rows.filter(row => row.eligible > 0).length >= 237,'mandatory positive capability floor');
  const report = {denominator:'c4-05-scalar-families-v1',scope:'synthetic-candidate-coverage-not-render-adoption',
    widths:WIDTHS,families:FAMILY_IDS,cells:rows.length,comparisons,
    exhaustiveWidths:WIDTHS.filter(width => width <= 4),nativeSampling:'boundary-cross-product',
    completeProofCoverage:rows.every(row => row.status === 'complete'),rows};
  // Optional retained evidence is published only after every assertion passes.
  // The exact-head runner supplies a new path; never overwrite an old receipt.
  publishMatrixReport(report,process.env.HEX_EGRAPH_MATRIX_REPORT);
  t.diagnostic(JSON.stringify({denominator:report.denominator,cells:rows.length,comparisons,
    completeProofCoverage:report.completeProofCoverage,
    dispositions:Object.fromEntries([...new Set(rows.map(r => r.disposition))].map(d => [d,rows.filter(r => r.disposition === d).length]))}));
});

test('C4-05 near-MBA counterexamples remain refuted at every frozen width',async () => {
  for (const width of WIDTHS) {
    const f = fixture('mba-add',width);
    const after = b('add',b('add',f.x,f.y),E.createBv(width,1n));
    const result = await verifyDeobfuscationCandidate({before:f.before,after,identity,
      candidateId:`wrong:${f.id}`,beforeValueId:f.id,afterValueId:`wrong:${f.id}`,
      memoryObservables:[],effectObservables:[],timeoutMs:2000,backendTier:'tiered'});
    assert.equal(result.verdict,'refuted',`${f.id}:${result.reason}`);
    assert.equal(result.eligible,false);
    assert.equal(isAdoptableCandidate(result),false);
    assert.ok(result.counterexample,f.id);
  }
});

test('C4-05 Bool families remain distinct from BV1 and every extracted result has independent proof',async () => {
  const {p,q,cases} = boolFixtures();
  assert.equal(cases.length,14);
  for (const [id,before,expected] of cases) {
    const r = await query({id:`bool/${id}`,before});
    assert.equal(r.status,'complete',`${id}:${r.reason}`);
    assert.ok(r.candidates.length > 0,id);
    for (const candidate of r.candidates) {
      assert.equal(candidate.after.sort.kind,'bool');
      assert.equal(isAdoptableCandidate(candidate.verification,{identity,before,after:candidate.after}),true,id);
      for (const a of [false,true]) for (const d of [false,true]) {
        const env = new Map([[p.symbolId,a],[q.symbolId,d]]);
        for (const term of [before,candidate.after]) {
          const value = E.evaluateExpr(term,env);
          assert.equal(value.status,E.EVAL_STATUS.VALUE,id);
          assert.equal(value.value,expected(a,d),id);
        }
      }
    }
  }
});

test('C4-05 every frozen family and width refuses publication when the enclosing batch has no work budget',async () => {
  let rows = 0;
  for (const family of FAMILY_IDS) for (const width of WIDTHS) {
    const f = fixture(family,width), r = await query(f,{limits:{workItems:0}});
    assert.equal(r.status,'partial',f.id);
    assert.match(r.reason,/budget:workItems/,f.id);
    assert.deepEqual(r.candidates,[],f.id);
    rows++;
  }
  assert.equal(rows,272);
});

test('C4-05 discovery/association metamorphism and replay retain the same extracted cancellation at every width',async () => {
  for (const width of WIDTHS) {
    const f = fixture('xor-cancel',width), {x,y} = f;
    const variants = [f.before,b('xor',y,b('xor',y,x)),b('xor',b('xor',y,x),y)];
    const expectedHash = E.computeStructuralHash(x);
    for (const before of variants) {
      // Search determinism is tested independently of proof availability. A
      // bounded solver refusal must not be misreported as a search failure or
      // permission to adopt the e-class representative without proof.
      const search = saturatePureExpression(before,createQueryGuard({identity,timeoutMs:2000},EGRAPH_LIMITS));
      assert.ok(search.choices.some(c => c.digest === expectedHash),f.id);
      const first = await query({...f,before}), replay = await query({...f,before});
      if (width >= 8 && (first.status !== 'complete' || replay.status !== 'complete')) {
        for (const r of [first,replay]) {
          if (r.status !== 'complete') assertWithheld(r,f.id);
          else for (const c of r.candidates) assert.equal(isAdoptableCandidate(c.verification,{identity}),true);
        }
        continue;
      }
      assert.equal(first.status,'complete',`${f.id}:${first.reason}`);
      assert.equal(replay.status,'complete',`${f.id}:${replay.reason}`);
      assert.deepEqual(first.candidates.map(c => c.candidateId),replay.candidates.map(c => c.candidateId));
      assert.ok(first.candidates.some(c => c.eligible && E.computeStructuralHash(c.after) === expectedHash),f.id);
      for (const candidate of first.candidates) assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
    }
  }
});
