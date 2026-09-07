import assert from 'node:assert/strict';
import test from 'node:test';
import { functionPaths } from '../../js/query/causal.js';

function programFor(edges, complete = true) {
  const queried = [];
  return {
    queried,
    graphCompleteness: { callsComplete: complete },
    functionRange(start) { return { start, end: start + 1n }; },
    calleesOf(start, end, limit) {
      assert.equal(end, start + 1n);
      assert.equal(limit, 201);
      queried.push(start);
      return edges.get(start) ?? [];
    },
  };
}
function chain(hops) {
  return programFor(new Map(Array.from({ length: hops }, (_, i) => [BigInt(i), [BigInt(i + 1)]])));
}

for (const hops of [1, 2, 6, 12]) {
  test(`maxDepth ${hops} reaches exactly ${hops} call edges`, () => {
    const program = chain(hops);
    const result = functionPaths(program, 0n, BigInt(hops), { maxDepth: hops });
    assert.deepEqual(result.paths, [Array.from({ length: hops + 1 }, (_, i) => BigInt(i))]);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.visited, hops + 1);
    assert.equal(program.queried.length, hops);
  });
  test(`maxDepth ${hops} does not expand beyond its edge budget`, () => {
    const program = chain(hops + 1);
    const result = functionPaths(program, 0n, BigInt(hops + 1), { maxDepth: hops });
    assert.deepEqual(result.paths, []);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.reasons, ['depth-limit']);
    assert.equal(result.visited, hops + 1);
    assert.equal(program.queried.includes(BigInt(hops)), false);
  });
}

test('default, floor and maximum clamp apply to edge counts', () => {
  assert.equal(functionPaths(chain(6), 0n, 6n).paths.length, 1);
  assert.equal(functionPaths(chain(7), 0n, 7n).paths.length, 0);
  assert.equal(functionPaths(chain(2), 0n, 2n, { maxDepth: 2.9 }).paths.length, 1);
  assert.equal(functionPaths(chain(2), 0n, 2n, { maxDepth: 1.9 }).paths.length, 0);
  assert.equal(functionPaths(chain(12), 0n, 12n, { maxDepth: 100 }).paths.length, 1);
  assert.equal(functionPaths(chain(13), 0n, 13n, { maxDepth: 100 }).paths.length, 0);
});

test('same-function query is zero hops and performs no expansion', () => {
  const program = programFor(new Map());
  const result = functionPaths(program, 0n, 0n, { maxDepth: 1 });
  assert.deepEqual(result.paths, [[0n]]);
  assert.equal(result.complete, true);
  assert.equal(result.visited, 1);
  assert.deepEqual(program.queried, []);
});

test('cycles, mixed callee records and path-count limits remain bounded', () => {
  const graph = new Map([[0n, [{ addr: 1n }, 2n]], [1n, [0n, 3n]], [2n, [3n]]]);
  const all = functionPaths(programFor(graph), 0n, 3n, { maxDepth: 2 });
  assert.deepEqual(all.paths, [[0n, 1n, 3n], [0n, 2n, 3n]]);
  assert.equal(all.complete, true);
  const limited = functionPaths(programFor(graph), 0n, 3n, { maxDepth: 2, maxPaths: 1 });
  assert.deepEqual(limited.paths, [[0n, 1n, 3n]]);
  assert.deepEqual(limited.reasons, ['path-limit']);
});

test('visited, callee and source-completeness ceilings are not weakened', () => {
  const many = Array.from({ length: 201 }, (_, i) => BigInt(i + 1));
  const limited = functionPaths(programFor(new Map([[0n, many]])), 0n, 999n, { maxDepth: 2, maxVisited: 16 });
  assert.equal(limited.visited, 16);
  assert.equal(limited.complete, false);
  assert.ok(limited.reasons.includes('visited-limit'));
  assert.ok(limited.reasons.includes('callee-limit'));
  const partial = functionPaths(programFor(new Map([[0n, [1n]]]), false), 0n, 1n, { maxDepth: 1 });
  assert.deepEqual(partial.paths, [[0n, 1n]]);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.reasons, ['program-calls-incomplete']);
});
