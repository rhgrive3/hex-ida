import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { irFor } from '../../../js/ir.js';
import { createAgentTools } from '../../../js/agent/tools.js';

const BASE = 0x1000n;

function constantModel(count) {
  const model = buildSemanticModel([{ row:0, address:BASE, mn:'ret', ops:'' }], [], []);
  const ir = irFor(model);
  ir.values = Array.from({ length:count }, (_, i) => ({
    id:1000+i, bits:64, const:7n,
    def:{ id:2000+i, row:i, address:BASE + BigInt(i * 4) },
  }));
  ir.truncated = false;
  return model;
}

function toolsFor(model) {
  return createAgentTools({ analyze:async () => model }, { maxFunctions:4 });
}

test('#4989 recount never coerces a hostile limit object or upgrades an earlier overflow', async () => {
  const model = constantModel(101);
  let calls = 0;
  const hostile = { valueOf() { calls += 1; irFor(model).values.length = 100; return 100; } };
  const result = await toolsFor(model).find_constant(7, { functions:[BASE], limit:hostile });
  assert.equal(calls, 0);
  assert.equal(irFor(model).values.length, 101);
  assert.equal(result.returned, 100);
  assert.equal(result.total, null);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'result-limit');
});

test('#4989 throwing coercion objects use the core fallback without an uncaught exception', async () => {
  const model = constantModel(100);
  let calls = 0;
  const hostile = { valueOf() { calls += 1; throw new Error('must not coerce'); } };
  const result = await toolsFor(model).find_constant(7, { functions:[BASE], limit:hostile });
  assert.equal(calls, 0);
  assert.equal(result.returned, 100);
  assert.equal(result.total, 100);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
});

test('#4989 Symbol/non-number limits preserve primitive-number-only core fallback semantics', async () => {
  for (const limit of [Symbol('limit'), '1', { nope:true }]) {
    const result = await toolsFor(constantModel(100)).find_constant(7, { functions:[BASE], limit });
    assert.equal(result.returned, 100);
    assert.equal(result.total, 100);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, false);
  }
});

test('#4989 limit accessor is observed once by the core and never re-read by the recount', async () => {
  const model = constantModel(101);
  let reads = 0;
  const options = { functions:[BASE] };
  Object.defineProperty(options, 'limit', {
    enumerable:true,
    get() { reads += 1; return 100; },
  });
  const result = await toolsFor(model).find_constant(7, options);
  assert.equal(reads, 1);
  assert.equal(result.returned, 100);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});
