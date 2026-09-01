import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor, OP } from '../../js/ir.js';
import { functionPaths, minimalCausalPath } from '../../js/query/causal.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: BASE + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const delta = addr - BASE;
    if (delta < 0n || delta >= BigInt(lines.length * 4)) return null;
    return Number(delta / 4n);
  };
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress,
  });
}

function programFromEdges(edges) {
  return {
    functionRange(start) {
      return { start, end: start + 1 };
    },
    calleesOf(start) {
      return (edges.get(start) || []).map((addr) => ({ addr }));
    },
  };
}

{
  const ir = irFor(modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'add w8, w8, #2',
    'add w8, w8, #3',
    'str w8, [x19, #0x20]',
    'ret',
  ]));
  const store = ir.instructions.find((inst) => inst.op === OP.STORE);
  assert.ok(store, 'fixture must contain a store seed');

  const numeric = minimalCausalPath(ir, store, { limit: 2 });
  assert.equal(numeric.nodes.length, 2, 'finite primitive number keeps existing clamp semantics');

  for (const invalid of [['2'], '2', true, { valueOf() { throw new Error('must not coerce'); } }]) {
    const result = minimalCausalPath(ir, store, { limit: invalid });
    assert.ok(result.nodes.length > 2, 'structured/non-number limit must use the default budget');
  }
}

{
  const program = programFromEdges(new Map([
    [1, [2]],
    [2, [3]],
  ]));
  assert.deepEqual(functionPaths(program, 1, 3, { maxDepth: 1 }).paths, [], 'numeric maxDepth remains authoritative');
  for (const invalid of [['1'], '1', true, { valueOf() { throw new Error('must not coerce'); } }]) {
    assert.deepEqual(functionPaths(program, 1, 3, { maxDepth: invalid }).paths, [[1, 2, 3]], 'invalid maxDepth must fall back');
  }
}

{
  const program = programFromEdges(new Map([
    [1, [2, 3]],
    [2, [4]],
    [3, [4]],
  ]));
  assert.equal(functionPaths(program, 1, 4, { maxPaths: 1 }).paths.length, 1, 'numeric maxPaths remains authoritative');
  assert.equal(functionPaths(program, 1, 4, { maxPaths: ['1'] }).paths.length, 2, 'structured maxPaths must fall back');
}

{
  const edges = new Map();
  for (let i = 1; i < 18; i++) edges.set(i, [i + 1]);
  const program = programFromEdges(edges);
  assert.deepEqual(functionPaths(program, 1, 18, { maxVisited: 16 }).paths, [], 'numeric maxVisited remains authoritative');
  assert.deepEqual(functionPaths(program, 1, 18, { maxVisited: ['16'] }).paths, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]], 'structured maxVisited must fall back');
}

console.log('query causal strict budget regression (#3189): PASS');
