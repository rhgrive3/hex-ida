import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import url from 'node:url';

// Issue #5372: worker analyzeSlice() clamps the Mach-O string table to
// STRTAB_MAX (48 MiB) but never raised `capped` for that truncation. Symbols
// whose n_strx pointed past the clamp parsed as '' and were silently dropped
// by definedSymbols(), while the result still reported capped:false — a
// silently incomplete symbol view.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
if (!fs.existsSync(path.join(root, 'js/macho.js'))) throw new Error('bad root: ' + root);

const context = vm.createContext({
  console, performance, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
  BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
  BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
  String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  setTimeout, clearTimeout,
});
context.self = context;
context.globalThis = context;
context.self.postMessage = () => {};
context.importScripts = () => {};
for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/worker-legacy.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

// Build a 64-bit Mach-O arm64 slice whose LC_SYMTAB declares one symbol with
// n_strx pointing past STRTAB_MAX. symoff/stroff are relative to the slice
// base; the fake file is sparse via the sliced-block reader below.
const STRTAB_MAX = 48 * 1024 * 1024;
const fileBytes = new Uint8Array(0x2000);
const dv = new DataView(fileBytes.buffer);
fileBytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
dv.setUint32(4, 0x0100000c, true); // arm64
dv.setUint32(16, 0, true);         // ncmds filled by the harness message path
// The harness below drives analyzeSlice() through slice.info, so no load
// commands are needed: info.symtab is provided directly.

const SYM_PTR_FAR = STRTAB_MAX + 8;  // n_strx beyond the clamp
const SYM_NEAR = 12;

function messageResult(infoPatch, bytes) {
  context.__info = infoPatch;
  context.__bytes = bytes;
  return vm.runInContext(`(async () => {
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    regions = new Map();
    slices = [{ regions: [], functionStarts: [], info: __info, offset: 0n }];
    currentEpoch = 0;
    return analyzeSlice({ sliceIndex: 0, id: null });
  })()`, context);
}

// One N_SECT|N_EXT symbol whose name offset is inside the table: parses fine.
{
  const info = {
    is64: true,
    symtab: { nsyms: 1, symoff: 0x100, stroff: 0x140, strsize: 32 },
  };
  const bytes = new Uint8Array(0x200);
  const sv = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  sv.setUint32(0x100, SYM_NEAR, true); // n_strx
  bytes[0x104] = 0x0f; bytes[0x105] = 1; // N_SECT|N_EXT, n_sect
  sv.setBigUint64(0x108, 0x1000n, true);
  bytes.set(Buffer.from('_near\0'), 0x140 + SYM_NEAR); // name at stroff + n_strx
  const result = await messageResult(info, bytes);
  assert.equal(result.capped, false, 'an in-bounds string table is not capped');
  assert.ok(result.names.includes('_near'), `near symbol survives (names: ${JSON.stringify(result.names)})`);
}

// One symbol whose n_strx lands beyond the 48 MiB clamp.
{
  const info = {
    is64: true,
    symtab: { nsyms: 1, symoff: 0x100, stroff: 0x140, strsize: STRTAB_MAX + 64 },
  };
  const bytes = new Uint8Array(0x200);
  const sv = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  sv.setUint32(0x100, SYM_PTR_FAR, true); // n_strx past STRTAB_MAX
  bytes[0x104] = 0x0f; bytes[0x105] = 1;
  sv.setBigUint64(0x108, 0x1000n, true);
  bytes.set(Buffer.from('_far_symbol_name\0'), 0x160); // the real name inside the declared table
  const result = await messageResult(info, bytes);
  assert.equal(result.capped, true,
    'a declared string table beyond STRTAB_MAX must mark the result capped');
}

console.log('issue #5372 analyzeSlice string-table clamp capped-flag regression: PASS');
