// Issue #8824 regression: the legacy/classic Mach-O path had two independent
// fail-open authority sites in `js/macho.js`.
//
// (1) `parseSlice()` `validPc(pc)` accepted a thread-entry PC anywhere inside
// an executable segment's `[vmaddr, vmaddr+vmsize)` span. Because a segment's
// `vmsize` may exceed its `filesize` (loader zero-fill tail), a `LC_UNIXTHREAD`
// PC past `filesize` — inside a __TEXT tail with zero physical bytes — was
// published as `entry=0x...` / `entrySource='LC_THREAD'`, seeding the whole
// downstream CFG from a location with no instruction bytes.
//
// (2) `parseFunctionStarts()` used to accept empty authority. The initial fix
// then over-tightened valid segment-only Mach-O images (`nsects=0`) because the
// worker's `regions` are section-derived. `regionsFrom()` must therefore expose
// a fallback only for a validated executable segment with no sections, bounded
// by `filesize` rather than the zero-fill `vmsize` tail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', src)(globalThis);
const { parseSlice, parseFunctionStarts, regionsFrom } = globalThis.MachO;

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_UNIXTHREAD = 0x5;
const ARM_THREAD_STATE64 = 6;
const ARM_THREAD_STATE64_COUNT = 68;

function buildTextSegmentOnly({
  pc, sliceSize = 0x2000, textVmaddr = 0x100000000n,
  vmsize = 0x2000n, fileoff = 0n, filesize = 0x1000n,
}) {
  const hdrSize = 32;
  const segCmdSize = 72;
  const threadCmdSize = 16 + ARM_THREAD_STATE64_COUNT * 4;
  const totalCmds = segCmdSize + threadCmdSize;
  const buf = new Uint8Array(Math.max(hdrSize + totalCmds, sliceSize));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MH_MAGIC_64, true);
  dv.setUint32(4, CPU_TYPE_ARM64, true);
  dv.setUint32(8, 0, true);
  dv.setUint32(12, 2, true);
  dv.setUint32(16, 2, true);
  dv.setUint32(20, totalCmds, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, 0, true);
  let p = hdrSize;
  dv.setUint32(p, LC_SEGMENT_64, true);
  dv.setUint32(p + 4, segCmdSize, true);
  new TextEncoder().encodeInto('__TEXT', buf.subarray(p + 8, p + 24));
  dv.setBigUint64(p + 24, textVmaddr, true);
  dv.setBigUint64(p + 32, vmsize, true);
  dv.setBigUint64(p + 40, fileoff, true);
  dv.setBigUint64(p + 48, filesize, true);
  dv.setInt32(p + 56, 7, true);
  dv.setInt32(p + 60, 5, true);
  dv.setUint32(p + 64, 0, true);
  dv.setUint32(p + 68, 0, true);
  p += segCmdSize;
  dv.setUint32(p, LC_UNIXTHREAD, true);
  dv.setUint32(p + 4, threadCmdSize, true);
  dv.setUint32(p + 8, ARM_THREAD_STATE64, true);
  dv.setUint32(p + 12, ARM_THREAD_STATE64_COUNT, true);
  dv.setBigUint64(p + 16 + 256, pc, true);
  return buf.buffer;
}

{
  const buf = buildTextSegmentOnly({ pc: 0x100001400n });
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.entry, null,
    'LC_UNIXTHREAD PC in zero-fill tail must be rejected (no file-backed bytes)');
  assert.equal(info.entrySource, null);
  assert.ok(info.diagnostics.some((d) => d.includes('thread entrypoint is outside')));
}

{
  const buf = buildTextSegmentOnly({ pc: 0x100000400n });
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.entry, 0x100000400n, 'PC in file-backed VM span is still accepted');
  assert.equal(info.entrySource, 'LC_THREAD');
}

// Explicitly absent authority remains fail-closed.
{
  const bytes = Uint8Array.from([0x04, 0x00]);
  const empty = parseFunctionStarts(bytes, 0x1000n, { regions: [], architecture: 'arm64' });
  assert.equal(empty.length, 0);
  assert.equal(empty.rejected, 1);
  assert.equal(empty.complete, false);
  assert.equal(empty.malformed, false);
  assert.equal(empty.partialReason, null);
}

// A normal executable section-style region remains accepted.
{
  const bytes = Uint8Array.from([0x04, 0x00]);
  const full = parseFunctionStarts(bytes, 0x1000n, {
    regions: [{ exec: true, size: 0x100n, vmAddr: 0x1000n }], architecture: 'arm64',
  });
  assert.deepEqual(Array.from(full), [0x1004n]);
  assert.equal(full.complete, true);
  assert.equal(full.rejected, 0);
}

// Reviewer counterexample: a valid executable segment with nsects=0 must not
// lose all function-start authority. regionsFrom() emits exactly the segment's
// file-backed span, so a start inside filesize is accepted while zero-fill is not.
{
  const buf = buildTextSegmentOnly({ pc: 0x100000400n });
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  const regions = regionsFrom(info, 0n, BigInt(buf.byteLength), BigInt(buf.byteLength));
  assert.equal(regions.length, 1, 'sectionless executable segment gets one fallback region');
  assert.equal(regions[0].kind, 'segment');
  assert.equal(regions[0].exec, true);
  assert.equal(regions[0].size, 0x1000n, 'fallback authority stops at filesize, not vmsize');

  const inside = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x100000000n, {
    regions, architecture: 'arm64',
  });
  assert.deepEqual(Array.from(inside), [0x100000004n]);
  assert.equal(inside.complete, true);

  const zeroFill = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x100001000n, {
    regions, architecture: 'arm64',
  });
  assert.equal(zeroFill.length, 0, 'segment fallback must not authorize zero-fill bytes');
  assert.equal(zeroFill.complete, false);
}

console.log('issue #8824 legacy Mach-O thread-PC + segment-only authority: PASS');
