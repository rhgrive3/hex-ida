// Issue #8800 regression: js/macho.js::stubSymbols() expanded the indirect
// symbol table independently for every stub/pointer section with only a
// per-section bound. Many sections may reuse the same reserved1 indirect window,
// so a 200 KiB table plus 35 pointer-section descriptors fanned out into
// ~1.75M mapping objects — past the caller's own caps — before analyzeSlice()
// could sort/dedup, OOMing a 128 MiB worker heap. The helper now validates each
// section's indirect interval against the loaded table and charges one shared
// STUB_SYMBOLS_MAX output budget across all sections, marking the result
// truncated so the caller records capped/incomplete symbol discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const machoFile = path.join(root, 'js/macho.js');
const context = {};
const vm = await import('node:vm');
vm.createContext(context);
vm.runInContext(fs.readFileSync(machoFile, 'utf8'), context, { filename: 'js/macho.js' });
const { stubSymbols } = context.MachO;

const STUB_SYMBOLS_MAX = 200_000;

function indirect(count, value = 10) {
  const bytes = new Uint8Array(count * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) dv.setUint32(i * 4, value, true);
  return bytes;
}
function symTable() {
  const sym = { names: [] };
  sym.names[10] = '_foo';
  return sym;
}
function sections(n, tableCount) {
  const secs = [];
  for (let i = 0; i < n; i++) {
    secs.push({ pointers: true, stubs: false, reserved1: 0, addr: BigInt(0x2000 + i * 0x100000), size: BigInt(tableCount * 8) });
  }
  return { pointerBits: 64, segments: [{ sections: secs }] };
}
const norm = (entries) => Array.from(entries, (e) => ({ addr: e.addr.toString(16), name: e.name, stub: e.stub }));

// --- single small sections preserve exact names/addresses, not truncated (#3615-style).
{
  const ind = new Uint8Array(12);
  const dv = new DataView(ind.buffer);
  dv.setUint32(0, 10, true); dv.setUint32(4, 11, true);
  const sym = { names: [] }; sym.names[10] = '_foo'; sym.names[11] = '_bar';
  const info = { pointerBits: 64, segments: [{ sections: [{ pointers: true, stubs: false, reserved1: 0, addr: 0x3000n, size: 16n }] }] };
  const entries = stubSymbols(info, ind, sym);
  assert.deepEqual(norm(entries), [
    { addr: '3000', name: '_foo', stub: false },
    { addr: '3008', name: '_bar', stub: false },
  ]);
  assert.equal(entries.truncated, false);
}

// --- a section whose indirect window starts outside the loaded table is skipped.
{
  const ind = new Uint8Array(8);
  const sym = { names: [] }; sym.names[0] = '_x';
  const info = { pointerBits: 64, segments: [{ sections: [{ pointers: true, stubs: false, reserved1: 5, addr: 0x1000n, size: 40n }] }] };
  assert.deepEqual(norm(stubSymbols(info, ind, sym)), [], 'reserved1 beyond the table must emit nothing');
}

// --- 35 sections reusing one 50,000-entry indirect window cannot exceed the shared budget.
{
  const tableCount = 50_000;
  const naive = 35 * tableCount;               // ~1.75M — the pre-fix product
  assert.ok(naive > STUB_SYMBOLS_MAX);
  const entries = stubSymbols(sections(35, tableCount), indirect(tableCount), symTable());
  assert.ok(entries.length <= STUB_SYMBOLS_MAX, `output must be capped: got ${entries.length}`);
  assert.equal(entries.length, STUB_SYMBOLS_MAX, 'shared cross-section budget is reached before over-allocating');
  assert.equal(entries.truncated, true, 'capped expansion must be marked truncated');
}

// --- a 128 MiB old-space child process cannot be OOMed by the 35-section fixture.
{
  const script = `
    const fs = require('fs'), vm = require('vm');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(${JSON.stringify(machoFile)}, 'utf8'), ctx, { filename: 'js/macho.js' });
    const tableCount = 50000;
    const ind = new Uint8Array(tableCount * 4);
    new DataView(ind.buffer); const dv = new DataView(ind.buffer);
    for (let i = 0; i < tableCount; i++) dv.setUint32(i * 4, 10, true);
    const sym = { names: [] }; sym.names[10] = '_foo';
    const secs = [];
    for (let i = 0; i < 35; i++) secs.push({ pointers: true, stubs: false, reserved1: 0, addr: BigInt(0x2000 + i * 0x100000), size: BigInt(tableCount * 8) });
    const e = ctx.MachO.stubSymbols({ pointerBits: 64, segments: [{ sections: secs }] }, ind, sym);
    if (e.length > 200000) { console.error('UNBOUNDED ' + e.length); process.exit(2); }
    console.log('OK ' + e.length + ' ' + e.truncated);
  `;
  const stdout = execFileSync(process.execPath, ['--max-old-space-size=128', '-e', script], { encoding: 'utf8' });
  assert.match(stdout, /^OK \d+ true$/m, `child heap must not OOM: ${stdout}`);
}

console.log('issue #8800 indirect-stub-symbols aggregate-budget regressions: PASS');
