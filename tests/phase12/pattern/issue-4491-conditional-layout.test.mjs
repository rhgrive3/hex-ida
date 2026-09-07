import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';

const u8 = { kind: 'primitive', name: 'u8' };
const u16 = { kind: 'primitive', name: 'u16le' };
const u32 = { kind: 'primitive', name: 'u32le' };
const constant = (value) => ({ op: 'const', value });
const ref = (path) => ({ op: 'ref', path });
const eq = (left, right) => ({ op: 'eq', left, right });

function run(fields, bytes, options = {}) {
  const pattern = compilePattern({ kind: 'struct', name: 'Root', fields });
  return evaluatePattern(pattern, Uint8Array.from(bytes), options);
}

{
  const result = run([
    { name: 'optional', type: { kind: 'conditional', when: constant(false), then: u8 } },
    { name: 'next', type: u8 },
  ], [0xaa, 0xbb]);
  assert.equal(result.status, 'complete');
  assert.equal(result.value.fields.optional.absent, true);
  assert.equal(result.value.fields.optional.provenance.length, '0');
  assert.equal(result.value.fields.next.value, 0xaa);
  assert.equal(result.value.fields.next.provenance.offset, '0');
  assert.equal(result.value.provenance.length, '1');
}

{
  const result = run([
    { name: 'optional', type: { kind: 'conditional', when: constant(true), then: u16 } },
    { name: 'next', type: u8 },
  ], [0x34, 0x12, 0xaa]);
  assert.equal(result.value.fields.optional.value, 0x1234);
  assert.equal(result.value.fields.next.value, 0xaa);
  assert.equal(result.value.fields.next.provenance.offset, '2');
  assert.equal(result.value.provenance.length, '3');
}

{
  const result = run([
    { name: 'optional', type: { kind: 'conditional', when: constant(false), then: u32, else: u16 } },
    { name: 'next', type: u8 },
  ], [0x34, 0x12, 0xaa, 0xbb, 0xcc]);
  assert.equal(result.value.fields.optional.value, 0x1234);
  assert.equal(result.value.fields.optional.provenance.length, '2');
  assert.equal(result.value.fields.next.value, 0xaa);
  assert.equal(result.value.fields.next.provenance.offset, '2');
  assert.equal(result.value.provenance.length, '3');
}

{
  const conditionalStruct = {
    kind: 'conditional',
    when: constant(true),
    then: {
      kind: 'struct',
      fields: [
        { name: 'a', type: u8 },
        { name: 'b', type: u8 },
      ],
    },
  };
  const result = run([
    { name: 'nested', type: conditionalStruct },
    { name: 'next', type: u8 },
  ], [0x11, 0x22, 0x33]);
  assert.equal(result.value.fields.nested.provenance.length, '2');
  assert.equal(result.value.fields.next.value, 0x33);
  assert.equal(result.value.fields.next.provenance.offset, '2');
}

{
  const result = run([
    { name: 'nested', type: { kind: 'conditional', when: constant(true), then: { kind: 'array', count: 2, element: u8 } } },
    { name: 'next', type: u8 },
  ], [0x11, 0x22, 0x33]);
  assert.equal(result.value.fields.nested.expand(0).value, 0x11);
  assert.equal(result.value.fields.nested.expand(1).value, 0x22);
  assert.equal(result.value.fields.nested.expand(1).provenance.offset, '1');
  assert.equal(result.value.fields.next.value, 0x33);
  assert.equal(result.value.fields.next.provenance.offset, '2');
}

{
  const result = run([
    { name: 'flag', type: u8 },
    { name: 'optional', type: { kind: 'conditional', when: eq(ref('flag'), constant(1)), then: u16, else: u8 } },
    { name: 'next', type: u8 },
  ], [0, 0x44, 0x55]);
  assert.equal(result.value.fields.optional.value, 0x44);
  assert.equal(result.value.fields.next.value, 0x55);
  assert.equal(result.value.fields.next.provenance.offset, '2');
}

{
  const result = run([
    {
      name: 'optional',
      type: {
        kind: 'conditional',
        when: eq(ref('optional'), constant(0xaa)),
        then: u16,
        else: u8,
      },
    },
    { name: 'next', type: u8 },
  ], [0xaa, 0xbb, 0xcc]);
  assert.equal(result.value.fields.optional.value, 0xaa,
    'conditional branch selection uses the values visible before the field is published');
  assert.equal(result.value.fields.next.value, 0xbb,
    'layout sizing must use the same pre-field values as branch selection');
  assert.equal(result.value.fields.next.provenance.offset, '1');
}

{
  const result = run([
    { name: 'skipped', when: constant(false), type: u16 },
    { name: 'next', type: u8 },
  ], [0xaa, 0xbb]);
  assert.equal(result.value.fields.skipped.absent, true);
  assert.equal(result.value.fields.skipped.provenance.length, '0');
  assert.equal(result.value.fields.next.value, 0xaa);
  assert.equal(result.value.fields.next.provenance.offset, '0');
}

{
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const cancelled = run([
    { name: 'optional', type: { kind: 'conditional', when: constant(true), then: u16 } },
  ], [0x11, 0x22], { signal: controller.signal });
  assert.equal(cancelled.status, 'partial');
  assert.equal(cancelled.reason, 'cancelled');
}

{
  const bounded = run([
    { name: 'optional', type: { kind: 'conditional', when: constant(true), then: u16 } },
  ], [0x11, 0x22], { maxBytes: 1 });
  assert.equal(bounded.status, 'partial');
  assert.equal(bounded.reason, 'resource-limit-bytes');
}

console.log('[phase12] issue #4491 conditional layout regression passed');
