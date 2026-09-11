// Issue #5831 regression: BIND_OPCODE_SET_TYPE_IMM immediates outside the
// canonical Mach-O bind types {1,2,3} must fail closed at the bind site instead
// of minting a canonical import with an undefined type.
import assert from 'node:assert/strict';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n, shift = 0n; const start = p;
    while (p < end && p - start < 10) {
      const b = bytes[p++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next: p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length: bytes.length, bytes,
    u8: (o) => view.getUint8(o),
    u64: (o) => view.getBigUint64(o, true),
    uleb: (p, _max, end) => leb(p, end),
    sleb: (p, _max, end) => leb(p, end),
    slice: (p, n) => bytes.slice(p, p + n),
  };
}

function fixture(stream, source = 'bind') {
  const bytes = new Uint8Array(0x100);
  bytes.set(stream, 0);
  const segment = { address: 0x1000n, size: 0x80n };
  const image = {
    bits: 64, metadata: {}, warnings: [], imports: [], libraries: ['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null; },
  };
  const status = parseClassicBindings(reader(bytes), { offset: 0, size: stream.length }, image, [segment], source);
  return { status, image };
}

const stream = (typeImm) => Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x50 | typeImm, 0x70, 0x00, 0x90, 0x00]);

// dyld's BindOpcodes::valid() rejects any type outside {1,2,3} ("unknown bind
// type"). A DO_BIND after SET_TYPE_IMM 4 must not canonicalize the import.
for (const typeImm of [0, 4, 5, 15]) {
  const { status, image } = fixture(stream(typeImm));
  assert.equal(status.complete, false, `unknown bind type ${typeImm} must not publish a complete stream`);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0, `unknown bind type ${typeImm} must not mint a canonical import`);
  assert.ok(image.warnings.some((x) => x.includes(`unknown bind type ${typeImm}`)));
}

// Canonical types stay valid: pointer (1) and the two text-relative forms.
for (const typeImm of [1, 2, 3]) {
  const { status, image } = fixture(stream(typeImm));
  assert.equal(status.complete, true, `canonical bind type ${typeImm} must stay valid`);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports[0].sites[0].type, typeImm);
}

// A stream whose only bind is invalid stays otherwise-decodable: a valid bind
// after the failed one still records evidence of the partial state.
{
  const stream2 = Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x54, 0x70, 0x00, 0x90, 0x51, 0x40, 0x5f, 0x62, 0x61, 0x72, 0x00, 0x70, 0x08, 0x90, 0x00]);
  const { status, image } = fixture(stream2);
  assert.equal(status.complete, false, 'one unknown bind type poisons the whole stream');
  assert.equal(status.decodedBinds, 1, 'the later canonical bind is still decoded');
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites[0].type, 1);
}

console.log('issue #5831 classic bind type validation regressions: PASS');
