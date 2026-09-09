import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const WIDTHS = Object.freeze([1,2,3,4,8,16,32,64]);
const b = E.createBinary, n = E.createUnary;
const FAMILY_IDS = Object.freeze([
  'xor-self','sub-self','and-self','or-self','add-zero','sub-zero','mul-one',
  'and-zero','mul-zero','and-mask','shl-zero','lshr-zero','ashr-zero',
  'double-add','double-not','double-neg','xor-cancel','add-sub-cancel',
  'absorb-and','absorb-or','mba-add','mul-power-two','factor-mul',
  'fold-wrap','fold-shift-last','fold-shift-width','fold-ashr-width',
  'trunc-zext','trunc-sext','select-same','select-constant',
  'compare-constant','concat-constant','extract-constant',
]);

// These are measured, explicitly incomplete proof cells, not waived semantic
// successes. Keep all other cells as mandatory positive capability floors. If a
// backend later proves one of these, its genuine receipt still faces the oracle.
function boundedProofCell(family,width) {
  return width >= (['xor-cancel','add-sub-cancel','mba-add'].includes(family) ? 8 : 16)
    && ['double-neg','xor-cancel','add-sub-cancel','absorb-and','absorb-or','mba-add','factor-mul'].includes(family);
}

function assertWithheld(r,id) {
  assert.equal(r.status,'partial',id);
  assert.match(r.reason,/^(cancelled|timeout|deadline-exceeded|budget:.*)$/,`${id}:${r.reason}`);
  assert.deepEqual(r.candidates,[],id);
}

function fixture(family,width) {
  const x = E.createFreshSymbol(E.bvSort(width),`${family}_${width}_x`);
  const y = E.createFreshSymbol(E.bvSort(width),`${family}_${width}_y`);
  const c = value => E.createBv(width,BigInt(value));
  const mask = (1n << BigInt(width)) - 1n;
  const mba = () => b('add',b('xor',x,y),b('shl',b('and',x,y),c(1)));
  const cases = {
    'xor-self': [() => b('xor',x,x),() => 0n],
    'sub-self': [() => b('sub',x,x),() => 0n],
    'and-self': [() => b('and',x,x),a => a],
    'or-self': [() => b('or',x,x),a => a],
    'add-zero': [() => b('add',x,c(0)),a => a],
    'sub-zero': [() => b('sub',x,c(0)),a => a],
    'mul-one': [() => b('mul',x,c(1)),a => a],
    'and-zero': [() => b('and',x,c(0)),() => 0n],
    'mul-zero': [() => b('mul',x,c(0)),() => 0n],
    'and-mask': [() => b('and',x,c(mask)),a => a],
    'shl-zero': [() => b('shl',x,c(0)),a => a],
    'lshr-zero': [() => b('lshr',x,c(0)),a => a],
    'ashr-zero': [() => b('ashr',x,c(0)),a => a],
    'double-add': [() => b('add',x,x),a => (a + a) & mask],
    'double-not': [() => n('not',n('not',x)),a => a],
    'double-neg': [() => n('neg',n('neg',x)),a => a],
    'xor-cancel': [() => b('xor',b('xor',x,y),y),a => a],
    'add-sub-cancel': [() => b('sub',b('add',x,y),y),a => a],
    'absorb-and': [() => b('and',x,b('or',x,y)),a => a],
    'absorb-or': [() => b('or',x,b('and',x,y)),a => a],
    'mba-add': [mba,(a,d) => (a + d) & mask],
    'mul-power-two': [() => b('mul',x,c(2)),a => (a * 2n) & mask],
    'factor-mul': [() => b('add',b('mul',x,c(3)),b('mul',x,c(5))),a => (a * 8n) & mask],
    'fold-wrap': [() => b('add',c(mask),c(1)),() => 0n],
    'fold-shift-last': [() => b('shl',c(1),c(width - 1)),() => 1n << BigInt(width - 1)],
    'fold-shift-width': [() => b('shl',c(1),c(width)),() => 0n],
    'fold-ashr-width': [() => b('ashr',c(mask),c(width)),() => mask],
    'trunc-zext': [() => E.createCast('trunc',E.createCast('zext',x,width + 1),width),a => a],
    'trunc-sext': [() => E.createCast('trunc',E.createCast('sext',x,width + 1),width),a => a],
    'select-same': [() => E.createIte(E.createCompare('ult',x,y),x,x),a => a],
    'select-constant': [() => E.createIte(E.createBool(false),y,x),a => a],
    'compare-constant': [() => E.createCompare('slt',c(mask),c(0)),() => true],
    'concat-constant': [() => E.createConcat(c(mask),E.createBv(1,1n)),() => (mask << 1n) | 1n],
    'extract-constant': [() => E.createExtract(c(mask),width - 1,width - 1),() => 1n],
  };
  assert.deepEqual(Object.keys(cases),FAMILY_IDS,'new families must enter the frozen denominator');
  const [build,expected] = cases[family];
  return {before:build(),expected,x,y,width,family,id:`${family}/bv${width}`};
}

function query(f,options = {}) {
  return queryEqualitySaturation({expression:f.before,valueId:f.id,identity,
    memoryObservables:[],effectObservables:[],timeoutMs:2000,backendTier:'tiered',...options});
}

function values(width) {
  if (width <= 4) return Array.from({length:2 ** width},(_,i) => BigInt(i));
  const sign = 1n << BigInt(width - 1), mask = (sign << 1n) - 1n;
  return [...new Set([0n,1n,2n,sign - 1n,sign,sign + 1n,mask - 1n,mask,0x5555555555555555n & mask,0xaaaaaaaaaaaaaaaan & mask])];
}

function checkConcrete(f,after) {
  let comparisons = 0;
  for (const a of values(f.width)) for (const d of values(f.width)) {
    const env = new Map([[f.x.symbolId,a],[f.y.symbolId,d]]), expected = f.expected(a,d);
    for (const term of [f.before,after]) {
      const actual = E.evaluateExpr(term,env);
      assert.equal(actual.status,E.EVAL_STATUS.VALUE,f.id);
      assert.equal(actual.value,expected,`${f.id}/${a}/${d}`);
    }
    comparisons++;
  }
  return comparisons;
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
  if (process.env.HEX_EGRAPH_MATRIX_REPORT) {
    const destination = path.resolve(process.env.HEX_EGRAPH_MATRIX_REPORT);
    const parent = fs.realpathSync(path.dirname(destination));
    assert.ok(!['/tmp','/var/tmp','/dev/shm'].some(root => parent === root || parent.startsWith(`${root}/`)));
    const pending = `${destination}.pending`;
    assert.ok(!fs.existsSync(destination));
    const fd = fs.openSync(pending,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(pending,destination);
  }
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
  const p = E.createFreshSymbol(E.boolSort(),'matrix_bool_p'), q = E.createFreshSymbol(E.boolSort(),'matrix_bool_q');
  const c = E.createConnective, yes = E.createBool(true), no = E.createBool(false);
  const cases = [
    ['double-not',c('not',c('not',p)),a => a],
    ['and-self',c('and',p,p),a => a], ['or-self',c('or',p,p),a => a],
    ['xor-self',c('xor',p,p),() => false], ['ne-self',c('ne',p,p),() => false],
    ['eq-self',c('eq',p,p),() => true], ['implies-self',c('implies',p,p),() => true],
    ['and-complement',c('and',p,c('not',p)),() => false],
    ['or-complement',c('or',p,c('not',p)),() => true],
    ['and-true',c('and',p,yes),a => a], ['or-false',c('or',no,p),a => a],
    ['and-false',c('and',no,p),() => false], ['or-true',c('or',p,yes),() => true],
    ['select-same',E.createIte(q,p,p),a => a],
  ];
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
