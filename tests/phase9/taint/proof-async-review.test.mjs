import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeobfuscationCandidate, isAdoptableCandidate, expr as E } from '../../../js/symbolic/index.js';
import { identity } from './fixtures.mjs';
const request = (before, after, extra = {}) => ({ candidateId: 'async-scope', beforeValueId: 'before', afterValueId: 'after',
  before, after, identity, memoryObservables: [], effectObservables: [], ...extra });

test('mutating preconditions during await cannot turn conditional proof into unconditional', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'async-condition'), zero = E.createBv(3, 0n);
  const condition = E.createCompare('eq', x, zero), preconditions = [condition];
  const pending = verifyDeobfuscationCandidate(request(x, zero, { preconditions }));
  preconditions.length = 0;
  const result = await pending;
  assert.equal(result.eligible, true, result.reason);
  assert.equal(isAdoptableCandidate(result), false);
  assert.equal(isAdoptableCandidate(result, { preconditions: [condition] }), true);
});

test('proof receipt retains original cancellation signal despite request mutation during await', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'async-signal');
  const original = new AbortController(), replacement = new AbortController();
  const candidate = request(E.createBinary('xor', x, x), E.createBv(3, 0n), { signal: original.signal });
  const pending = verifyDeobfuscationCandidate(candidate);
  candidate.signal = replacement.signal;
  const result = await pending;
  assert.equal(result.eligible, true, result.reason);
  original.abort();
  assert.equal(isAdoptableCandidate(result), false);
});

test('proof receipt retains original freshness observer despite request mutation during await', async () => {
  const x = E.createFreshSymbol(E.bvSort(3), 'async-freshness');
  let current = identity;
  const candidate = request(E.createBinary('xor', x, x), E.createBv(3, 0n), { getCurrentIdentity: () => current });
  const pending = verifyDeobfuscationCandidate(candidate);
  candidate.getCurrentIdentity = () => identity;
  const result = await pending;
  assert.equal(result.eligible, true, result.reason);
  current = { ...identity, snapshotId: 'superseded' };
  assert.equal(isAdoptableCandidate(result), false);
});

test('a multi-candidate query retains the original observer for every receipt', async () => {
  const { queryDeobfuscationCandidates } = await import('../../../js/symbolic/index.js');
  const x=E.createFreshSymbol(E.bvSort(3),'batch-observer');let current=identity;
  const options={expression:E.createBinary('add',E.createBinary('xor',x,x),E.createBv(3,0n)),valueId:'batch',identity,
    memoryObservables:[],effectObservables:[],getCurrentIdentity:()=>current};
  const pending=queryDeobfuscationCandidates(options);options.getCurrentIdentity=()=>identity;
  const result=await pending;assert.equal(result.status,'complete',result.reason);assert.ok(result.candidates.length>=2);
  assert.ok(result.candidates.every(c=>c.eligible));current={...identity,snapshotId:'stale-after-batch'};
  assert.ok(result.candidates.every(c=>!isAdoptableCandidate(c.verification)));
});
test('a multi-candidate query retains the submitted preconditions for every receipt', async () => {
  const { queryDeobfuscationCandidates } = await import('../../../js/symbolic/index.js');
  const x=E.createFreshSymbol(E.bvSort(3),'batch-condition'),condition=E.createCompare('eq',x,E.createBv(3,0n));
  const preconditions=[condition];
  const pending=queryDeobfuscationCandidates({expression:E.createBinary('add',E.createBinary('xor',x,x),E.createBv(3,0n)),valueId:'batch',identity,
    memoryObservables:[],effectObservables:[],preconditions});
  preconditions.length=0;const result=await pending;
  assert.equal(result.status,'complete',result.reason);assert.ok(result.candidates.length>=2);
  assert.ok(result.candidates.every(c=>c.eligible));
  assert.ok(result.candidates.every(c=>!isAdoptableCandidate(c.verification)));
  assert.ok(result.candidates.every(c=>isAdoptableCandidate(c.verification,{preconditions:[condition]})));
});
test('malformed correspondence returns no adoption rather than leaking a TypeError',async()=>{
  const x=E.createFreshSymbol(E.bvSort(3),'invalid-correspondence');
  for(const pair of [null,undefined,{},false]) {
    const result=await verifyDeobfuscationCandidate(request(x,x,{correspondence:{inputs:[pair]}}));
    assert.equal(result.eligible,false);assert.equal(result.reason,'invalid-input-correspondence');
  }
});
