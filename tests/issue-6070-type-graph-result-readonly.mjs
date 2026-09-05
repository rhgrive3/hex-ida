import assert from 'node:assert/strict';
import { TypeConstraintGraph, createTypeGraphResult } from '../js/analysis/types/graph.js';
import { createHardConstraint } from '../js/analysis/types/constraints.js';

const status = { completeness: 'complete' };

// 1. instance mutators are rejected
{
  const result = createTypeGraphResult({
    snapshotId: 's',
    results: new Map([['A', { value: 1 }]]),
    components: [],
    recursiveComponents: [],
    iterations: 0,
    status,
  });
  assert.throws(() => result.results.set('B', { value: 2 }), /read-only/);
  assert.throws(() => result.results.delete('A'), /read-only/);
  assert.throws(() => result.results.clear(), /read-only/);
}

// 2-3. prototype mutators cannot change published content
{
  const result = createTypeGraphResult({
    snapshotId: 's',
    results: new Map([['A', { value: 1 }]]),
    components: [],
    recursiveComponents: [],
    iterations: 0,
    status,
  });
  assert.throws(() => Map.prototype.set.call(result.results, 'B', { value: 2 }), /incompatible receiver|read-only/i);
  assert.throws(() => Map.prototype.delete.call(result.results, 'A'), /incompatible receiver|read-only/i);
  assert.throws(() => Map.prototype.clear.call(result.results), /incompatible receiver|read-only/i);
  assert.equal(result.results.get('B'), undefined);
  assert.deepEqual(result.results.get('A'), { value: 1 });
  assert.equal(result.results.size, 1);
}

// 4. read API is preserved
{
  const result = createTypeGraphResult({
    snapshotId: 's',
    results: new Map([['A', { value: 1 }], ['B', { value: 2 }]]),
    components: [],
    recursiveComponents: [],
    iterations: 0,
    status,
  });
  assert.equal(result.results.get('A').value, 1);
  assert.equal(result.results.has('B'), true);
  assert.equal(result.results.size, 2);
  assert.deepEqual([...result.results.keys()].sort(), ['A', 'B']);
  assert.deepEqual([...result.results.values()].map((v) => v.value).sort(), [1, 2]);
  assert.equal([...result.results.entries()].length, 2);
  assert.equal([...result.results].length, 2);
  let visited = 0;
  result.results.forEach(() => { visited += 1; });
  assert.equal(visited, 2);
}

// 5. solveGraph published entries stay immutable
{
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  graph.addHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: {
      layer: 'structural', entityId: 'E',
      descriptor: { offset: 0, sizeBytes: 8, memberType: { kind: 'pointer', targetEntityId: 'F' } },
    },
  });
  const solved = graph.solveGraph({ roots: ['E'] });
  const before = solved.results.get('E');
  assert.ok(before);
  assert.throws(() => Map.prototype.set.call(solved.results, 'FORGED', before), /incompatible receiver|read-only/i);
  assert.equal(solved.results.has('FORGED'), false);
  assert.equal(solved.results.get('E'), before);
}

console.log('issue #6070 TypeGraphResult.results read-only: PASS');
