import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

// Issues #5551, #5555, #5559: Mach-O function-start producers trusted the
// executable segment's VM mapping alone. Segments may legally have
// vmsize > filesize (loader zero-fill), so a start inside the zero-fill tail
// has no instruction bytes and must not mint high-confidence seeds; and the
// symbol fallback treated every section under an RX segment as code even
// though only S_ATTR_*_INSTRUCTIONS sections hold machine instructions.

function ulebBytes(value) {
  const out = [];
  let v = BigInt(value);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}

// __TEXT: vmaddr 0x100000000, vmsize 0x2000, fileoff 0, filesize 0x1000 (RX).
// Optional section defaults to __text with S_ATTR_PURE|SOME_INSTRUCTIONS;
// its offset/extent/flags can be varied for symbol-authority regressions.
// Optional LC_FUNCTION_STARTS / LC_UNIXTHREAD / LC_SYMTAB.
function build({ fsDelta = null, entryAt = null, symtabAddress = null, sectionOffset = 0, sectionSize = 0x100, sectionFlags = 0x80000400 }) {
  const withText = fsDelta != null || symtabAddress != null;
  const bytes = new Uint8Array(0x1200);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0xcf; bytes[1] = 0xfa; bytes[2] = 0xed; bytes[3] = 0xfe;
  const segCmdSize = withText ? 152 : 72;
  let ncmds = 1, sizeofcmds = segCmdSize;
  if (fsDelta != null) { ncmds++; sizeofcmds += 16; }
  if (entryAt != null) { ncmds++; sizeofcmds += 16 + 68 * 4; }
  if (symtabAddress != null) { ncmds++; sizeofcmds += 24; }
  dv.setUint32(4, 0x0100000c, true); dv.setUint32(8, 0, true);
  dv.setUint32(12, 2, true); dv.setUint32(16, ncmds, true); dv.setUint32(20, sizeofcmds, true);
  const seg = 32;
  dv.setUint32(seg, 0x19, true); dv.setUint32(seg + 4, segCmdSize, true);
  bytes.set(Buffer.from('__TEXT'), seg + 8);
  dv.setBigUint64(seg + 24, 0x100000000n, true);
  dv.setBigUint64(seg + 32, 0x2000n, true);
  dv.setBigUint64(seg + 40, 0n, true);
  dv.setBigUint64(seg + 48, 0x1000n, true);
  dv.setUint32(seg + 60, 5, true);
  dv.setUint32(seg + 64, withText ? 1 : 0, true);
  dv.setUint32(seg + 68, 0, true);
  if (withText) {
    const q = seg + 72;
    bytes.set(Buffer.from('__text'), q); bytes.set(Buffer.from('__TEXT'), q + 16);
    dv.setBigUint64(q + 32, 0x100000000n + BigInt(sectionOffset), true);
    dv.setBigUint64(q + 40, BigInt(sectionSize), true);
    dv.setUint32(q + 48, sectionOffset, true);
    dv.setUint32(q + 64, sectionFlags, true);
  }
  let p = seg + segCmdSize;
  if (fsDelta != null) {
    const fsDataOff = 0x1000;
    dv.setUint32(p, 0x26, true); dv.setUint32(p + 4, 16, true);
    dv.setUint32(p + 8, fsDataOff, true); dv.setUint32(p + 12, 4, true);
    const enc = ulebBytes(fsDelta);
    bytes.set(enc, fsDataOff);
    bytes[fsDataOff + enc.length] = 0x00;
    p += 16;
  }
  if (entryAt != null) {
    dv.setUint32(p, 0x5, true); dv.setUint32(p + 4, 16 + 68 * 4, true);
    dv.setUint32(p + 8, 6, true); dv.setUint32(p + 12, 68, true); // ARM_THREAD_STATE64
    dv.setBigUint64(p + 16 + 256, entryAt, true);
    p += 16 + 68 * 4;
  }
  if (symtabAddress != null) {
    dv.setUint32(p, 0x2, true); dv.setUint32(p + 4, 24, true);
    dv.setUint32(p + 8, 0x1140, true); dv.setUint32(p + 12, 1, true);
    dv.setUint32(p + 16, 0x1160, true); dv.setUint32(p + 20, 16, true);
    const sv = new DataView(bytes.buffer);
    sv.setUint32(0x1140, 4, true); // n_strx into the string table
    bytes[0x1144] = 0x0f; // N_SECT | N_EXT
    bytes[0x1145] = 1;    // n_sect
    sv.setBigUint64(0x1148, symtabAddress, true);
    sv.setUint32(0x1160, 16, true);
    bytes.set(Buffer.from('_fn_name\0'), 0x1164);
    p += 24;
  }
  return bytes;
}

const seedsOf = (image, source) => image.functions.filter((f) => f.source === source);

// --- #5551: LC_FUNCTION_STARTS -------------------------------------------
{
  const image = parseMachO(build({ fsDelta: 0x1400 }), {}); // 0x100001400 = zero-fill tail
  assert.deepEqual(seedsOf(image, 'function_starts').map((f) => f.address.toString()), [],
    'a zero-fill function start must not become a 0.995-confidence seed');
  assert.equal(image.metadata.functionStarts.complete, false);
  assert.equal(image.metadata.functionStarts.partialReason, 'invalid-entry');
  assert.ok(image.warnings.some((w) => w.includes('no file-backed instruction bytes')));
}
{
  const image = parseMachO(build({ fsDelta: 0x40 }), {}); // 0x100000040 = file-backed
  assert.equal(seedsOf(image, 'function_starts').length, 1, 'file-backed function starts still seed');
  assert.equal(image.metadata.functionStarts.complete, true);
}

// --- #5555: LC_UNIXTHREAD entrypoint -------------------------------------
{
  const image = parseMachO(build({ entryAt: 0x100000000n + 0x1400n }), {});
  assert.equal(image.metadata.entrypointValid, false, 'zero-fill PC is not a valid entrypoint');
  assert.equal(seedsOf(image, 'entrypoint').length, 0, 'zero-fill PC must not mint an entrypoint seed');
  assert.ok(image.warnings.some((w) => w.includes('Ignored LC_UNIXTHREAD entrypoint')));
}
{
  const image = parseMachO(build({ entryAt: 0x100000000n + 0x40n }), {});
  assert.equal(image.metadata.entrypointValid, true, 'file-backed PC stays a valid entrypoint');
  assert.equal(seedsOf(image, 'entrypoint').length, 1);
  assert.equal(image.functions[0].address, 0x100000040n);
}

// --- #5559: symbol fallback ----------------------------------------------
{
  // Keep the symbol inside a real RX section while withholding instruction
  // attributes. Main would seed this solely from sec.perms.execute.
  const image = parseMachO(build({
    symtabAddress: 0x100000000n + 0x810n,
    sectionOffset: 0x800,
    sectionSize: 0x100,
    sectionFlags: 0,
  }), {});
  assert.deepEqual(seedsOf(image, 'symbol').map((f) => f.name), [],
    'an in-range symbol in an attribute-less RX section must not become a function seed');
}
{
  // SOME_INSTRUCTIONS describes a mixed section and does not prove that this
  // particular symbol address is code; symbol-only authority must fail closed.
  const image = parseMachO(build({
    symtabAddress: 0x100000000n + 0x10n,
    sectionFlags: 0x400,
  }), {});
  assert.deepEqual(seedsOf(image, 'symbol').map((f) => f.name), [],
    'a SOME_INSTRUCTIONS-only section must not mint a 0.9 symbol function seed');
}
{
  const image = parseMachO(build({
    symtabAddress: 0x100000000n + 0x10n,
    sectionFlags: 0x80000000,
  }), {});
  const seeds = seedsOf(image, 'symbol');
  assert.equal(seeds.length, 1, 'a PURE_INSTRUCTIONS section still authorizes a symbol seed');
  assert.equal(seeds[0].name, '_fn_name');
  assert.equal(seeds[0].address, 0x100000010n);
}

console.log('issues #5551 + #5555 + #5559 macho zero-fill and instruction-attribute regression: PASS');
