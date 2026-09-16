import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #8776: the legacy Mach-O parser built dylib install names with
// cstr() — one immutable concatenation per byte — over the WHOLE remainder
// of a structurally accepted LC_LOAD_DYLIB/LOAD_WEAK_DYLIB/REEXPORT_DYLIB
// command. A ~3 MiB admitted command retained >100 MiB of JS rope (32x) and
// aborted a 96 MiB worker INSIDE its own 4 MiB HEADER_MAX input cap.
// The fix validates the NUL terminator and the per-string + aggregate
// retained-name budgets BEFORE building the string, rejects unterminated
// names fail-closed, and reports capped load-command string metadata instead
// of laundering a prefix as full dylib identity.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const machoSrc = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseSlice } = globalThis.MachO;

const LC_LOAD_DYLIB = 0xc, LC_LOAD_WEAK_DYLIB = 0x18 | 0x80000000, LC_REEXPORT_DYLIB = 0x1f | 0x80000000;

function headerWith(commands) {
  let sizeofcmds = 0;
  for (const c of commands) sizeofcmds += c.length;
  const buf = new ArrayBuffer(32 + sizeofcmds);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, 0xfeedfacf, true);          // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);           // CPU_TYPE_ARM64
  dv.setInt32(8, 1, true);
  dv.setUint32(12, 2, true);                  // MH_EXECUTE
  dv.setUint32(16, commands.length, true);    // ncmds
  dv.setUint32(20, sizeofcmds, true);         // sizeofcmds
  dv.setUint32(24, 0, true);                  // flags
  let at = 32;
  for (const c of commands) { u8.set(c, at); at += c.length; }
  return { buf, u8, dv };
}

function dylibCommand(cmd, nameBytes) {
  const cmdsize = 24 + nameBytes.length + 1;
  const aligned = (cmdsize + 7) & ~7;
  const c = new Uint8Array(aligned);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, cmd >>> 0, true);
  dv.setUint32(4, aligned, true);
  dv.setUint32(8, 24, true);                  // name.off
  c.set(nameBytes, 24);                       // NUL-padded region stays 0
  return c;
}

const name = (text) => Buffer.from(text, 'latin1');

// --- ordinary install names across all three commands: unchanged semantics ---
{
  const { buf } = headerWith([
    dylibCommand(LC_LOAD_DYLIB, name('@rpath/libswiftCore.dylib')),
    dylibCommand(LC_LOAD_WEAK_DYLIB, name('/usr/lib/libSystem.B.dylib')),
    dylibCommand(LC_REEXPORT_DYLIB, name('@system/libobjc.A.dylib')),
  ]);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.deepEqual(info.dylibs,
    ['@rpath/libswiftCore.dylib', '/usr/lib/libSystem.B.dylib', '@system/libobjc.A.dylib'],
    'short names parse exactly as before');
  assert.equal(info.dylibCount, 3);
  assert.equal(info.loadCommandStringsCapped, false);
}

// --- a long admitted name keeps FULL identity (no prefix laundering) ---
{
  const long = 'L'.repeat(200 * 1024);        // inside the 256 KiB per-string ceiling
  const { buf } = headerWith([dylibCommand(LC_LOAD_DYLIB, name(long))]);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.dylibs.length, 1);
  assert.equal(info.dylibs[0], long, 'an admitted 200 KiB name is byte-exact and complete');
  assert.equal(info.loadCommandStringsCapped, false);
}

// --- a hostile oversize name is refused BEFORE construction, marked capped ---
{
  const huge = Buffer.alloc(300 * 1024, 0x41);
  const { buf } = headerWith([dylibCommand(LC_LOAD_DYLIB, huge)]);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.dylibs.length, 0, 'a name beyond the per-string budget must not be admitted at all');
  assert.equal(info.loadCommandStringsCapped, true);
  assert.equal(info.loadCommandStringsReason, 'lc-name-budget');
  assert.ok(info.diagnostics.includes('dylib install name exceeds the decoded-name budget'));
}

// --- aggregate budget: valid names admitted until retention runs out ---
{
  const one = 'D'.repeat(120 * 1024);         // 1 MiB aggregate admits 8, refuses the 9th
  const cmds = [];
  for (let i = 0; i < 9; i++) cmds.push(dylibCommand(LC_LOAD_DYLIB, Buffer.from(one + i, 'latin1')));
  const { buf } = headerWith(cmds);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.dylibs.length, 8, 'aggregate retained-name budget caps admitted names');
  assert.ok(info.dylibs.every((d, i) => d === one + i), 'admitted names stay complete');
  assert.equal(info.loadCommandStringsCapped, true);
}

// --- unterminated names fail closed WITHOUT claiming resource exhaustion ---
{
  const unterminated = new Uint8Array(96);   // name spans to the command end: no NUL at all
  const udv = new DataView(unterminated.buffer);
  udv.setUint32(0, LC_LOAD_DYLIB >>> 0, true);
  udv.setUint32(4, 96, true);
  udv.setUint32(8, 24, true);
  unterminated.fill(0x41, 24, 96);
  const { buf } = headerWith([unterminated]);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.dylibs.length, 0, 'unterminated name is rejected, not prefix-washed');
  assert.equal(info.loadCommandStringsCapped, false, 'a malformed name is not a budget event');
  assert.ok(info.diagnostics.includes('unterminated dylib install name'));
}

// --- 16-byte segment/section-name semantics are untouched ------------------
{
  const seg = new Uint8Array(72 + 80);        // LC_SEGMENT_64 with one section
  const dv = new DataView(seg.buffer);
  dv.setUint32(0, 0x19, true); dv.setUint32(4, seg.length, true);
  dv.setUint32(8, 1, true);                   // nsects = 1
  seg.set(Buffer.from('__TEXTXXXXXX1234', 'latin1').subarray(0, 16), 8); // no NUL in 16
  const secName = Buffer.from('__instXXXXXX1234', 'latin1').subarray(0, 16);
  seg.set(secName, 72);
  seg.set(Buffer.from('__TEXTXXXXXX1234', 'latin1').subarray(0, 16), 72 + 16);
  const { buf } = headerWith([seg]);
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.segments[0].name, '__TEXTXXXXXX1234', 'fixed 16-byte names keep prefix semantics');
  assert.equal(info.loadCommandStringsCapped, false);
}

// --- hostile ~2 MiB command survives a 64 MiB child heap (base aborts) -----
{
  const child = spawnSync(process.execPath,
    ['--max-old-space-size=64', '-e', `
      const fs = require('node:fs');
      const src = fs.readFileSync(${JSON.stringify(path.join(root, 'js/macho.js'))}, 'utf8');
      new Function('root', src)(globalThis);
      const nameBytes = 2 * 1024 * 1024;
      const cmdsize = 24 + nameBytes + 1;
      const aligned = (cmdsize + 7) & ~7;
      const cmd = new Uint8Array(aligned);
      const cdv = new DataView(cmd.buffer);
      cdv.setUint32(0, 0xc, true); cdv.setUint32(4, aligned, true); cdv.setUint32(8, 24, true);
      cmd.fill(0x41, 24, 24 + nameBytes);
      const buf = new ArrayBuffer(32 + aligned);
      const dv = new DataView(buf);
      new Uint8Array(buf).set(cmd, 32);
      dv.setUint32(0, 0xfeedfacf, true);
      dv.setInt32(4, 0x0100000c, true);
      dv.setUint32(12, 2, true);
      dv.setUint32(16, 1, true);
      dv.setUint32(20, aligned, true);
      const info = globalThis.MachO.parseSlice(buf, 0n, BigInt(buf.byteLength));
      if (!info.loadCommandStringsCapped || info.dylibs.length !== 0) {
        console.error('missing bounded rejection'); process.exit(2);
      }
      process.exit(0);
    `], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  assert.equal(child.status, 0,
    `2 MiB dylib-name command must survive a 64 MiB heap (exit=${child.status} err=${String(child.stderr).slice(0, 200)})`);
}

console.log('issue #8776 legacy Mach-O dylib install-name budget: PASS');
