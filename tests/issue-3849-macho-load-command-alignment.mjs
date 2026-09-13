// Regression for #3849: js/macho.js::parseSlice() validated only that a load
// command's cmdsize was >= 8 and stayed inside the load-command area. The Mach-O
// ABI additionally requires cmdsize to be a multiple of 4 (32-bit) or 8 (64-bit).
// Without that check a malformed stream was published as a clean parse, the next
// command offset became unaligned, and bytes after the real command could be
// re-interpreted as another command. Alignment is now part of the structural
// contract and a violation stops the stream (fail closed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadMachO() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  vm.runInContext(fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8'), context, { filename: 'js/macho.js' });
  return context.MachO;
}

const MachO = loadMachO();
const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC_32 = 0xfeedface;
const CPU_ARM64 = 0x0100000c;
const CPU_X86 = 7;

// Build a thin Mach-O whose load-command area is the concatenation of `commands`.
function buildThin({ is64, commands, trailing = 0 }) {
  const headerSize = is64 ? 32 : 28;
  const sizeofcmds = commands.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(headerSize + sizeofcmds + trailing);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, is64 ? MH_MAGIC_64 : MH_MAGIC_32, true);
  dv.setInt32(4, is64 ? CPU_ARM64 : CPU_X86, true);
  dv.setInt32(8, 0, true);
  dv.setUint32(12, 2, true);           // MH_EXECUTE
  dv.setUint32(16, commands.length, true);
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, 0, true);
  let at = headerSize;
  for (const c of commands) { buf.set(c, at); at += c.length; }
  return buf;
}

// LC_UUID is ABI-minimum 24 bytes; extra bytes make it deliberately misaligned.
function uuidCommand(cmdsize) {
  const c = new Uint8Array(cmdsize);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, 0x1b, true);         // LC_UUID
  dv.setUint32(4, cmdsize, true);
  for (let i = 8; i < Math.min(cmdsize, 24); i++) c[i] = 0xa0 + i;
  return c;
}

function unknownCommand(cmd, cmdsize) {
  const c = new Uint8Array(cmdsize);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, cmd, true);
  dv.setUint32(4, cmdsize, true);
  return c;
}

function parse(buf) {
  return MachO.parseSlice(buf.buffer, 0, buf.length);
}

// 1. 64-bit LC_UUID with the ABI cmdsize 24 is a clean parse.
{
  const info = parse(buildThin({ is64: true, commands: [uuidCommand(24)] }));
  assert.equal(info.diagnostics.length, 0, 'aligned cmdsize must not warn');
  assert.equal(info.commands.length, 1);
  assert.equal(info.uuid != null, true);
}

// 2. 64-bit LC_UUID with cmdsize 25 violates 8-byte alignment.
{
  const info = parse(buildThin({ is64: true, commands: [uuidCommand(25)] }));
  assert.equal(info.diagnostics.some((d) => /alignment/i.test(d)), true,
    'misaligned 64-bit cmdsize must be reported as malformed');
}

// 3. An unknown 64-bit command with cmdsize 16 is aligned and may be skipped.
{
  const info = parse(buildThin({ is64: true, commands: [unknownCommand(0x7ffffffe, 16)] }));
  assert.equal(info.diagnostics.length, 0);
  assert.equal(info.commands.length, 1);
}

// 4. An unknown 64-bit command with cmdsize 12 violates 8-byte alignment.
{
  const info = parse(buildThin({ is64: true, commands: [unknownCommand(0x7ffffffe, 12)] }));
  assert.equal(info.diagnostics.some((d) => /alignment/i.test(d)), true);
}

// 5. 32-bit command with cmdsize 12 is aligned and valid.
{
  const info = parse(buildThin({ is64: false, commands: [unknownCommand(0x7ffffffe, 12)] }));
  assert.equal(info.diagnostics.length, 0);
  assert.equal(info.commands.length, 1);
}

// 6. 32-bit command with cmdsize 10 violates 4-byte alignment.
{
  const info = parse(buildThin({ is64: false, commands: [unknownCommand(0x7ffffffe, 10)] }));
  assert.equal(info.diagnostics.some((d) => /alignment/i.test(d)), true);
}

// 7. A misaligned first command must stop the stream: a structurally valid
//    "command" planted immediately after it must not be parsed as a second one.
{
  const misaligned = uuidCommand(25);
  const planted = uuidCommand(24);
  const info = parse(buildThin({ is64: true, commands: [misaligned, planted] }));
  const plantedUuid = info.commands.filter((c) => c.cmd === 0x1b && c.size === 24);
  assert.equal(plantedUuid.length, 0,
    'scanning must stop at the misaligned command instead of reading from an unaligned offset');
  assert.equal(info.diagnostics.some((d) => /alignment/i.test(d)), true);
}

// 8. Existing bounds/minimum-size validation still regresses the same way.
{
  const info = parse(buildThin({ is64: true, commands: [uuidCommand(8)] }));
  assert.equal(info.diagnostics.some((d) => /shorter than ABI minimum/i.test(d)), true);
}

console.log('issue #3849 Mach-O load-command alignment regression passed');
