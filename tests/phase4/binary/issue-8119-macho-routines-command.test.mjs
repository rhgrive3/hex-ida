import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const LC_SEGMENT = 0x1;
const LC_ROUTINES = 0x11;
const LC_SEGMENT_64 = 0x19;
const LC_ROUTINES_64 = 0x1a;
const LC_FUNCTION_STARTS = 0x26;

function put(bytes, offset, text) { bytes.set(Buffer.from(text), offset); }
function uleb(value) {
  let v = BigInt(value);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}

function macho64({
  initAddress = 0x1180n,
  initModule = 7n,
  routineSize = 72,
  initProt = 5,
  vmSize = 0x1000n,
  fileSize = 0x400n,
  functionStarts = false,
  cpu = 0x0100000c,
  subtype = 0,
} = {}) {
  const fsSize = functionStarts ? 16 : 0;
  const sizeofcmds = 72 + routineSize + fsSize;
  const bytes = new Uint8Array(0x500);
  const v = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  v.setInt32(4, cpu, true);
  v.setInt32(8, subtype, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, functionStarts ? 3 : 2, true);
  v.setUint32(20, sizeofcmds, true);

  let p = 32;
  v.setUint32(p, LC_SEGMENT_64, true);
  v.setUint32(p + 4, 72, true);
  put(bytes, p + 8, '__TEXT');
  v.setBigUint64(p + 24, 0x1000n, true);
  v.setBigUint64(p + 32, vmSize, true);
  v.setBigUint64(p + 40, 0n, true);
  v.setBigUint64(p + 48, fileSize, true);
  v.setInt32(p + 56, initProt, true);
  v.setInt32(p + 60, initProt, true);

  p += 72;
  v.setUint32(p, LC_ROUTINES_64, true);
  v.setUint32(p + 4, routineSize, true);
  v.setBigUint64(p + 8, initAddress, true);
  v.setBigUint64(p + 16, initModule, true);

  if (functionStarts) {
    p += routineSize;
    const streamOffset = 0x480;
    v.setUint32(p, LC_FUNCTION_STARTS, true);
    v.setUint32(p + 4, 16, true);
    v.setUint32(p + 8, streamOffset, true);
    v.setUint32(p + 12, 3, true);
    const encoded = uleb(initAddress - 0x1000n);
    bytes.set(encoded, streamOffset);
    bytes[streamOffset + encoded.length] = 0;
  }
  if (initAddress >= 0x1000n && initAddress + 4n <= 0x1000n + fileSize) {
    const off = Number(initAddress - 0x1000n);
    if (off >= 0 && off + 4 <= bytes.length) v.setUint32(off, 0xd65f03c0, true);
  }
  return bytes;
}

function macho32({ initAddress = 0x1180, initModule = 3, routineSize = 40 } = {}) {
  const sizeofcmds = 56 + routineSize;
  const bytes = new Uint8Array(0x300);
  const v = new DataView(bytes.buffer);
  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  v.setInt32(4, 7, true); // x86
  v.setInt32(8, 3, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, 2, true);
  v.setUint32(20, sizeofcmds, true);

  let p = 28;
  v.setUint32(p, LC_SEGMENT, true);
  v.setUint32(p + 4, 56, true);
  put(bytes, p + 8, '__TEXT');
  v.setUint32(p + 24, 0x1000, true);
  v.setUint32(p + 28, 0x1000, true);
  v.setUint32(p + 32, 0, true);
  v.setUint32(p + 36, 0x300, true);
  v.setInt32(p + 40, 5, true);
  v.setInt32(p + 44, 5, true);

  p += 56;
  v.setUint32(p, LC_ROUTINES, true);
  v.setUint32(p + 4, routineSize, true);
  v.setUint32(p + 8, initAddress, true);
  v.setUint32(p + 12, initModule, true);
  bytes[initAddress - 0x1000] = 0xc3;
  return bytes;
}

const routineSeed = (image, address) => image.functions.find(
  (f) => f.address === address && (f.source === 'routines' || f.sources?.includes('routines')),
);

// Valid LC_ROUTINES_64: retain lifecycle metadata and recover loader-invoked code.
{
  const image = parseMachO(macho64());
  assert.equal(image.metadata.routines.length, 1);
  assert.deepEqual(image.metadata.routines[0], {
    command:'LC_ROUTINES_64', commandOffset:104,
    initAddress:0x1180n, initModule:7n,
    validTarget:true, promoted:true, reason:null,
  });
  const fn = routineSeed(image, 0x1180n);
  assert.ok(fn, 'validated LC_ROUTINES_64 initializer must become function evidence');
  assert.equal(fn.exactFunctionStart, true);
  assert.equal(fn.confidence, 0.999);
  assert.match(fn.functionStartEvidence, /LC_ROUTINES_64/);
  assert.equal(image.metadata.machoMetadata.complete, true);
}

// Independent exact function-start evidence deduplicates while retaining provenance.
{
  const image = parseMachO(macho64({ functionStarts:true }));
  const at = image.functions.filter((f) => f.address === 0x1180n);
  assert.equal(at.length, 1, 'same loader/function-start target must deduplicate');
  assert.ok(at[0].sources?.includes('routines'));
  assert.ok(at[0].sources?.includes('function_starts'));
}

// Invalid nonzero targets remain lifecycle metadata, but never become exact functions.
for (const tc of [
  { name:'unmapped', options:{ initAddress:0x3000n }, reason:'unmapped' },
  { name:'non-executable', options:{ initProt:3 }, reason:'non-executable' },
  { name:'misaligned', options:{ initAddress:0x1182n }, reason:'misaligned' },
  { name:'zero-fill', options:{ initAddress:0x1200n, fileSize:0x200n }, reason:'not-file-backed' },
  { name:'partial-instruction', options:{ initAddress:0x11fcn, fileSize:0x1fen }, reason:'not-file-backed' },
]) {
  const image = parseMachO(macho64(tc.options));
  assert.equal(image.metadata.routines.length, 1, `${tc.name}: lifecycle record retained`);
  assert.equal(image.metadata.routines[0].reason, tc.reason, `${tc.name}: precise rejection`);
  assert.equal(image.metadata.routines[0].promoted, false);
  assert.equal(routineSeed(image, BigInt(tc.options.initAddress ?? 0x1180n)), undefined);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.includes(`routines:initializer-${tc.reason}`));
}

// ARM64e and ARM64_32 use the same fixed 4-byte instruction-start alignment.
for (const tc of [
  { arch:'arm64e', options:{ subtype:2, initAddress:0x1182n } },
  { arch:'arm64_32', options:{ cpu:0x0200000c, initAddress:0x1182n } },
]) {
  const image = parseMachO(macho64(tc.options));
  assert.equal(image.arch, tc.arch);
  assert.equal(image.metadata.routines[0].reason, 'misaligned');
  assert.equal(image.metadata.routines[0].promoted, false);
}

// A zero init_address denotes no initializer and must not fabricate a function or partial state.
{
  const image = parseMachO(macho64({ initAddress:0n }));
  assert.equal(image.metadata.routines[0].validTarget, null);
  assert.equal(image.metadata.routines[0].promoted, false);
  assert.equal(image.metadata.routines[0].reason, null);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, true);
}

// Post-core routines work must stay on the same metadata budget and refresh its snapshot.
{
  const withoutOutput = parseMachO(macho64({ initAddress:0n }));
  const withOutput = parseMachO(macho64());
  assert.equal(
    withOutput.metadata.machoMetadata.used.objects,
    withoutOutput.metadata.machoMetadata.used.objects + 1,
    'routine function publication must be charged to the shared Mach-O metadata budget',
  );
}

// The 32-bit LC_ROUTINES layout is decoded with 32-bit fields.
{
  const image = parseMachO(macho32());
  assert.equal(image.metadata.routines.length, 1);
  assert.equal(image.metadata.routines[0].command, 'LC_ROUTINES');
  assert.equal(image.metadata.routines[0].initAddress, 0x1180n);
  assert.equal(image.metadata.routines[0].initModule, 3n);
  assert.ok(routineSeed(image, 0x1180n));
}

// Both commands are fixed-layout structures: oversized records are malformed and unpublished.
for (const bytes of [macho64({ routineSize:80 }), macho32({ routineSize:48 })]) {
  const image = parseMachO(bytes);
  assert.equal(image.metadata.routines, undefined);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.startsWith('load-command-0x')));
  assert.equal(image.functions.length, 0);
}

console.log('issue-8119 Mach-O LC_ROUTINES[_64] lifecycle/function authority: PASS');
