import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

function uleb(value) {
  let v = BigInt(value);
  assert.ok(v >= 0n);
  const out = [];
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte); } while (v);
  return out;
}

function singleTerminalTrie(name, payload) {
  const edge = new TextEncoder().encode(name);
  const childOffset = 4 + edge.length;
  return Uint8Array.from([0x00, 0x01, ...edge, 0x00, childOffset, payload.length, ...payload, 0x00]);
}

function run(payload, { name = '_x', imageBase = 0x100000000n, bits = 64 } = {}) {
  const bytes = singleTerminalTrie(name, payload);
  const image = {
    imageBase,
    bits,
    libraries: ['libA.dylib'],
    exports: [],
    functions: [],
    metadata: {},
    warnings: [],
    sectionAt(a) { return a >= imageBase && a < imageBase + 0x1000n ? { perms: { execute: true } } : null; },
    addressToOffset(a) { return a >= imageBase && a < imageBase + 0x1000n ? a - imageBase : null; },
  };
  const status = parseExportTrie(new ByteView(bytes), { offset: 0, size: bytes.length }, image);
  return { image, status };
}

const TWO_POW_64 = 18446744073709551616n;

test('issue-8802: REGULAR base+offset past 2^64 is withheld and the trie is partial', () => {
  // imageBase = 0xffffffffffffe000, offset = 0x3000 -> 0x10000000000001000 (> 2^64-1).
  const { image, status } = run([0x00, ...uleb(0x3000n)], { name: '_overflow', imageBase: 0xffffffffffffe000n, bits: 64 });
  assert.equal(status.complete, false, 'an impossible export VA must make the trie partial');
  assert.equal(status.partialReason, 'export-address-overflow');
  assert.equal(image.exports.length, 0, 'the impossible canonical export must not be published');
  assert.equal(image.functions.length, 0);
});

test('issue-8802: ABSOLUTE raw terminal == 2^64 is rejected, in-domain absolute kept', () => {
  const bad = run([0x02, ...uleb(TWO_POW_64)], { name: '_abs64' });
  assert.equal(bad.status.complete, false);
  assert.equal(bad.status.partialReason, 'export-address-overflow');
  assert.equal(bad.image.exports.length, 0);

  const good = run([0x02, ...uleb(0x20n)], { name: '_abs' });
  assert.equal(good.status.complete, true);
  assert.equal(good.image.exports[0].kind, 'absolute');
  assert.equal(good.image.exports[0].address, 0x20n, 'ABSOLUTE keeps the raw terminal value (#4366)');
});

test('issue-8802: resolver past the domain withholds the export even when the address is valid', () => {
  // flags = STUB_AND_RESOLVER(0x10) | REGULAR(0x00); valid address 0x20; resolver 2^64.
  const { image, status } = run([0x10, ...uleb(0x20n), ...uleb(TWO_POW_64)], { name: '_stubres' });
  assert.equal(status.complete, false);
  assert.equal(status.partialReason, 'export-address-overflow');
  assert.equal(image.exports.length, 0, 'an impossible resolver must not become canonical metadata');
});

test('issue-8802: exact 2^64-1 maximum is NOT rejected by the width check alone', () => {
  const { image, status } = run([0x00, ...uleb(0xffffffffffffffffn)], { name: '_max', imageBase: 0n, bits: 64 });
  assert.equal(status.complete, true, 'the exact maximum must survive purely because of width');
  assert.equal(image.exports[0].address, 0xffffffffffffffffn);
});

test('issue-8802: 32-bit domain rejects >0xffffffff but allows the exact maximum', () => {
  const over = run([0x00, ...uleb(0x100000000n)], { name: '_e32', imageBase: 0n, bits: 32 });
  assert.equal(over.status.complete, false);
  assert.equal(over.status.partialReason, 'export-address-overflow');
  assert.equal(over.image.exports.length, 0);

  const max32 = run([0x00, ...uleb(0xffffffffn)], { name: '_m32', imageBase: 0n, bits: 32 });
  assert.equal(max32.status.complete, true);
  assert.equal(max32.image.exports[0].address, 0xffffffffn);
});

test('issue-8802: normal REGULAR/THREAD_LOCAL results and #4366 semantics are preserved', () => {
  const reg = run([0x00, 0x20], { name: '_regular' });
  assert.equal(reg.status.complete, true);
  assert.equal(reg.image.exports[0].kind, 'export');
  assert.equal(reg.image.exports[0].address, 0x100000020n);
  assert.equal(reg.image.functions.length, 1, 'in-domain regular export still seeds a function');

  const tls = run([0x01, 0x20], { name: '_tls' });
  assert.equal(tls.status.complete, true);
  assert.equal(tls.image.exports[0].kind, 'thread-local');
  assert.equal(tls.image.exports[0].address, 0x100000000n + 0x20n, '#4366: THREAD_LOCAL stays image-base relative');
});
