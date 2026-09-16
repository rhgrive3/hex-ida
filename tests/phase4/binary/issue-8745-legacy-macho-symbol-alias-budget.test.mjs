import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #8745: legacy MachO.parseSymbols() resolved every nlist row through
// a char-by-char cstrNul(). Hundreds of aliases of one 65,535-byte string
// re-built (and rope-retained) the name per row: 67 KiB of metadata held
// ~214 MiB of heap and aborted V8 at 64/128/192 MiB old-space limits. The fix
// decodes each distinct n_strx once, charges retained unique bytes (+ row
// overhead) to an aggregate budget BEFORE building the string, never
// shortens an admitted name (#3806), and reports `capped` explicitly.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const machoSrc = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseSymbols, definedSymbols } = globalThis.MachO;

function buildTable(rows, strings) {
  // strings: array of { strx, text } laid into one table; rows: array of strx.
  let table = new Uint8Array(1); // offset 0 = empty name slot
  const at = new Map();
  for (const s of strings) {
    const enc = Buffer.from(s.text, 'latin1');
    const need = s.strx + enc.length + 1;
    if (need > table.length) { const g = new Uint8Array(need); g.set(table); table = g; }
    table.set(enc, s.strx); table[s.strx + enc.length] = 0;
    at.set(s.strx, s.text);
  }
  const sym = new Uint8Array(rows.length * 16);
  const dv = new DataView(sym.buffer);
  rows.forEach((strx, i) => {
    const o = i * 16;
    dv.setUint32(o, strx, true);
    sym[o + 4] = 0x0f; sym[o + 5] = 1;                 // N_SECT|N_EXT, section 1
    dv.setBigUint64(o + 8, 0x1000n + BigInt(i * 4), true);
  });
  return { sym, table };
}

const LONG = '_$s' + 'A'.repeat(65535 - 3);
const ROW_OVERHEAD = 64;

// --- alias flood: 100 references to ONE name admit as ONE decoded entry ---
{
  const { sym, table } = buildTable(Array(100).fill(1), [{ strx: 1, text: LONG }]);
  // Budget of exactly one unique name + one row only fits when the shared
  // n_strx is decoded (and charged) once, not once per aliasing row.
  const out = parseSymbols(sym, table, true, { maxDecodedBytes: LONG.length + ROW_OVERHEAD });
  assert.equal(out.capped, false, '100 aliases of one name must not exhaust a one-name budget');
  assert.equal(out.names.length, 100);
  for (const name of out.names) assert.equal(name, LONG, 'every alias keeps the full name');
  assert.equal(definedSymbols(out).length, 100, 'downstream symbol view unchanged');
}

// --- budget is charged before materializing the refused name, not after ---
{
  const a = 'A'.repeat(1000);
  const b = 'B'.repeat(1000);
  const { sym, table } = buildTable([1, 1002], [{ strx: 1, text: a }, { strx: 1002, text: b }]);
  // Space for exactly the first unique name; the second must be REFUSED
  // whole (empty), never admitted as a prefix.
  const out = parseSymbols(sym, table, true, { maxDecodedBytes: 1000 + ROW_OVERHEAD });
  assert.equal(out.capped, true, 'a second distinct name beyond the budget reports capped');
  assert.equal(out.truncationReason, 'decoded-name-budget');
  assert.equal(out.names[0], a, 'names admitted within budget keep full identity');
  assert.equal(out.names[1], '', 'the budget-refused name fails closed, not as a prefix');
}

// --- malformed names are not resource rejections ---
{
  const table = new Uint8Array(8);
  table.set([1, 2, 3, 4, 5, 6, 7, 8], 0);              // no NUL anywhere
  const sym = new Uint8Array(16);
  const dv = new DataView(sym.buffer);
  dv.setUint32(0, 1, true); dv.setBigUint64(8, 0x1000n, true);
  const out = parseSymbols(sym, table, true, { maxDecodedBytes: 1 << 20 });
  assert.equal(out.names[0], '', 'unterminated entry stays fail-closed');
  assert.equal(out.capped, false, 'a malformed name is not a budget exhaustion');
}
{
  const sym = new Uint8Array(16);
  const dv = new DataView(sym.buffer);
  dv.setUint32(0, 9999, true);
  const out = parseSymbols(sym, new Uint8Array(8), true, { maxDecodedBytes: 1 << 20 });
  assert.equal(out.names[0], '', 'out-of-range strx stays fail-closed');
  assert.equal(out.capped, false);
}

// --- #3806 identity survives: long single name, default budget, exactness ---
{
  const { sym, table } = buildTable([1], [{ strx: 1, text: LONG }]);
  const out = parseSymbols(sym, table, true);
  assert.equal(out.names[0], LONG, 'default budget preserves the full 65,535-byte name');
  assert.equal(out.capped, false);
}

// --- hostile alias flood survives a 64 MiB child heap (base aborts at 192) ---
{
  const child = spawnSync(process.execPath,
    ['--max-old-space-size=64', '-e', `
      const fs = require('node:fs');
      const src = fs.readFileSync(${JSON.stringify(path.join(root, 'js/macho.js'))}, 'utf8');
      new Function('root', src)(globalThis);
      const n = 100;
      const sym = new Uint8Array(n * 16);
      const dv = new DataView(sym.buffer);
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        dv.setUint32(o, 1, true);                      // every n_strx -> offset 1
        sym[o + 4] = 0x0f; sym[o + 5] = 1;
        dv.setBigUint64(o + 8, 0x1000n + BigInt(i * 4), true);
      }
      const str = new Uint8Array(65537);
      str[0] = 0; str.fill(0x41, 1, 65536); str[65536] = 0;
      const out = globalThis.MachO.parseSymbols(sym, str, true);
      if (out.capped) { console.error('unexpected capped'); process.exit(2); }
      if (out.names.length !== n || out.names.some((x) => x.length !== 65535)) {
        console.error('identity broken'); process.exit(3);
      }
      process.exit(0);
    `], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  assert.equal(child.status, 0,
    `100-alias 65,535-byte flood must survive a 64 MiB heap (exit=${child.status} err=${String(child.stderr).slice(0, 200)})`);
}

// --- worker analyzeSlice propagates sym.capped to the result capped flag ---
{
  const vm = await import('node:vm');
  const context = vm.createContext({
    console, performance, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
    BigUint64Array, BigInt64Array, DataView, ArrayBuffer, SharedArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout, Function, Symbol, Reflect, Proxy,
  });
  context.self = context;
  context.globalThis = context;
  context.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/worker-legacy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  // Deterministic stand-in for a budget-exhausted parse: the worker must
  // surface it as capped rather than a silently short symbol view.
  vm.runInContext(`
    MachO.parseSymbols = function (symBuf, strBuf) {
      const n = Math.floor(symBuf.length / 16);
      const out = { names: new Array(n).fill(''), values: new BigUint64Array(n),
        types: new Uint8Array(n), sects: new Uint8Array(n) };
      Object.defineProperty(out, 'capped', { value: true, enumerable: false });
      return out;
    };
  `, context);
  const bytes = new Uint8Array(0x200);
  const result = await vm.runInContext(`(async () => {
    blocks.clear();
    fileSize = BigInt(${bytes.length});
    file = { size: ${bytes.length}, slice(start, end) {
      const copy = new Uint8Array(${bytes.buffer.byteLength}).slice(Number(start), Number(end));
      return { arrayBuffer: async () => copy.buffer };
    } };
    regions = new Map();
    slices = [{ regions: [], functionStarts: [], info: {
      is64: true, magic64: true, ncmds: 1,
      symtab: { nsyms: 2, symoff: 0x100, stroff: 0x140, strsize: 32 },
    }, offset: 0n }];
    currentEpoch = 0;
    return analyzeSlice({ sliceIndex: 0, id: null });
  })()`, context);
  assert.equal(result.capped, true, 'a capped symbol parse must raise the worker capped report (#8745)');
}

console.log('issue #8745 legacy Mach-O decoded-name budget + alias reuse: PASS');
