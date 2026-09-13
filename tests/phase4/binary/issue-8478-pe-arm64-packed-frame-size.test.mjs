import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

// Issue #8478: Windows ARM64 packed unwind requires FrameSize to cover the
// canonical integer/FP save area plus the optional x0-x7 home area.  A packed
// record whose declared frame is smaller is structurally impossible and must
// not become high-confidence exception/function evidence.

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function packedUnwind({
  flag = 1,
  functionLength = 4,
  regF = 0,
  regI = 0,
  home = 0,
  cr = 0,
  frameSize = 0,
} = {}) {
  return (flag
    | (functionLength << 2)
    | (regF << 13)
    | (regI << 16)
    | (home << 20)
    | (cr << 21)
    | (frameSize << 23)) >>> 0;
}

function parse(unwindData, { machine = 0xaa64 } = {}) {
  const bytes = new Uint8Array(256);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, unwindData);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: 8n,
    fileOffset: 0n,
    fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  image.addSection({
    name: '.text',
    address: 0x2000n,
    size: 0x100n,
    fileOffset: 64n,
    fileSize: 64n,
    perms: { read: true, write: false, execute: true },
  });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, machine);
  return image;
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

function expectInvalid(fields, message, options) {
  const image = parse(packedUnwind(fields), options);
  assert.equal(image.functions.length, 0, `${message}: no function seed`);
  assert.equal((image.metadata.exceptionDirectory?.fragments || []).length, 0, `${message}: no fragment evidence`);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1, `${message}: invalid record counted`);
  assert.equal(reasons(image).includes('exception:arm64-packed-frame-size'), true, `${message}: stable partial reason`);
  assert.equal(image.metadata.peMetadata?.complete, false, `${message}: metadata is partial`);
}

function expectValid(fields, message, options) {
  const image = parse(packedUnwind(fields), options);
  if ((fields.flag ?? 1) === 2) {
    assert.equal(image.functions.length, 0, `${message}: fragments do not seed functions`);
    assert.equal((image.metadata.exceptionDirectory?.fragments || []).length, 1, `${message}: fragment retained`);
  } else {
    assert.equal(image.functions.length, 1, `${message}: function seed retained`);
    assert.equal(image.functions[0].address, 0x2000n);
    assert.equal(image.functions[0].source, 'exception');
    assert.equal(image.functions[0].confidence, 0.995);
  }
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0, `${message}: no invalid record`);
  assert.equal(image.metadata.peMetadata?.complete, true, `${message}: metadata stays complete`);
}

// RegI=1 needs 8 bytes, rounded to one 16-byte frame unit.
expectInvalid({ regI: 1, frameSize: 0 }, 'RegI save area cannot fit in a zero frame');
expectValid({ regI: 1, frameSize: 1 }, 'RegI exact rounded boundary');

// RegF=1 represents d8-d9 => 16 bytes.
expectInvalid({ regF: 1, frameSize: 0 }, 'FP save area cannot fit in a zero frame');
expectValid({ regF: 1, frameSize: 1 }, 'FP exact boundary');

// H homes x0-x7: 64 bytes / four frame units.
expectInvalid({ home: 1, frameSize: 3 }, 'home area one frame unit too small');
expectValid({ home: 1, frameSize: 4 }, 'home area exact boundary');

// CR=01 adds the saved LR to the integer save area.
expectInvalid({ cr: 1, frameSize: 0 }, 'saved LR cannot fit in a zero frame');
expectValid({ cr: 1, frameSize: 1 }, 'saved LR exact rounded boundary');

// Combined: RegI=3 -> 24, CR=1 -> +8, RegF=2 -> 24, H -> 64;
// total 120 bytes rounds to 128 = eight FrameSize units.
expectInvalid({ regI: 3, regF: 2, home: 1, cr: 1, frameSize: 7 }, 'combined save area below rounded boundary');
expectValid({ regI: 3, regF: 2, home: 1, cr: 1, frameSize: 8 }, 'combined exact rounded boundary');

// Packed fragments use the same packed frame fields before fragment evidence is recorded.
expectInvalid({ flag: 2, regI: 1, frameSize: 0 }, 'packed fragment with impossible frame');
expectValid({ flag: 2, regI: 1, frameSize: 1 }, 'packed fragment exact boundary');

// ARM64EC shares this packed unwind encoding.
expectInvalid({ regI: 1, frameSize: 0 }, 'ARM64EC impossible packed frame', { machine: 0xa641 });
expectValid({ regI: 1, frameSize: 1 }, 'ARM64EC exact packed frame boundary', { machine: 0xa641 });

// Local stack beyond the mandatory save area remains valid.
expectValid({ regI: 1, frameSize: 8 }, 'larger frame with local stack remains valid');

console.log('issue #8478 PE ARM64 packed unwind FrameSize regression: PASS');
