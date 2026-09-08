import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';

const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

const defaultView = new ByteView(bytes);
assert.equal(defaultView.littleEndian, true);
assert.equal(defaultView.u16(0), 0x0201);
assert.equal(defaultView.u32(0), 0x04030201);
assert.equal(defaultView.u64(0), 0x0807060504030201n);

const little = new ByteView(bytes, { littleEndian: true });
assert.equal(little.littleEndian, true);
assert.equal(little.u16(0), 0x0201);
assert.equal(little.i16(0), 0x0201);

const big = new ByteView(bytes, { littleEndian: false });
assert.equal(big.littleEndian, false);
assert.equal(big.u16(0), 0x0102);
assert.equal(big.u32(0), 0x01020304);
assert.equal(big.u64(0), 0x0102030405060708n);
assert.equal(big.endian(false).u16(0), 0x0102);
assert.equal(big.endian(true).u16(0), 0x0201);

const inheritedSubview = big.subview(0, 4);
assert.equal(inheritedSubview.littleEndian, false);
assert.equal(inheritedSubview.u16(0), 0x0102);
assert.equal(big.subview(0, 4, { littleEndian: true }).u16(0), 0x0201);

const invalidValues = ['false', 'true', 0, 1, NaN, null, [], {}, new Boolean(false)];
for (const value of invalidValues) {
  assert.throws(
    () => new ByteView(bytes, { littleEndian: value }),
    (error) => error instanceof TypeError && /littleEndian must be a boolean/.test(error.message),
    `constructor must reject ${String(value)}`,
  );
  assert.throws(
    () => defaultView.endian(value),
    (error) => error instanceof TypeError && /littleEndian must be a boolean/.test(error.message),
    `endian() must reject ${String(value)}`,
  );
  assert.throws(
    () => defaultView.subview(0, 2, { littleEndian: value }),
    (error) => error instanceof TypeError && /littleEndian must be a boolean/.test(error.message),
    `subview() must reject ${String(value)}`,
  );
}

for (const method of ['u16', 'i16', 'u32', 'i32', 'u64', 'i64']) {
  assert.throws(
    () => defaultView[method](0, 'false'),
    (error) => error instanceof TypeError && /littleEndian must be a boolean/.test(error.message),
    `${method} must reject non-boolean byte-order overrides`,
  );
}

assert.equal(new ByteView(bytes, { littleEndian: undefined }).littleEndian, true);
console.log('phase4 issue-5193 ByteView endian contract: PASS');
