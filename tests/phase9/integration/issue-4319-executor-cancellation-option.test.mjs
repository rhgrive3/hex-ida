import assert from 'node:assert/strict';
import test from 'node:test';
import { OP } from '../../../js/ir.js';
import { symbolicExecute } from '../../../js/symbolic/executor.js';

const ir = { entry: 0, blocks: [{ index: 0, phis: [], succ: [], insts: [{ id: 'ret', row: 0, op: OP.RET, args: [{ value: { id: 'zero', const: 0n } }] }] }] };

test('non-callable cancellation options fail before IR traversal or early return', () => {
  let traversed = false;
  const unreadable = { get blocks() { traversed = true; throw new Error('must not traverse'); } };
  for (const isCancelled of [true, false, 0, 1, '', 'x', [], {}, Symbol('callback')]) {
    for (const input of [ir, { blocks: [] }, null, unreadable]) {
      assert.throws(() => symbolicExecute(input, { isCancelled }), {
        name: 'TypeError', message: 'isCancelled must be a function',
      });
    }
  }
  assert.equal(traversed, false);
});

test('nullish and omitted callbacks preserve normal bounded execution', () => {
  for (const opts of [undefined, null, {}, { isCancelled: null }, { isCancelled: undefined }, { isCancelled: () => false }]) {
    const result = symbolicExecute(ir, opts);
    assert.equal(result.truncated, false);
    assert.equal(result.paths[0].returnValue.value, 0n);
  }
});

test('callback cancellation remains bounded and stops path publication', () => {
  let calls = 0;
  const result = symbolicExecute(ir, { isCancelled() { calls++; return true; } });
  assert.equal(calls, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.paths, []);
});

test('a pre-aborted signal short-circuits a valid callback', () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = symbolicExecute(ir, { signal: controller.signal, isCancelled() { calls++; return false; } });
  assert.equal(calls, 0);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.paths, []);
});

test('callback exceptions preserve identity and valid empty inputs do not poll', () => {
  const failure = new Error('callback-failed');
  assert.throws(() => symbolicExecute(ir, { isCancelled() { throw failure; } }), (error) => error === failure);
  assert.deepEqual(symbolicExecute({ blocks: [] }, { isCancelled() { throw failure; } }), {
    paths: [], truncated: false, engine: 'semantic-ir-symbolic',
  });
});
