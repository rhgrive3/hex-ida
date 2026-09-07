import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseClassicBindings } from '../../../js/binary/macho-dyld.js';

function bindTail() {
  return [
    0x40, 0x5f, 0x78, 0x00, // SET_SYMBOL_TRAILING_FLAGS_IMM "_x"
    0x51,                   // SET_TYPE_IMM pointer
    0x70, 0x00,             // SET_SEGMENT_AND_OFFSET_ULEB seg=0, off=0
    0x90,                   // DO_BIND
    0x00,                   // DONE
  ];
}

function run(bytes, source) {
  const data = Uint8Array.from(bytes);
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
    libraries: ['/usr/lib/libSystem.B.dylib'],
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
    new ByteView(data),
    { offset: 0, size: data.length },
    image,
    [segment],
    source,
  );
  return { image, status };
}

for (const [name, setter] of [
  ['immediate', [0x11]],
  ['uleb', [0x20, 0x01]],
  ['special', [0x3f]],
]) {
  const { image, status } = run([...setter, ...bindTail()], 'weak-bind');
  assert.equal(status.complete, false, `${name} dylib ordinal setter must make weak-bind partial`);
  assert.equal(image.metadata.dyldBindings.complete, false, `${name} must make aggregate binding metadata partial`);
  assert.equal(image.imports.length, 0, `${name} must not publish weak-bind evidence`);
  assert.ok(
    image.warnings.some((warning) => warning.includes('not allowed in weak-bind stream')),
    `${name} must report the stream-kind violation`,
  );
}

{
  const { image, status } = run([0x11, ...bindTail()], 'bind');
  assert.equal(status.complete, true, 'ordinary bind ordinal setters must remain valid');
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].ordinal, 1);
  assert.equal(image.imports[0].library, '/usr/lib/libSystem.B.dylib');
}

{
  const { image, status } = run(bindTail(), 'weak-bind');
  assert.equal(status.complete, true, 'weak-bind without a dylib ordinal setter must remain valid');
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].source, 'weak-bind');
  assert.equal(image.imports[0].ordinal, 0);
  assert.equal(image.imports[0].library, null);
}

console.log('issue-3746-macho-weak-bind-ordinal-opcodes: PASS');
