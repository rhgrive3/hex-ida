import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseClassicBindings } from '../../../js/binary/macho-dyld.js';

function fixture(stream, source = 'bind') {
  const bytes = Uint8Array.from(stream);
  const segment = { address: 0x1000n, size: 0x100n };
  const image = {
    bits: 64,
    metadata: {},
    warnings: [],
    imports: [],
    libraries: ['libA.dylib'],
    addressToOffset(address) {
      return address >= segment.address && address < segment.address + segment.size
        ? address - segment.address
        : null;
    },
  };
  const status = parseClassicBindings(
    new ByteView(bytes, { littleEndian: true }),
    { offset: 0, size: bytes.length },
    image,
    [segment],
    source,
  );
  return { status, image };
}

const BIND_ONE = [
  0x11, // SET_DYLIB_ORDINAL_IMM 1
  0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, // SET_SYMBOL "_foo"
  0x51, // SET_TYPE_IMM pointer
  0x70, 0x00, // SET_SEGMENT_AND_OFFSET_ULEB segment 0, offset 0
  0x90, // DO_BIND
];

// A normal bind stream is complete only when BIND_OPCODE_DONE terminates it.
{
  const { status, image } = fixture([...BIND_ONE, 0x00]);
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
}

// Removing only DONE must retain already decoded evidence but make coverage partial.
{
  const { status, image } = fixture(BIND_ONE);
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.metadata.dyldBindings.complete, false);
  assert.ok(image.warnings.some((warning) => warning.includes('without BIND_OPCODE_DONE')));
}

// Weak-bind has the same terminal requirement while preserving its implicit ordinal.
{
  const weak = [
    0x40, 0x5f, 0x77, 0x65, 0x61, 0x6b, 0x00, // SET_SYMBOL "_weak"
    0x51,
    0x70, 0x00,
    0x90,
  ];
  const { status, image } = fixture(weak, 'weak-bind');
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports[0].ordinal, -3);
  assert.equal(image.metadata.dyldBindings.complete, false);
}

// Existing operand-truncation failure remains authoritative; missing DONE must not
// turn a malformed ULEB into a successful stream.
{
  const { status, image } = fixture([0x20, 0x80], 'bind');
  assert.equal(status.complete, false);
  assert.ok(image.warnings.some((warning) => warning.includes('operand is truncated')));
}

// Existing unsupported-opcode diagnostics stay partial.
{
  const { status } = fixture([0xe0], 'bind');
  assert.equal(status.complete, false);
  assert.ok(status.unsupportedOpcodes.length > 0);
}

// Lazy-bind uses DONE as a per-entry delimiter and may contain multiple sequences.
// Its established semantics are intentionally unchanged by #4883.
{
  const lazy = [
    0x11,
    0x40, 0x5f, 0x61, 0x00,
    0x70, 0x00,
    0x90,
    0x00,
    0x11,
    0x40, 0x5f, 0x62, 0x00,
    0x70, 0x08,
    0x90,
    0x00,
  ];
  const { status, image } = fixture(lazy, 'lazy-bind');
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 2);
  assert.equal(image.imports.length, 2);
}

console.log('issue #4883 classic bind DONE terminator regressions: PASS');
