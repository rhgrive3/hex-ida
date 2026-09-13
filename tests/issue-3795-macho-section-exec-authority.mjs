// Regression for #3795: js/macho.js::parseSlice() collapsed two independent
// Mach-O facts into one section `exec` bit: "the parent segment is VM-executable"
// and "this section should be analyzed as instructions". Because it accepted the
// parent segment's initprot execute bit alone, data sections inside an RX __TEXT
// (__cstring, __const, ...) were published as executable regions and were handed
// to function discovery / program scanning, where string bytes were decoded as
// instructions and consumed the shared analysis budget. Section code authority now
// requires section-level evidence (instruction attributes or a stub section), while
// the parent segment's execute permission remains available separately.
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

const S_REGULAR = 0x0;
const S_CSTRING_LITERALS = 0x2;
const S_SYMBOL_STUBS = 0x8;
const S_ATTR_SOME_INSTRUCTIONS = 0x400;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const VM_PROT_READ = 1, VM_PROT_WRITE = 2, VM_PROT_EXECUTE = 4;

function buildThin() {
  const bytes = new Uint8Array(0x2000);
  const dv = new DataView(bytes.buffer);
  const u32 = (o, v) => dv.setUint32(o, v, true);
  const i32 = (o, v) => dv.setInt32(o, v, true);
  const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const put = (o, s, n = 16) => { bytes.set(Buffer.alloc(n), o); bytes.set(Buffer.from(s), o); };

  u32(0, 0xfeedfacf);            // MH_MAGIC_64
  i32(4, 0x0100000c);            // CPU_TYPE_ARM64
  i32(8, 0);
  u32(12, 2);                    // MH_EXECUTE
  u32(16, 2);                    // ncmds
  const textCmd = 72 + 3 * 80;
  const dataCmd = 72 + 1 * 80;
  u32(20, textCmd + dataCmd);
  u32(24, 0); u32(28, 0);

  let p = 32;
  // LC_SEGMENT_64 __TEXT: RX, holds __text, __cstring and __const.
  u32(p, 0x19); u32(p + 4, textCmd); put(p + 8, '__TEXT');
  u64(p + 24, 0x0); u64(p + 32, 0x1000); u64(p + 40, 0x0); u64(p + 48, 0x1000);
  i32(p + 56, VM_PROT_READ | VM_PROT_EXECUTE);
  i32(p + 60, VM_PROT_READ | VM_PROT_EXECUTE);
  u32(p + 64, 3); u32(p + 68, 0);
  const section = (so, name, seg, addr, size, offset, flags) => {
    put(so, name); put(so + 16, seg);
    u64(so + 32, addr); u64(so + 40, size);
    u32(so + 48, offset); u32(so + 52, 2); u32(so + 56, 0); u32(so + 60, 0);
    u32(so + 64, flags); u32(so + 68, 0); u32(so + 72, 0); u32(so + 76, 0);
  };
  section(p + 72, '__text', '__TEXT', 0x400, 0x100, 0x400, S_REGULAR | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS);
  section(p + 152, '__cstring', '__TEXT', 0x500, 0x100, 0x500, S_CSTRING_LITERALS);
  section(p + 232, '__const', '__TEXT', 0x600, 0x100, 0x600, S_REGULAR);
  p += textCmd;

  // LC_SEGMENT_64 __DATA: RW (not executable) but a section carries instruction
  // attributes; VM permission must still win and keep it out of code scanning.
  u32(p, 0x19); u32(p + 4, dataCmd); put(p + 8, '__DATA');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000); u64(p + 40, 0x1000); u64(p + 48, 0x1000);
  i32(p + 56, VM_PROT_READ | VM_PROT_WRITE);
  i32(p + 60, VM_PROT_READ | VM_PROT_WRITE);
  u32(p + 64, 1); u32(p + 68, 0);
  section(p + 72, '__data', '__DATA', 0x1000, 0x100, 0x1000, S_REGULAR | S_ATTR_PURE_INSTRUCTIONS);
  return bytes;
}

const bytes = buildThin();
const info = MachO.parseSlice(bytes.buffer, 0, bytes.length);
const text = info.segments.find((s) => s.name === '__TEXT');
const byName = new Map(text.sections.map((s) => [s.name, s]));

// 1. A real instruction section stays a code/exec region.
{
  const s = byName.get('__text');
  assert.equal(s.code, true);
  assert.equal(s.vmExec, true);
  assert.equal(s.exec, true);
}

// 2. Data sections inside the same RX segment are not code regions.
for (const name of ['__cstring', '__const']) {
  const s = byName.get(name);
  assert.equal(s.vmExec, true, `${name} is inside an RX segment`);
  assert.equal(s.code, false, `${name} has no instruction-section evidence`);
  assert.equal(s.exec, false, `${name} must not be an instruction-scan region`);
}

// 3. Instruction attributes do not override the parent segment's VM permission.
{
  const data = info.segments.find((s) => s.name === '__DATA');
  const s = data.sections.find((x) => x.name === '__data');
  assert.equal(s.code, true);
  assert.equal(s.vmExec, false);
  assert.equal(s.exec, false, 'a non-executable mapping is not an instruction-scan region');
}

// 4. regionsFrom() must expose the same authority the app's programRegions()
//    consumes: __text only, not the RX data sections.
{
  const regions = MachO.regionsFrom(info, 0n, BigInt(bytes.length), BigInt(bytes.length));
  const execNames = regions.filter((r) => r.exec === true).map((r) => r.name).sort();
  assert.deepEqual([...execNames], ['__TEXT,__text']);
  const cstring = regions.find((r) => r.name === '__TEXT,__cstring');
  assert.equal(cstring.exec, false);
  assert.ok(regions.some((r) => r.name === '__TEXT,__cstring'), 'data regions are still reported, just not as code');
}

// 5. A stub section is code even when no instruction attribute is present.
{
  const context = MachO;
  const stubBytes = buildThin();
  const dv = new DataView(stubBytes.buffer);
  // repoint __cstring flags at S_SYMBOL_STUBS to model a stubs section
  dv.setUint32(32 + 72 + 80 + 64, S_SYMBOL_STUBS, true);
  const stubInfo = context.parseSlice(stubBytes.buffer, 0, stubBytes.length);
  const stub = stubInfo.segments[0].sections.find((s) => s.name === '__cstring');
  assert.equal(stub.code, true);
  assert.equal(stub.exec, true);
}

console.log('issue #3795 Mach-O section code-authority regression passed');
