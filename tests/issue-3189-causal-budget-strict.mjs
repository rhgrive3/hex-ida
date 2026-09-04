import test from 'node:test';
import assert from 'node:assert/strict';

import { functionPaths, minimalCausalPath } from '../js/query/causal.js';
import { OP, VK } from '../js/ir.js';

function programWithChain() {
  const callees = new Map([
    [100n, [{ addr: 200n }]],
    [200n, [{ addr: 300n }]],
  ]);
  return {
    graphCompleteness: { callsComplete: true },
    functionRange: () => ({ start: 0n, end: 16n }),
    calleesOf: (addr) => callees.get(addr) || [],
  };
}

function programWithThreePaths() {
  const callees = new Map([
    [100n, [{ addr: 200n }, { addr: 300n }, { addr: 400n }]],
    [200n, [{ addr: 900n }]],
    [300n, [{ addr: 900n }]],
    [400n, [{ addr: 900n }]],
  ]);
  return {
    graphCompleteness: { callsComplete: true },
    functionRange: () => ({ start: 0n, end: 16n }),
    calleesOf: (addr) => callees.get(addr) || [],
  };
}

function programWithLateTarget() {
  const deadEnds = Array.from({ length: 20 }, (_, i) => ({ addr: BigInt(200 + i) }));
  const callees = new Map([[100n, [...deadEnds, { addr: 900n }]]]);
  return {
    graphCompleteness: { callsComplete: true },
    functionRange: () => ({ start: 0n, end: 16n }),
    calleesOf: (addr) => callees.get(addr) || [],
  };
}

function causalIrWithSixSteps() {
  const values = [];
  const instructions = [];
  const value = (id, kind = VK.TEMP, constant = null) => {
    const out = { id, kind, bits: 64, uses: [] };
    if (constant != null) out.const = constant;
    values.push(out);
    return out;
  };

  const first = value(1, VK.CONST, 1n);
  const constant = { id: 1, op: OP.CONST, row: 1, block: 0, address: 0n, args: [], dst: first };
  first.def = constant;
  instructions.push(constant);

  let previous = first;
  for (let id = 2; id <= 5; id++) {
    const next = value(id);
    const inst = {
      id,
      op: OP.BIN,
      sub: 'add',
      row: id,
      block: 0,
      address: BigInt(id - 1) * 4n,
      args: [{ value: previous }],
      dst: next,
    };
    next.def = inst;
    previous.uses.push(inst);
    instructions.push(inst);
    previous = next;
  }

  const store = {
    id: 6,
    op: OP.STORE,
    row: 6,
    block: 0,
    address: 20n,
    args: [{ value: previous }],
    loc: { key: 'global:0', kind: 'global', address: 0n, size: 8 },
    extra: { size: 8 },
  };
  previous.uses.push(store);
  instructions.push(store);
  return { ir: { startAddress: 0n, instructions, values, blocks: [{ startRow: 1 }] }, seed: store };
}

test('#3189 structured maxDepth falls back instead of coercing', () => {
  const program = programWithChain();
  const out = functionPaths(program, 100n, 300n, { maxDepth: ['1'] });
  assert.deepEqual(out.paths, [[100n, 200n, 300n]]);
  assert.equal(out.truncated, false);
});

test('#3189 structured maxPaths and booleans fall back to the full default budget', () => {
  const program = programWithThreePaths();
  assert.equal(functionPaths(program, 100n, 900n, { maxPaths: ['2'] }).paths.length, 3);
  assert.equal(functionPaths(program, 100n, 900n, { maxPaths: true }).paths.length, 3);
});

test('#3189 structured maxVisited cannot truncate a late target', () => {
  const out = functionPaths(programWithLateTarget(), 100n, 900n, { maxVisited: ['16'] });
  assert.deepEqual(out.paths, [[100n, 900n]]);
  assert.equal(out.truncated, false);
});

test('#3189 numeric strings are not budget authority', () => {
  const out = functionPaths(programWithChain(), 100n, 300n, { maxDepth: '1' });
  assert.deepEqual(out.paths, [[100n, 200n, 300n]]);
});

test('#3189 real numbers keep floor/clamp semantics', () => {
  const program = programWithChain();
  const floored = functionPaths(program, 100n, 300n, { maxDepth: 3.5, maxPaths: 4.7 });
  assert.deepEqual(floored.paths[0], [100n, 200n, 300n], '3.5 floors to 3 and reaches the sink');
  const floorShort = functionPaths(program, 100n, 300n, { maxDepth: 2.9 });
  assert.equal(floorShort.paths.length, 0, '2.9 floors to 2 and cannot reach the sink');

  const limited = functionPaths(programWithThreePaths(), 100n, 900n, { maxPaths: 2.9 });
  assert.equal(limited.paths.length, 2, '2.9 floors to an actual two-path budget');
  assert.equal(limited.truncated, true);
  assert.ok(limited.reasons.includes('path-limit'));
});

test('#3189 minimalCausalPath structured limit falls back to eight', () => {
  const { ir, seed } = causalIrWithSixSteps();
  const out = minimalCausalPath(ir, seed, { limit: ['2'] });
  assert.equal(out.engine, 'semantic-ir');
  assert.equal(out.nodes.length, 6, 'structured limit must not coerce to 2');
  assert.equal(out.elided, 0);

  const realTwo = minimalCausalPath(ir, seed, { limit: 2 });
  assert.equal(realTwo.nodes.length, 2);
  assert.equal(realTwo.elided, 4);
});