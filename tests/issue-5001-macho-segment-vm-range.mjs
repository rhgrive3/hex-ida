import assert from 'node:assert/strict';
import { createFormatSafeRebuildTransaction, validateFormatSafeMutation } from '../js/rebuild/format-safe.js';

// Issue #5001 (acceptance criterion #3): machoSectionSizePlan bounded a
// __TEXT,__text size extension by the file gap and the next section's VM gap,
// but never by the owning segment's own VM range. A Mach-O section_64 carries
// file `offset` and VM `addr` independently, and LC_SEGMENT_64 carries
// `vmaddr`/`vmsize`. An extension could stay inside the file gap and the next
// section's address yet spill past `segment.vmaddr + segment.vmsize`, breaking
// the "layout-and-structure preserved" contract. The planner now also keeps
// `target.address + requestedSize <= segment.vmaddr + segment.vmsize`, and the
// validator re-verifies the segment VM range independently.

const u32 = (b, o, v) => { new DataView(b.buffer).setUint32(o, v, true); };
const u64 = (b, o, v) => { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); };
const enc = new TextEncoder();

// __TEXT: vmaddr 0x1000, vmsize `segmentVmSize`; __text addr 0x1000 size 0x10
// offset 0x200; __const addr `nextAddr` size 0x10 offset 0x300. File gap is
// 0x300 - 0x210 = 0xf0, so the file gap never binds below 0x100 here.
function buildSource({ segmentVmSize, nextAddr }) {
  const b = new Uint8Array(0x320);
  u32(b, 0, 0xfeedfacf); u32(b, 4, 0x01000007); u32(b, 8, 0); u32(b, 12, 2); u32(b, 16, 2); u32(b, 20, 232 + 16); u32(b, 24, 0); u32(b, 28, 0);
  u32(b, 32, 0x19); u32(b, 36, 232); b.set(enc.encode('__TEXT\0'), 40);
  u64(b, 56, 0x1000n); u64(b, 64, segmentVmSize); u64(b, 72, 0x200n); u64(b, 80, 0x120n); u32(b, 88, 7); u32(b, 92, 5); u32(b, 96, 2); u32(b, 100, 0);
  const sec = (i, name, addr, size, off) => {
    const p = 104 + i * 80;
    b.set(enc.encode(name + '\0'), p);
    b.set(enc.encode('__TEXT\0'), p + 16);
    u64(b, p + 32, addr); u64(b, p + 40, size); u32(b, p + 48, off); u32(b, p + 52, 3);
  };
  sec(0, '__text', 0x1000, 0x10, 0x200);
  sec(1, '__const', nextAddr, 0x10, 0x300);
  u32(b, 264, 0x24); u32(b, 268, 16); u32(b, 272, 0x000a0c00); u32(b, 276, 0x000b0000);
  return b;
}

function attempt(source, size) {
  try {
    return createFormatSafeRebuildTransaction({
      binaryId: 'bin', source, format: 'macho', architecture: 'x86_64', loaderVersion: 'test',
      mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size },
    });
  } catch (error) { return { thrown: true, reason: String(error?.message || error) }; }
}

// Segment VM end 0x1012 bounds the extension below both the file gap and the
// (distant) next-section address: 0x13 spills past 0x1012 -> rejected.
{
  const source = buildSource({ segmentVmSize: 0x12, nextAddr: 0x2000 });
  const result = attempt(source, 0x13);
  assert.equal(result.thrown, true, 'an extension past the segment VM range must be rejected');
  assert.equal(result.reason, 'format-safe-macho-layout-size-invalid');
}

// size 0x12 lands exactly on the segment VM end -> accepted and written.
{
  const source = buildSource({ segmentVmSize: 0x12, nextAddr: 0x2000 });
  const result = attempt(source, 0x12);
  assert.equal(result.thrown, undefined, 'an extension exactly to the segment VM end is accepted');
  assert.deepEqual(Array.from(result.operations[0].after), [0x12, 0, 0, 0, 0, 0, 0, 0], 'the accepted size is written to the section header');
}

// Source state whose target range already crosses the segment VM end cannot be
// extended at all (fail closed), even though the file gap is ample.
{
  const source = buildSource({ segmentVmSize: 0x8, nextAddr: 0x2000 });
  const result = attempt(source, 0x18);
  assert.equal(result.thrown, true, 'a source already past the segment VM range rejects extension');
  assert.equal(result.reason, 'format-safe-macho-layout-size-invalid');
}

// When the segment VM range is generous it must not bind: the file gap still
// governs (preserves existing behavior).
{
  const source = buildSource({ segmentVmSize: 0x1000, nextAddr: 0x1500 });
  assert.equal(attempt(source, 0x100).thrown, undefined, 'file-gap bound governs when segment VM range is ample');
  assert.equal(attempt(source, 0x101).reason, 'format-safe-macho-layout-size-invalid', 'beyond the file gap is still rejected');
}

// The validator independently re-verifies the segment VM range invariant: a
// forged safeState whose size crosses the segment VM end is typed-rejected
// (recomputed plan) rather than accepted.
{
  const source = buildSource({ segmentVmSize: 0x12, nextAddr: 0x2000 });
  const transaction = attempt(source, 0x12);
  const forged = JSON.parse(JSON.stringify(transaction));
  forged.expectedOriginalState.formatSafe.size = 0x13;
  const verdict = validateFormatSafeMutation({ transaction: forged, original: source, output: source });
  assert.equal(verdict.ok, false, 'a forged segment-VM-exceeding safeState fails validation');
  assert.match(String(verdict.reason), /format-safe-(macho-layout-size-invalid|macho-layout-plan-invalid|operation-bytes-mismatch)/);
}

console.log('issue-5001 macho section-size segment VM range bound: ok');
