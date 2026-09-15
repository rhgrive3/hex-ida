import test from 'node:test';
import assert from 'node:assert/strict';
import { openBinarySource } from '../../js/binary/source-loaders.js';
import { MemoryByteSource } from '../../js/binary/source.js';
import { SparseByteBuffer } from '../../js/binary/source-reader.js';
import { parseMachO } from '../../js/binary/macho.js';

// #8651: `parseSymbolTable()` tested each symbol name for NUL termination with
// `bytes.subarray(strx, strsize).indexOf(0)`, and read the name with
// `cstring(strx, strsize - strx)`. On a sparse (source-backed) byte buffer both
// materialize the whole remaining string table, once per symbol — O(nsyms x
// strsize) — so a few-MiB file drove hundreds of MiB to multiple GiB of
// `subarray` copy while the final snapshot still reported `complete:true`.
// `findZero` + `decodeString` bound the termination scan to a read-ahead window
// and decode exactly the located span, so materialization is independent of the
// string-table size and stays near the resident cost.

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_OBJECT = 1;
const LC_SYMTAB = 2;
const HEADER = 32;
const SYMTAB_CMD = 24;
const NLIST_64 = 16;
const MiB = 1 << 20;

function buildMachO(nsyms, strsize) {
  const symoff = HEADER + SYMTAB_CMD;
  const stroff = symoff + nsyms * NLIST_64;
  const bytes = new Uint8Array(stroff + strsize);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, MH_MAGIC_64, true);
  dv.setUint32(4, CPU_TYPE_ARM64, true);
  dv.setUint32(8, 0, true);
  dv.setUint32(12, MH_OBJECT, true);
  dv.setUint32(16, 1, true);
  dv.setUint32(20, SYMTAB_CMD, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(HEADER + 0, LC_SYMTAB, true);
  dv.setUint32(HEADER + 4, SYMTAB_CMD, true);
  dv.setUint32(HEADER + 8, symoff, true);
  dv.setUint32(HEADER + 12, nsyms, true);
  dv.setUint32(HEADER + 16, stroff, true);
  dv.setUint32(HEADER + 20, strsize, true);
  // Pack every short name at the start of the table; pad the rest so the tail
  // stays unterminated-by-design until the final sentinel NUL.
  let o = stroff;
  const nameOffsets = [];
  for (let i = 0; i < nsyms; i++) {
    nameOffsets.push(o - stroff);
    for (const ch of `_s${i}\0`) bytes[o++] = ch.charCodeAt(0);
  }
  for (; o < stroff + strsize - 1; o++) bytes[o] = 0x61; // 'a'
  bytes[stroff + strsize - 1] = 0;
  for (let i = 0; i < nsyms; i++) {
    const p = symoff + i * NLIST_64;
    dv.setUint32(p, nameOffsets[i], true); // n_strx
    bytes[p + 4] = 0;                       // n_type (regular, non-stab)
    bytes[p + 5] = 0;                       // n_sect
    dv.setUint16(p + 6, 0, true);           // n_desc
    dv.setBigUint64(p + 8, 0n, true);       // n_value
  }
  return bytes;
}

function materializeBytesFor(parseFn) {
  return async (bytes) => {
    let requested = 0;
    const original = SparseByteBuffer.prototype.subarray;
    SparseByteBuffer.prototype.subarray = function (start, end = this.size) {
      const s = BigInt(start);
      const e = end === undefined ? this.size : BigInt(end);
      if (e > s) requested += Number(e - s);
      return original.call(this, start, end);
    };
    try {
      return { image: await parseFn(bytes), requested };
    } finally {
      SparseByteBuffer.prototype.subarray = original;
    }
  };
}

async function sourceMaterialized(bytes) {
  const measure = materializeBytesFor((b) => openBinarySource(new MemoryByteSource(b)));
  const { image, requested } = await measure(bytes);
  return { requested, image };
}

test('sparse symbol-table parse materializes a bounded, string-size-independent span (#8651)', async () => {
  const small = buildMachO(256, 1 * MiB);
  const large = buildMachO(256, 8 * MiB);

  const a = await sourceMaterialized(small);
  const b = await sourceMaterialized(large);

  // Correctness first: the source-backed result must equal the resident result.
  for (const [bytes, res] of [[small, a], [large, b]]) {
    const resident = parseMachO(bytes);
    assert.equal(res.image.metadata.machoMetadata.complete, true);
    assert.equal(res.image.symbols.length, resident.symbols.length);
    assert.deepEqual(
      res.image.symbols.map((s) => s.name),
      resident.symbols.map((s) => s.name),
    );
  }

  // The old code amplified with the string table: nsyms x strsize copies meant
  // ~320 MiB for the 1 MiB table and ~2.1 GiB for the 8 MiB table. Now the
  // termination scan + decode are independent of strsize and bounded near the
  // resident working set.
  assert.ok(a.requested < 8 * MiB, `1 MiB table materialized ${a.requested} bytes`);
  assert.ok(b.requested < 8 * MiB, `8 MiB table materialized ${b.requested} bytes`);
  assert.ok(
    b.requested <= a.requested + 1 * MiB,
    `materialization scaled with string-table size: ${a.requested} -> ${b.requested}`,
  );
});

test('resident Mach-O symbol names stay byte-identical to the sparse path (#8651)', async () => {
  const bytes = buildMachO(40, 64 * 1024);
  const resident = parseMachO(bytes);
  const { image } = await sourceMaterialized(bytes);
  assert.deepEqual(
    image.symbols.map((s) => `${s.name}:${s.address}`),
    resident.symbols.map((s) => `${s.name}:${s.address}`),
  );
});
