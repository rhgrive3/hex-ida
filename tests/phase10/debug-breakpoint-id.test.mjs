import assert from 'node:assert/strict';
import { normalizeBreakpoint } from '../../js/debug/adapter.js';

for (const id of [{ source: 'A' }, ['id'], true, 7, '']) {
  assert.throws(
    () => normalizeBreakpoint({ kind: 'address', address: 0x1000n, id }),
    (error) => error?.code === 'invalid-breakpoint',
  );
}

const first = normalizeBreakpoint({ kind: 'address', address: 0x1000n });
const second = normalizeBreakpoint({ kind: 'address', address: 0x2000n });
assert.equal(first.id, 'bp:address:4096');
assert.equal(second.id, 'bp:address:8192');
assert.notEqual(first.id, second.id);

const explicit = normalizeBreakpoint({ kind: 'address', address: 0x1000n, id: 'user:bp' });
assert.equal(explicit.id, 'user:bp');

for (const spec of [
  { kind: 'function', function: 'target', id: {} },
  { kind: 'conditional', address: 0x1000n, condition: 'x0 == 0', id: [] },
  { kind: 'memory', address: 0x1000n, id: false },
]) {
  assert.throws(() => normalizeBreakpoint(spec), (error) => error?.code === 'invalid-breakpoint');
}

console.log('debug breakpoint id contract tests passed');
