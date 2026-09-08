// Issue #5834 regression: normal/weak classic bind streams start dyld's state
// machine with no bind type; only lazy-bind streams carry an implicit pointer
// type. A missing BIND_OPCODE_SET_TYPE_IMM must fail closed instead of
// laundering the bind into a pointer bind.
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

function fixture(stream, source = 'bind', image = null, segment = null) {
  const bytes = new Uint8Array(0x100);
  bytes.set(stream, 0);
  const activeSegment = segment ?? { address: 0x1000n, size: 0x80n };
  const activeImage = image ?? {
    bits: 64, metadata: {}, warnings: [], imports: [], libraries: ['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null; },
  };
  const status = parseClassicBindings(reader(bytes), { offset: 0, size: stream.length }, activeImage, [activeSegment], source);
  return { status, image: activeImage, segment: activeSegment };
}

// SET_DYLIB_ORDINAL_IMM 1; SET_SYMBOL "_foo"; SET_SEGMENT 0 + 0; DO_BIND; DONE
// — no BIND_OPCODE_SET_TYPE_IMM anywhere in the stream.
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00]), 'bind');
  assert.equal(status.complete, false, 'normal bind without SET_TYPE_IMM must not publish as complete');
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0, 'no pointer-bind laundering from a typeless stream');
  assert.ok(image.warnings.some((x) => x.includes('unknown bind type 0')));
}

// Weak-bind streams share the contract.
{
  const { status, image } = fixture(Uint8Array.from([0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00]), 'weak-bind');
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((x) => x.includes('unknown bind type 0')));
}

// Lazy-bind streams keep dyld's implicit pointer type.
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00]), 'lazy-bind');
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites[0].type, 1, 'lazy bind keeps its implicit pointer type');
}

// An explicit SET_TYPE_IMM pointer keeps the normal bind valid.
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00, 0x90, 0x00]), 'bind');
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports[0].sites[0].type, 1);
}

// The implicit type applies per stream: a later normal stream in the same image
// must not inherit a type from the lazy-bind stream.
{
  const shared = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00]), 'lazy-bind');
  assert.equal(shared.status.complete, true);
  assert.equal(shared.status.decodedBinds, 1);
  assert.equal(shared.image.imports.length, 1);
  assert.equal(shared.image.imports[0].sites[0].type, 1);

  const importsBefore = shared.image.imports.length;
  const { status, image } = fixture(
    Uint8Array.from([0x40, 0x5f, 0x62, 0x61, 0x72, 0x00, 0x70, 0x00, 0x90, 0x00]),
    'bind',
    shared.image,
    shared.segment,
  );
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, importsBefore,
    'normal bind must not inherit lazy-bind type state from the same image');
}

console.log('issue #5834 classic bind initial type regressions: PASS');
