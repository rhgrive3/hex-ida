import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

test('6084: BigInt prototype metadata does not throw', () => {
  const model = modelOf(['mov x0, x1', 'ret']);
  const opts = { functionPrototype: { parameters: [{ type: 'int', bits: 64n }] } };
  let out = null;
  assert.doesNotThrow(() => { out = irFor(model, opts); });
  assert.ok(out === null || typeof out === 'object', 'must return IR or null, never throw');
});

test('6084: cyclic prototype metadata does not throw', () => {
  const model = modelOf(['mov x0, x1', 'ret']);
  const param = { type: 'int', bits: 32 };
  param.type = param;
  const opts = { functionPrototype: { parameters: [param] } };
  let out = null;
  assert.doesNotThrow(() => { out = irFor(model, opts); });
  assert.ok(out === null || typeof out === 'object', 'must return IR or null, never throw');
});

test('6084: canonical metadata still caches', () => {
  const model = modelOf(['mov x0, x1', 'ret']);
  const opts = { functionPrototype: { parameters: [{ type: 'int', bits: 32 }] } };
  const first = irFor(model, opts);
  assert.ok(first, 'canonical build must succeed');
  assert.strictEqual(irFor(model, opts), first, 'canonical metadata must hit the cache');
});

test('6084: distinct prototypes do not share a cache entry', () => {
  const model = modelOf(['mov x0, x1', 'ret']);
  const first = irFor(model, { functionPrototype: { parameters: [{ type: 'int', bits: 32 }] } });
  const second = irFor(model, { functionPrototype: { parameters: [{ type: 'int', bits: 64 }] } });
  assert.ok(first, 'first prototype build must succeed');
  assert.ok(second, 'second prototype build must succeed');
  assert.notStrictEqual(second, first, 'different prototypes must not collide in the cache');
});

test('6084: build failure remains a null result', () => {
  const model = modelOf(['mov x0, x1', 'ret']);
  const opts = { cfg: { nodes: {} } };
  let out = null;
  assert.doesNotThrow(() => { out = irFor(model, opts); });
  assert.equal(out, null, 'a failed IR build must fail closed with null');
});
