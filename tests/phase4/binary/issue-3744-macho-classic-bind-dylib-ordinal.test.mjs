import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseClassicBindings } from '../../../js/binary/macho-dyld.js';

function encodeUleb(value) {
  let x = BigInt(value);
  const out = [];
  do {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x) byte |= 0x80;
    out.push(byte);
  } while (x);
  return out;
}

function ordinalSetter(ordinal, kind = 'immediate') {
  if (kind === 'uleb') return [0x20, ...encodeUleb(ordinal)];
  if (ordinal >= 0) return [0x10 | Number(ordinal)];
  return [0x30 | (Number(ordinal) & 0x0f)];
}

function bindStream(ordinal, kind = 'immediate') {
  return Uint8Array.from([
    ...ordinalSetter(ordinal, kind),
    0x40, 0x5f, 0x78, 0x00, // SET_SYMBOL_TRAILING_FLAGS_IMM "_x"
    0x51,                   // SET_TYPE_IMM pointer
    0x70, 0x00,             // SET_SEGMENT_AND_OFFSET_ULEB seg=0, off=0
    0x90,                   // DO_BIND
    0x00,                   // DONE
  ]);
}

function run(ordinal, { kind = 'immediate', libraries = ['/usr/lib/libSystem.B.dylib'] } = {}) {
  const bytes = bindStream(ordinal, kind);
  const segment = {
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0n,
    fileSize: 0x100n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    bits: 64,
    imageBase: 0x1000n,
    libraries: [...libraries],
    imports: [],
    metadata: {},
    warnings: [],
    addressToOffset(address) {
      return address >= segment.address && address < segment.address + segment.fileSize
        ? address - segment.address
        : null;
    },
  };
  const status = parseClassicBindings(
    new ByteView(bytes),
    { offset: 0, size: bytes.length },
    image,
    [segment],
    'bind',
  );
  return { image, status };
}

{
  const { image, status } = run(1);
  assert.equal(status.complete, true);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].ordinal, 1);
  assert.equal(image.imports[0].library, '/usr/lib/libSystem.B.dylib');
}

for (const kind of ['immediate', 'uleb']) {
  const { image, status } = run(2, { kind });
  assert.equal(status.complete, false, `${kind} out-of-range ordinal must make the stream partial`);
  assert.equal(image.imports.length, 0, `${kind} out-of-range ordinal must not publish an import`);
  assert.ok(image.warnings.some((warning) => warning.includes('exceeds dependency count 1')));
}

for (const [ordinal, library] of [
  [0, null],
  [-1, '<main-executable>'],
  [-2, '<flat-lookup>'],
  [-3, '<weak-lookup>'],
]) {
  const { image, status } = run(ordinal);
  assert.equal(status.complete, true, `special ordinal ${ordinal} must retain existing semantics`);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].ordinal, ordinal);
  assert.equal(image.imports[0].library, library);
}

{
  const { image, status } = run(1n << 53n, { kind: 'uleb' });
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('safe integer range')));
}

console.log('issue-3744-macho-classic-bind-dylib-ordinal: PASS');
