import assert from 'node:assert/strict';
import test from 'node:test';
import { BinaryReadError, ByteView } from '../../../js/binary/reader.js';

const bytes = Uint8Array.of(
  0x41, 0x42, 0x43, 0x00,
  0x81, 0x80, 0x01,
  0x81, 0x80, 0x01,
);

function view() {
  return new ByteView(bytes);
}

const invalidBounds = [
  '2',
  '',
  ['2'],
  true,
  false,
  null,
  2n,
  Symbol('2'),
  1.5,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];

test('#5142 preserves canonical primitive integer decode bounds', () => {
  const r = view();
  assert.equal(r.cstring(0, 2), 'AB');
  assert.deepEqual(r.uleb(4, 3, 7), { value: 16385n, next: 7, bytes: 3 });
  assert.deepEqual(r.sleb(7, 3, 10), { value: 16385n, next: 10, bytes: 3 });
  assert.throws(() => r.uleb(4, 2, 7), (error) => error instanceof BinaryReadError && /too long/.test(error.message));
  assert.throws(() => r.sleb(7, 2, 10), (error) => error instanceof BinaryReadError && /too long/.test(error.message));
  assert.equal(r.cstring(0, 0), '');
  assert.throws(() => r.uleb(4, 0, 7), BinaryReadError);
  assert.throws(() => r.sleb(7, 0, 10), BinaryReadError);
});

test('#5142 cstring never promotes malformed decode bounds through ToNumber', () => {
  for (const bound of invalidBounds) assert.equal(view().cstring(0, bound), 'ABC', `bound ${String(bound)} must use the default`);

  let coercions = 0;
  const structured = { [Symbol.toPrimitive]() { coercions++; return 2; } };
  assert.equal(view().cstring(0, structured), 'ABC');
  assert.equal(coercions, 0, 'decode-bound validation must not invoke structured coercion hooks');
});

test('#5142 ULEB maxBytes rejects coercion and fractional iteration counts', () => {
  for (const bound of invalidBounds)
    assert.deepEqual(view().uleb(4, bound, 7), { value: 16385n, next: 7, bytes: 3 }, `bound ${String(bound)} must use the default`);

  let coercions = 0;
  const structured = { valueOf() { coercions++; return 2; } };
  assert.deepEqual(view().uleb(4, structured, 7), { value: 16385n, next: 7, bytes: 3 });
  assert.equal(coercions, 0, 'ULEB limit validation must not invoke structured coercion hooks');
});

test('#5142 SLEB maxBytes rejects coercion and fractional iteration counts', () => {
  for (const bound of invalidBounds)
    assert.deepEqual(view().sleb(7, bound, 10), { value: 16385n, next: 10, bytes: 3 }, `bound ${String(bound)} must use the default`);

  let coercions = 0;
  const structured = { toString() { coercions++; return '2'; } };
  assert.deepEqual(view().sleb(7, structured, 10), { value: 16385n, next: 10, bytes: 3 });
  assert.equal(coercions, 0, 'SLEB limit validation must not invoke structured coercion hooks');
});

test('#5142 unsafe integer maxBytes falls back instead of creating an effectively unbounded loop', () => {
  const overlong = new ByteView(Uint8Array.of(
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00,
  ));
  assert.deepEqual(overlong.uleb(0, 11, 11), { value: 0n, next: 11, bytes: 11 });
  assert.deepEqual(overlong.sleb(0, 11, 11), { value: 0n, next: 11, bytes: 11 });
  assert.throws(() => overlong.uleb(0, Number.MAX_SAFE_INTEGER + 1, 11), (error) => error instanceof BinaryReadError && /too long/.test(error.message));
  assert.throws(() => overlong.sleb(0, Number.MAX_SAFE_INTEGER + 1, 11), (error) => error instanceof BinaryReadError && /too long/.test(error.message));
});

test('#5142 malformed maxBytes cannot weaken bounded-substream errors', () => {
  const r = view();
  assert.throws(
    () => r.uleb(4, ['10'], 6),
    (error) => error instanceof BinaryReadError && /crosses bounded substream/.test(error.message),
  );
  assert.throws(
    () => r.sleb(7, ['10'], 9),
    (error) => error instanceof BinaryReadError && /crosses bounded substream/.test(error.message),
  );
});
