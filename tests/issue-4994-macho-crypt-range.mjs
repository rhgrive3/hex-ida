import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';
import { describeBinaryImage } from '../js/platform/describe.js';

// Issue #4994 (remaining gap): LC_ENCRYPTION_INFO / LC_ENCRYPTION_INFO_64 are
// parsed into metadata.encryption, but the crypt range is never bounded by the
// image file length. A command whose cryptoff + cryptsize runs past the end of
// the (thin or selected fat) slice still mints exact canonical evidence and the
// descriptor reports it as encrypted. The range check must be overflow-safe so
// a uint32 wrap such as cryptoff=0xfffffff0, cryptsize=0x100 cannot smuggle an
// out-of-file range past it. Malformed ranges must fall to metadata
// completeness/warning instead of minting encryption evidence.

function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }
const enc = new TextEncoder();

const HEADER = 32;
const SEGMENT = 72;
const ENCRYPTION64 = 24;
const FILE_BODY = 0x8000;

function segment64(fileSize = FILE_BODY) {
  const b = new Uint8Array(SEGMENT);
  u32(b, 0, 0x19); u32(b, 4, SEGMENT); b.set(enc.encode('__TEXT\0'), 8);
  u64(b, 24, 0x10000000n); u64(b, 32, fileSize); u64(b, 40, 0); u64(b, 48, fileSize);
  u32(b, 56, 7); u32(b, 60, 5); u32(b, 64, 0); u32(b, 68, 0);
  return b;
}

function encryption64(cryptoff, cryptsize, cryptid) {
  const b = new Uint8Array(ENCRYPTION64);
  u32(b, 0, 0x2c); u32(b, 4, ENCRYPTION64);
  u32(b, 8, cryptoff); u32(b, 12, cryptsize); u32(b, 16, cryptid); u32(b, 20, 0);
  return b;
}

function thin64(cmds) {
  const sizeofcmds = cmds.reduce((t, c) => t + c.length, 0);
  const b = new Uint8Array(HEADER + sizeofcmds + FILE_BODY);
  u32(b, 0, 0xfeedfacf); u32(b, 4, 0x0100000c); u32(b, 8, 0); u32(b, 12, 2);
  u32(b, 16, cmds.length); u32(b, 20, sizeofcmds); u32(b, 24, 0); u32(b, 28, 0);
  let p = HEADER;
  for (const c of cmds) { b.set(c, p); p += c.length; }
  return b;
}

function fat64(slice) {
  const sliceOffset = 0x4000;
  const b = new Uint8Array(sliceOffset + slice.length);
  const d = new DataView(b.buffer);
  d.setUint32(0, 0xcafebabe, false);
  d.setUint32(4, 1, false);
  d.setUint32(8, 0x0100000c, false); d.setUint32(12, 0, false);
  d.setUint32(16, sliceOffset, false); d.setUint32(20, slice.length, false);
  d.setUint32(24, 14, false);
  b.set(slice, sliceOffset);
  return b;
}

const described = (image) => describeBinaryImage(image).slices[0].info;

{
  const image = parseMachO(thin64([segment64(), encryption64(0x4000, 0x2000, 1)]));
  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 1 },
    'an in-file crypt range keeps its canonical evidence');
  assert.equal(described(image).encrypted, true, 'in-range cryptid != 0 stays encrypted');
  assert.equal(image.metadata.machoMetadata?.complete, true, 'a well-formed command is not partial');
}

{
  const image = parseMachO(thin64([segment64(), encryption64(0x4000, FILE_BODY, 1)]));
  assert.equal(image.metadata.encryption, undefined,
    'a crypt range running past the image end must not mint exact encryption evidence');
  assert.equal(image.metadata.machoMetadata?.complete, false, 'the out-of-file range is a completeness gap');
  assert.ok(image.metadata.machoMetadata?.reasons?.some((reason) => /encryption|crypt/i.test(reason)),
    `the crypt range violation is recorded as a reason, got ${JSON.stringify(image.metadata.machoMetadata?.reasons)}`);
  assert.ok(image.warnings.some((w) => /LC_ENCRYPTION_INFO|crypt/i.test(w)),
    `the crypt range violation is warned, got ${JSON.stringify(image.warnings)}`);
  assert.equal(described(image).encrypted, false, 'an out-of-file range is never reported as encrypted');
}

{
  const image = parseMachO(thin64([segment64(), encryption64(0xfffffff0, 0x100, 1)]));
  assert.equal(image.metadata.encryption, undefined,
    'uint32 wrap of cryptoff + cryptsize must not pass the range gate');
  assert.equal(image.metadata.machoMetadata?.complete, false, 'the wrapped range is a completeness gap');
  assert.equal(described(image).encrypted, false, 'a wrapped range is never reported as encrypted');
}

{
  const image = parseMachO(thin64([segment64(), encryption64(FILE_BODY, 0x1000, 1)]));
  assert.equal(image.metadata.encryption, undefined, 'a cryptoff at the image end is out of file');
  assert.equal(described(image).encrypted, false);
}

{
  const image = parseMachO(thin64([segment64(), encryption64(0x4000, 0x2000, 0)]));
  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 0 },
    'in-range plaintext evidence is still retained');
  assert.equal(described(image).encrypted, false, 'cryptid == 0 stays plaintext');
}

{
  const truncated = new Uint8Array(16);
  u32(truncated, 0, 0x2c); u32(truncated, 4, 16); u32(truncated, 8, 0x4000); u32(truncated, 12, 0x2000);
  const image = parseMachO(thin64([segment64(), truncated]));
  assert.equal(image.metadata.encryption, undefined, 'a truncated command must not mint encryption evidence');
  assert.equal(image.metadata.machoMetadata?.complete, false);
  assert.equal(described(image).encrypted, false, 'a truncated command is not reported as encrypted');
}

{
  const image = parseMachO(fat64(thin64([segment64(), encryption64(0x4000, 0x2000, 1)])));
  assert.equal(image.metadata.fat?.selected != null, true, 'fixture is a fat container');
  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 1 },
    'the selected slice drives encryption evidence');
  assert.equal(described(image).encrypted, true, 'encrypted slices report encrypted on fat containers');
}

{
  const image = parseMachO(fat64(thin64([segment64(), encryption64(0x4000, FILE_BODY, 1)])));
  assert.equal(image.metadata.encryption, undefined,
    'the slice length, not the container length, bounds the crypt range');
  assert.equal(described(image).encrypted, false);
}

{
  const image = parseMachO(thin64([segment64()]));
  assert.equal(image.metadata.encryption, undefined);
  assert.equal(described(image).encrypted, false, 'images without an encryption command keep legacy display');
  assert.equal(image.metadata.machoMetadata?.complete, true, 'unrelated images stay complete');
}

console.log('issue-4994 macho crypt range containment: ok');
