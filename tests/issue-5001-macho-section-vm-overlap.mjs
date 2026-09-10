import assert from 'node:assert/strict';
import { createFormatSafeRebuildTransaction, validateFormatSafeMutation } from '../js/rebuild/format-safe.js';

// Issue #5001: machoSectionSizePlan bounded a __TEXT,__text size extension by
// the file-offset gap alone. Mach-O section file offsets and VM addresses are
// independent invariants, so a size that fit the file gap could drive the
// section's VM range into the next section's address range. The extension is
// now bounded by the smaller of the two gaps, and the validator recomputes
// the same plan (typed reject instead of a thrown error).

function u32(b,o,v){new DataView(b.buffer).setUint32(o,v,true)}
function u64(b,o,v){new DataView(b.buffer).setBigUint64(o,BigInt(v),true)}
const enc = new TextEncoder();

function buildSource() {
  const b = new Uint8Array(0x320);
  u32(b,0,0xfeedfacf); u32(b,4,0x01000007); u32(b,8,0); u32(b,12,2); u32(b,16,2); u32(b,20,232+16); u32(b,24,0); u32(b,28,0);
  u32(b,32,0x19); u32(b,36,232); b.set(enc.encode('__TEXT\0'), 40);
  u64(b,56,0x1000n); u64(b,64,0x2000n); u64(b,72,0x200n); u64(b,80,0x120n); u32(b,88,7); u32(b,92,5); u32(b,96,2); u32(b,100,0);
  const sec = (i, name, addr, size, off) => {
    const p = 104 + i*80;
    b.set(enc.encode(name+'\0'), p);
    b.set(enc.encode('__TEXT\0'), p+16);
    u64(b,p+32,addr); u64(b,p+40,size); u32(b,p+48,off); u32(b,p+52,3);
  };
  sec(0, '__text', 0x1000, 0x10, 0x200);
  sec(1, '__const', 0x1018, 0x10, 0x300);
  u32(b,264,0x24); u32(b,268,16); u32(b,272,0x000a0c00); u32(b,276,0x000b0000);
  return b;
}

const attempt = (source, size) => {
  try {
    return createFormatSafeRebuildTransaction({
      binaryId: 'bin', source, format: 'macho', architecture: 'x86_64', loaderVersion: 'test',
      mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size },
    });
  } catch (error) { return { thrown: true, reason: String(error?.message || error) }; }
};

// VM gap = 0x1018 - 0x1010 = 8; file gap = 0x300 - 0x210 = 0xf0.
// size 0x20 fits the file gap but overlaps __const's VM range -> rejected.
{
  const result = attempt(buildSource(), 0x20);
  assert.equal(result.thrown, true, 'a VM-overlapping extension must be rejected');
  assert.equal(result.reason, 'format-safe-macho-layout-size-invalid');
}

// size 0x18 reaches exactly the next section's VM address -> allowed.
{
  const result = attempt(buildSource(), 0x18);
  assert.equal(result.thrown, undefined, 'a VM-touching extension is accepted');
  assert.deepEqual(Array.from(result.operations[0].after), [0x18, 0, 0, 0, 0, 0, 0, 0], 'the accepted size is written to the section header');
}

// Without a VM-above neighbor the extension is bounded by the file gap only
// (existing behavior preserved).
{
  const source = buildSource();
  u64(source, 104 + 80 + 32, 0x900n); // __const addr below __text
  assert.equal(attempt(source, 0x100).thrown, undefined, 'file-gap bound governs without a VM neighbor');
  assert.equal(attempt(source, 0x101).reason, 'format-safe-macho-layout-size-invalid');
}

// A same-segment section below the target whose VM range intersects the
// target's range is a source-state overlap: the planner rejects outright.
{
  const source = buildSource();
  const base = { binaryId: 'bin', source, format: 'macho', architecture: 'x86_64', loaderVersion: 'test' };
  u64(source, 104 + 80 + 32, 0xff8n); // __const addr 0xff8..0x1008 intersects __text 0x1000..
  const result = attempt(source, 0x18);
  assert.equal(result.thrown, true, 'a source-state VM overlap must be rejected');
  assert.equal(result.reason, 'format-safe-macho-layout-source-vm-overlap');
}

// A forged transaction whose safeState claims a size the plan rejects is
// typed-rejected through the recomputation error path (not a thrown error).
{
  const source = buildSource();
  const transaction = attempt(source, 0x18);
  const forged = JSON.parse(JSON.stringify(transaction));
  forged.expectedOriginalState.formatSafe.size = 0x20;
  const verdict = validateFormatSafeMutation({ transaction: forged, original: source, output: source });
  assert.equal(verdict.ok, false, 'a forged oversized safeState fails validation');
  assert.equal(verdict.reason, 'format-safe-macho-layout-size-invalid');
}

// A forged transaction whose claimed size exceeds the VM gap is typed-rejected
// by the validator (recomputed plan), not a thrown error.
{
  const source = buildSource();
  const transaction = attempt(source, 0x18);
  const forged = { ...transaction, operations: [{ ...transaction.operations[0], after: new Uint8Array(8) }] };
  new DataView(forged.operations[0].after.buffer).setBigUint64(0, 0x20n, true);
  const verdict = validateFormatSafeMutation({ transaction: forged, original: source, output: source });
  assert.equal(verdict.ok, false, 'a forged VM-overlapping output fails validation');
  assert.match(String(verdict.reason), /format-safe-(macho-layout-)?(size-invalid|plan-invalid|operation-bytes-mismatch)/);
}

console.log('issue-5001 macho section-size VM gap bound: ok');
