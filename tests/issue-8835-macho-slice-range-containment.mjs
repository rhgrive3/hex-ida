// Issue #8835 regression: the classic/legacy Mach-O stack recorded
// slice-relative load-command file ranges (LC_SYMTAB, LC_DYSYMTAB,
// LC_FUNCTION_STARTS, LC_DATA_IN_CODE, LC_ENCRYPTION_INFO[_64]) without proving
// they stay inside the *selected* slice, and `js/worker-legacy.js::analyzeSlice()`
// read them from the whole container (`base + offset`). A fat slice could
// therefore point its linkedit commands past its own end and consume bytes
// physically owned by another slice/container area. The strongest reproducible
// case was `LC_FUNCTION_STARTS`: two foreign bytes became complete exact
// function-boundary evidence (`functionStartsExact=true`) for the selected slice.
//
// Fix: `js/macho.js::parseSlice()` validates every range against `sliceSize`
// with overflow-safe subtraction and records the per-command `valid` flag, and
// `analyzeSlice()` reads only through a slice-bounded `sliceRelativeRange()`
// gate. Out-of-slice authority fails closed (`functionStartsPartialReason =
// 'slice-out-of-range'`, `capped = true`), and thin images (slice == whole
// file) are unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const machoSrc = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseSlice } = globalThis.MachO;

const ARM64 = 0x0100000c;
const MH_EXECUTE = 2;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_FUNCTION_STARTS = 0x26;
const LC_DATA_IN_CODE = 0x29;
const LC_ENCRYPTION_INFO_64 = 0x2c;

const HEADER = 32;
const SLICE_OFFSET = 0x1000;
const SLICE_SIZE = 0x1000;

function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

function segment64(name = '__TEXT') {
  const b = new Uint8Array(72);
  const dv = view(b);
  dv.setUint32(0, LC_SEGMENT_64, true);
  dv.setUint32(4, 72, true);
  b.set(new TextEncoder().encode(name), 8); // within the 16-byte segname field
  dv.setBigUint64(24, 0x100000000n, true);   // vmaddr
  dv.setBigUint64(32, 0x1000n, true);        // vmsize
  dv.setBigUint64(40, 0n, true);             // fileoff (slice-relative)
  dv.setBigUint64(48, 0x1000n, true);        // filesize
  dv.setInt32(56, 7, true);                  // maxprot
  dv.setInt32(60, 5, true);                  // initprot (r-x)
  dv.setUint32(64, 0, true);                 // nsects
  dv.setUint32(68, 0, true);                 // flags
  return b;
}

function linkedit(cmd, dataoff, datasize) {
  const b = new Uint8Array(16);
  const dv = view(b);
  dv.setUint32(0, cmd, true);
  dv.setUint32(4, 16, true);
  dv.setUint32(8, dataoff, true);
  dv.setUint32(12, datasize, true);
  return b;
}

function symtab({ symoff, nsyms, stroff, strsize }) {
  const b = new Uint8Array(24);
  const dv = view(b);
  dv.setUint32(0, LC_SYMTAB, true);
  dv.setUint32(4, 24, true);
  dv.setUint32(8, symoff, true);
  dv.setUint32(12, nsyms, true);
  dv.setUint32(16, stroff, true);
  dv.setUint32(20, strsize, true);
  return b;
}

function dysymtab({ indirectsymoff, nindirectsyms }) {
  const b = new Uint8Array(80);
  const dv = view(b);
  dv.setUint32(0, LC_DYSYMTAB, true);
  dv.setUint32(4, 80, true);
  dv.setUint32(56, indirectsymoff, true);
  dv.setUint32(60, nindirectsyms, true);
  return b;
}

function encryption64(cryptoff, cryptsize, cryptid) {
  const b = new Uint8Array(24);
  const dv = view(b);
  dv.setUint32(0, LC_ENCRYPTION_INFO_64, true);
  dv.setUint32(4, 24, true);
  dv.setUint32(8, cryptoff, true);
  dv.setUint32(12, cryptsize, true);
  dv.setUint32(16, cryptid, true);
  return b;
}

/** A thin (header + load commands) Mach-O image of `fileSize` bytes. */
function thinImage(cmds, fileSize = SLICE_SIZE) {
  const sizeofcmds = cmds.reduce((total, cmd) => total + cmd.length, 0);
  const b = new Uint8Array(Math.max(fileSize, HEADER + sizeofcmds));
  const dv = view(b);
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, ARM64, true);
  dv.setInt32(8, 0, true);
  dv.setUint32(12, MH_EXECUTE, true);
  dv.setUint32(16, cmds.length, true);
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, 0, true);
  let p = HEADER;
  for (const cmd of cmds) { b.set(cmd, p); p += cmd.length; }
  return b;
}

/** A one-slice universal Mach-O whose slice A sits at SLICE_OFFSET. */
function fatWith(sliceImage) {
  const file = new Uint8Array(0x4000);
  const dv = view(file);
  dv.setUint32(0, FAT_MAGIC, false);
  dv.setUint32(4, 1, false);
  dv.setInt32(8, ARM64, false);
  dv.setInt32(12, 0, false);
  dv.setUint32(16, SLICE_OFFSET, false);
  dv.setUint32(20, SLICE_SIZE, false);
  dv.setUint32(24, 14, false);
  file.set(sliceImage, SLICE_OFFSET);
  return file;
}

/* ── parser: slice-relative range containment ───────────────────────── */

// (a) The issue's exact counterexample: dataoff=0x1800 with sliceSize=0x1000.
{
  const info = parseSlice(thinImage([segment64(), linkedit(LC_FUNCTION_STARTS, 0x1800, 2)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.functionStarts.valid, false);
  assert.ok(info.diagnostics.some((d) => d.includes('LC_FUNCTION_STARTS is outside the selected slice')));
}

// (b) A payload ending exactly at the slice end stays valid.
{
  const info = parseSlice(thinImage([segment64(), linkedit(LC_FUNCTION_STARTS, 0xffe, 2)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.functionStarts.valid, true);
  assert.ok(!info.diagnostics.some((d) => d.includes('LC_FUNCTION_STARTS')));
}

// (c) uint32 wrap must be rejected by the subtraction check, never clamped.
{
  const info = parseSlice(thinImage([segment64(), linkedit(LC_FUNCTION_STARTS, 0xfffffff0, 0x100)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.functionStarts.valid, false);
}

// (d) LC_SYMTAB: the symbol table itself crossing the slice end is invalid.
{
  const info = parseSlice(thinImage([segment64(), symtab({ symoff: 0xff0, nsyms: 2, stroff: 0xe00, strsize: 0x10 })]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.symtab.valid, false);
}

// (e) LC_SYMTAB: a symbol table inside the slice but a string table crossing it
// is still invalid — symbol names must not be read from outside the slice.
{
  const info = parseSlice(thinImage([segment64(), symtab({ symoff: 0xf00, nsyms: 4, stroff: 0xff8, strsize: 0x10 })]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.symtab.valid, false);
}

// (f) A fully in-slice LC_SYMTAB is still valid (no over-tightening).
{
  const info = parseSlice(thinImage([segment64(), symtab({ symoff: 0xe00, nsyms: 4, stroff: 0xf00, strsize: 0x20 })]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.symtab.valid, true);
}

// (g) LC_DYSYMTAB indirect symbol table is slice-bounded too.
{
  const info = parseSlice(thinImage([segment64(), dysymtab({ indirectsymoff: 0xff0, nindirectsyms: 8 })]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.dysymtab.valid, false);
}

// (h) LC_DATA_IN_CODE uses selected-slice bounds, not outer-container bounds.
{
  const info = parseSlice(thinImage([segment64(), linkedit(LC_DATA_IN_CODE, 0x1000, 8)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(info.dataInCode.valid, false);
}

// (i) An out-of-slice crypt range must not mint encryption evidence, even when
// cryptid says "encrypted". The in-slice case is unchanged.
{
  const out = parseSlice(thinImage([segment64(), encryption64(0x1800, 0x10, 1)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(out.encryption.valid, false);
  assert.equal(out.encrypted, false);

  const within = parseSlice(thinImage([segment64(), encryption64(0x800, 0x10, 1)]).buffer,
    SLICE_OFFSET, BigInt(SLICE_SIZE));
  assert.equal(within.encryption.valid, true);
  assert.equal(within.encrypted, true);
}

// (j) A thin Mach-O is its own slice: everything inside the file stays valid.
{
  const img = thinImage([
    segment64(),
    linkedit(LC_FUNCTION_STARTS, 0x100, 8),
    symtab({ symoff: 0x200, nsyms: 2, stroff: 0x300, strsize: 0x20 }),
  ]);
  const info = parseSlice(img.buffer, 0n, BigInt(img.byteLength));
  assert.equal(info.functionStarts.valid, true);
  assert.equal(info.symtab.valid, true);
  assert.ok(!info.diagnostics.some((d) => d.includes('outside the selected slice')));
}

/* ── worker: foreign bytes must not become exact slice evidence ──────── */

const { NodeBackend } = await import('./harness.mjs');

function fileShim(bytes, name) {
  return {
    name,
    size: bytes.length,
    slice(a, b) {
      const s = bytes.subarray(a, b);
      return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
  };
}

// (k) LC_FUNCTION_STARTS pointing past slice A at global 0x2800 = `04 00`
// (a valid `+4` ULEB terminator). Pre-fix this published `funcs=[0x100000004]`
// with `functionStartsExact=true` / `discoveryComplete=true`.
{
  const file = fatWith(thinImage([segment64(), linkedit(LC_FUNCTION_STARTS, 0x1800, 2)]));
  file[0x2800] = 0x04;
  file[0x2801] = 0x00;
  const backend = new NodeBackend();
  const opened = await backend.open(fileShim(file, 'foreign-function-starts'));
  assert.equal(opened.slices.length, 1);
  const res = await backend.analyze(0);
  assert.equal(res.funcs.length, 0, 'foreign bytes must not be published as function starts');
  assert.equal(res.functionStartsExact, false);
  assert.equal(res.discoveryComplete, false);
  assert.equal(res.functionDiscovery.complete, false);
  assert.deepEqual(Array.from(res.functionDiscovery.reasons),
    ['no-complete-lc-function-starts', 'function-starts:slice-out-of-range']);
  assert.equal(res.capped, true);
}

// (l) A symbol table pointing past slice A at global 0x2800 must not import the
// foreign symbol name (or make it available as function-boundary evidence).
{
  const file = fatWith(thinImage([
    segment64(),
    symtab({ symoff: 0x1800, nsyms: 1, stroff: 0x1810, strsize: 9 }),
  ]));
  const fdv = view(file);
  fdv.setUint32(0x2800, 1, true);      // n_strx = 1
  file[0x2804] = 0x0f;                 // N_SECT | N_EXT
  file[0x2805] = 1;                    // n_sect
  fdv.setBigUint64(0x2808, 0x100000004n, true); // n_value
  file.set(new TextEncoder().encode('\0_foreign\0'), 0x2810);
  const backend = new NodeBackend();
  const opened = await backend.open(fileShim(file, 'foreign-symtab'));
  assert.equal(opened.slices.length, 1);
  const res = await backend.analyze(0);
  assert.equal(res.names.includes('_foreign'), false, 'cross-slice symbol bytes must not create names');
  assert.equal(res.symbolCount, 0);
  assert.equal(res.capped, true);
}

console.log('issue #8835 legacy Mach-O slice-relative range containment: PASS');
