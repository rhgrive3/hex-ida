import assert from 'node:assert/strict';
import { BinaryImage } from '../../js/binary/model.js';
import { ByteView } from '../../js/binary/reader.js';
import { parseExceptionFunctions } from '../../js/binary/pe-loader.js';

const REMAINDER_REASON = 'exception:directory-record-remainder';

function parseDirectory(size, machine, { mapped = true } = {}) {
  const bytes = new Uint8Array(size);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  if (mapped) {
    image.addSegment({
      name: '.pdata',
      address: 0x1000n,
      size: BigInt(size),
      fileOffset: 0n,
      fileSize: BigInt(size),
      perms: { read: true, write: false, execute: false },
    });
  }
  parseExceptionFunctions(
    new ByteView(bytes),
    { rva: 0x1000, size },
    image,
    machine,
  );
  return image;
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

for (const size of [12, 24]) {
  const image = parseDirectory(size, 0x8664);
  assert.equal(image.metadata.peMetadata?.complete, true, `x64 ${size}-byte table remains complete`);
  assert.equal(reasons(image).includes(REMAINDER_REASON), false);
}

for (const size of [13, 23]) {
  const image = parseDirectory(size, 0x8664);
  assert.equal(image.metadata.peMetadata?.complete, false, `x64 ${size}-byte table is partial`);
  assert.equal(reasons(image).includes(REMAINDER_REASON), true);
}

for (const machine of [0xaa64, 0xa641]) {
  const aligned = parseDirectory(8, machine);
  assert.equal(aligned.metadata.peMetadata?.complete, true);
  assert.equal(reasons(aligned).includes(REMAINDER_REASON), false);

  const remainder = parseDirectory(9, machine);
  assert.equal(remainder.metadata.peMetadata?.complete, false);
  assert.equal(reasons(remainder).includes(REMAINDER_REASON), true);
}

const unmapped = parseDirectory(13, 0x8664, { mapped: false });
assert.equal(unmapped.metadata.peMetadata?.complete, false);
assert.equal(reasons(unmapped).includes('exception:directory-span'), true);
assert.equal(reasons(unmapped).includes(REMAINDER_REASON), false, 'existing unmapped-span reason remains authoritative');

console.log('issue-3784 PE exception-directory remainder regression: PASS');
