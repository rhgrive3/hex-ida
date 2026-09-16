// Regression for #4675: staticSize() must apply the same layout rule the
// struct evaluator uses — a `field.at` overlay field is read at an explicit
// relative offset and never advances the cursor, so it must not be added to
// the static struct size that becomes an array element stride.
import assert from 'node:assert/strict';
import { evaluatePattern } from '../js/pattern/index.js';

const u8 = { kind: 'primitive', name: 'u8' };
const element = {
  kind: 'struct',
  fields: [
    { name: 'a', type: u8 },
    { name: 'peek', at: 0, type: u8 },
    { name: 'b', type: u8 },
  ],
};
const pattern = {
  kind: 'struct',
  name: 'Root',
  fields: [{ name: 'items', type: { kind: 'array', count: 2, element } }],
};
const bytes = new Uint8Array([0x11, 0x12, 0x21, 0x22, 0xff]);
const items = evaluatePattern(pattern, bytes).value.fields.items;

const e0 = items.expand(0);
const e1 = items.expand(1);

assert.equal(Number(e0.fields.a.value), 0x11, 'element 0 a');
assert.equal(Number(e0.fields.b.value), 0x12, 'element 0 b');
assert.equal(Number(e1.fields.a.value), 0x21, 'element 1 a must use stride 2');
assert.equal(Number(e1.fields.b.value), 0x22, 'element 1 b must use stride 2');
assert.equal(Number(e1.fields.peek.value), 0x22, 'overlay field is relative to the current cursor');

// The same invariant must hold when the struct is evaluated standalone: the
// overlay field never consumes cursor bytes.
const single = evaluatePattern({ kind: 'struct', name: 'Solo', fields: element.fields }, bytes).value;
assert.equal(Number(single.fields.b.value), 0x12, 'standalone overlay keeps cursor at 1');
assert.equal(Number(single.provenance?.length ?? 2), 2, 'struct span stays 2 bytes');
