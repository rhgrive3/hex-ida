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
// (2) `parseFunctionStarts()` `valid(addr)` short-circuited when `regions` was
// empty (`!regions.length || ...`), so a legacy slice whose `regionsFrom()`
// produced no entries accepted every aligned delta as a complete exact
// function start.
//
// Both branches now agree with the canonical `js/binary/macho-core.js`
// (#5551/#5555 `image.addressToOffset(addr) != null`, and the exec-segment
// containment check): a PC must lie inside a segment's file-backed VM span,
// and an empty region list is fail-closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', src)(globalThis);
const { parseSlice, parseFunctionStarts } = globalThis.MachO;

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_UNIXTHREAD = 0x5;
const ARM_THREAD_STATE64 = 6;
const ARM_THREAD_STATE64_COUNT = 68;   // in uint32 words; state is 272 bytes

// Build one 64-bit ARM64 image with a single __TEXT segment (nsects=0) plus an
// LC_UNIXTHREAD whose PC register slot lies at `pc` inside the segment's VM
// span. `vmsize`/`filesize` are the segment's declared sizes; anything in
// `[vmaddr+filesize, vmaddr+vmsize)` is loader zero-fill.
function buildTextSegmentOnly({
  pc, sliceSize = 0x2000, textVmaddr = 0x100000000n,
  vmsize = 0x2000n, fileoff = 0n, filesize = 0x1000n,
}) {
  const hdrSize = 32;
  const segCmdSize = 72;                 // segment_command_64 with nsects=0
  const threadCmdSize = 16 + ARM_THREAD_STATE64_COUNT * 4;
  const totalCmds = segCmdSize + threadCmdSize;
  const buf = new Uint8Array(Math.max(hdrSize + totalCmds, sliceSize));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MH_MAGIC_64, true);
  dv.setUint32(4, CPU_TYPE_ARM64, true);
  dv.setUint32(8, 0, true);              // cpusubtype
  dv.setUint32(12, 2, true);             // MH_EXECUTE
  dv.setUint32(16, 2, true);             // ncmds
  dv.setUint32(20, totalCmds, true);     // sizeofcmds
  dv.setUint32(24, 0, true);             // flags
  dv.setUint32(28, 0, true);             // reserved
  let p = hdrSize;
  dv.setUint32(p, LC_SEGMENT_64, true);
  dv.setUint32(p + 4, segCmdSize, true);
  dv.setBigUint64(p + 24, textVmaddr, true);
  dv.setBigUint64(p + 32, vmsize, true);
  dv.setBigUint64(p + 40, fileoff, true);
  dv.setBigUint64(p + 48, filesize, true);
  dv.setInt32(p + 56, 7, true);          // maxprot RWX
  dv.setInt32(p + 60, 5, true);          // initprot RX
  dv.setUint32(p + 64, 0, true);         // nsects
  dv.setUint32(p + 68, 0, true);         // segflags
  p += segCmdSize;
  dv.setUint32(p, LC_UNIXTHREAD, true);
  dv.setUint32(p + 4, threadCmdSize, true);
  dv.setUint32(p + 8, ARM_THREAD_STATE64, true);
  dv.setUint32(p + 12, ARM_THREAD_STATE64_COUNT, true);
  // PC sits at byte offset 256 within the state area (index 32 of uint64 regs).
  dv.setBigUint64(p + 16 + 256, pc, true);
  return buf.buffer;
}

{
  // PC = 0x100001400 lies 0x400 into the segment's zero-fill tail
  // (vmaddr+filesize = 0x100001000, vmaddr+vmsize = 0x100002000). Pre-fix,
  // `validPc` accepted it because the check only bounded against `vmsize`.
  const buf = buildTextSegmentOnly({ pc: 0x100001400n });
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.entry, null,
    'LC_UNIXTHREAD PC in zero-fill tail must be rejected (no file-backed bytes)');
  assert.equal(info.entrySource, null,
    'no entry authority may be assigned to a PC without file-backed instruction bytes');
  assert.ok(info.diagnostics.some((d) => d.includes('thread entrypoint is outside')),
    'the existing diagnostic must still fire on the rejection path');
}

{
  // Positive regression: a PC strictly inside the file-backed span is still
  // accepted, i.e. the fix does not weaken valid-input behavior.
  const buf = buildTextSegmentOnly({ pc: 0x100000400n });
  const info = parseSlice(buf, 0n, BigInt(buf.byteLength));
  assert.equal(info.entry, 0x100000400n, 'PC in file-backed VM span is still accepted');
  assert.equal(info.entrySource, 'LC_THREAD');
}

// --- (2) Empty `regions` in parseFunctionStarts fails closed ---------------
// Build a stream with a valid terminator + one delta. With no regions, the
// delta must not be accepted (previously short-circuited via `!regions.length`).
{
  const bytes = Uint8Array.from([0x04, 0x00]);
  const empty = parseFunctionStarts(bytes, 0x1000n, { regions: [], architecture: 'arm64' });
  assert.equal(empty.length, 0, 'empty regions must reject every delta');
  assert.equal(empty.rejected, 1);
  assert.equal(empty.complete, false);
  assert.equal(empty.malformed, false, 'terminator was observed; not malformed');
  assert.equal(empty.partialReason, null);
}

// Positive regression: the same stream with a real region covering the target
// address still yields `complete=true` and the emitted start.
{
  const bytes = Uint8Array.from([0x04, 0x00]);
  const full = parseFunctionStarts(bytes, 0x1000n, {
    regions: [{ exec: true, size: 0x100n, vmAddr: 0x1000n }], architecture: 'arm64',
  });
  assert.deepEqual(Array.from(full), [0x1004n]);
  assert.equal(full.complete, true);
  assert.equal(full.rejected, 0);
}

console.log('issue #8824 legacy Mach-O thread-PC zero-fill + empty-regions fail-closed: PASS');
