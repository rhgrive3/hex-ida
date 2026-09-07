import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeobfuscationCandidate, expr as E } from '../../../js/symbolic/index.js';
import { identity } from './fixtures.mjs';
test('direct proof API rejects a contextual path snapshot instead of certifying it as global pure proof', async () => {
  const x=E.createFreshSymbol(E.bvSort(3),'path-context-x');
  const r=await verifyDeobfuscationCandidate({candidateId:'c',beforeValueId:'b',afterValueId:'a',identity,
    before:E.createBinary('xor',x,x),after:E.createBv(3,0),memoryObservables:[],effectObservables:[],
    executionSnapshot:{pathIndex:0}});
  assert.equal(r.eligible,false);
  assert.equal(r.reason,'execution-path-proof-handoff');
});
