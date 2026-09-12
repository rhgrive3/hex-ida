import assert from 'node:assert/strict';
import { createFormatSafeRebuildTransaction, validateFormatSafeMutation, inspectFormatSafeImage } from '../js/rebuild/format-safe.js';

// Issue #4648: the format-safe Mach-O parser validated every section with
// size > 0 as file-backed ([offset, offset + size) must fit the image), so a
// valid zero-fill section (S_ZEROFILL / S_GB_ZEROFILL / S_THREAD_LOCAL_ZEROFILL,
// e.g. __bss) whose VM size exceeds the file length was rejected with
// format-safe-macho-section-range-invalid. Unrelated safe metadata mutations
// such as macho-min-version could then not even start. Zero-fill sections must
// keep their VM size metadata but carry no file-backed data, while file-backed
// sections remain fail-closed range-checked.

function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }
const enc = new TextEncoder();

const S_ZEROFILL = 0x1, S_GB_ZEROFILL = 0xc, S_THREAD_LOCAL_ZEROFILL = 0x12;

function buildSource(bssFlags = S_ZEROFILL) {
  const b = new Uint8Array(0x320);
  u32(b, 0, 0xfeedfacf); u32(b, 4, 0x01000007); u32(b, 8, 0); u32(b, 12, 2); u32(b, 16, 2); u32(b, 20, 232 + 16); u32(b, 24, 0); u32(b, 28, 0);
  u32(b, 32, 0x19); u32(b, 36, 232); b.set(enc.encode('__TEXT\0'), 40);
  u64(b, 56, 0x1000n); u64(b, 64, 0x2000n); u64(b, 72, 0x200n); u64(b, 80, 0x120n); u32(b, 88, 7); u32(b, 92, 5); u32(b, 96, 2); u32(b, 100, 0);
  const sec = (i, name, addr, size, off, flags) => {
    const p = 104 + i * 80;
    b.set(enc.encode(name + '\0'), p);
    b.set(enc.encode('__TEXT\0'), p + 16);
    u64(b, p + 32, addr); u64(b, p + 40, size); u32(b, p + 48, off); u32(b, p + 52, 3); u32(b, p + 64, flags);
  };
  sec(0, '__text', 0x1000, 0x10, 0x200, 0);
  sec(1, '__bss', 0x1010, 0x100000, 0, bssFlags);
  u32(b, 264, 0x24); u32(b, 268, 16); u32(b, 272, 0x000a0c00); u32(b, 276, 0x000b0000);
  return b;
}

const attempt = (source) => {
  try {
    return createFormatSafeRebuildTransaction({
      binaryId: 'bin', source, format: 'macho', architecture: 'x86_64', loaderVersion: 'test',
      mutation: { kind: 'macho-min-version', version: 0x000f0000 },
    });
  } catch (error) { return { thrown: true, reason: String(error?.message || error) }; }
};

// A valid __bss zero-fill section must not block an unrelated macho-min-version
// transaction, for every zero-fill section type.
for (const zerofill of [S_ZEROFILL, S_GB_ZEROFILL, S_THREAD_LOCAL_ZEROFILL]) {
  const result = attempt(buildSource(zerofill));
  assert.equal(result.thrown, undefined, `zero-fill section type 0x${zerofill.toString(16)} must parse as file-content-free`);
  assert.deepEqual(Array.from(result.operations[0].after), [0x00, 0x00, 0x0f, 0x00], 'the min-version operation is planned unchanged');
}

// SECTION_TYPE is the low byte of flags: attribute bits alongside a zero-fill
// type must not resurrect the file-backed requirement.
assert.equal(attempt(buildSource(0x80000000 | S_ZEROFILL)).thrown, undefined, 'S_ATTR_DEBUG combined with S_ZEROFILL must parse');

// The zero-fill section keeps its VM size/flags metadata; only file contents
// are dropped.
const snapshot = inspectFormatSafeImage(buildSource()).snapshot;
const bss = snapshot.sections.find((section) => section.name === '__bss');
const text = snapshot.sections.find((section) => section.name === '__text');
assert.equal(bss.size, 0x100000, 'the zero-fill VM size is preserved as metadata');
assert.equal(bss.flags, S_ZEROFILL, 'the zero-fill section type is preserved as metadata');
assert.equal(bss.offset, 0);
assert.equal(text.size, 0x10, 'file-backed section metadata is untouched');

// File-backed sections (SECTION_TYPE 0 or non-zero-fill) whose range exceeds
// the image remain fail-closed.
for (const fileBackedFlags of [0, S_GB_ZEROFILL + 1, 0x80000000 | 0x8]) {
  const result = attempt(buildSource(fileBackedFlags));
  assert.equal(result.thrown, true, `file-backed section type 0x${(fileBackedFlags & 0xff).toString(16)} must stay range-checked`);
  assert.equal(result.reason, 'format-safe-macho-section-range-invalid');
}

// End-to-end: applying the planned min-version operation validates green even
// though the image carries an oversized __bss.
const source = buildSource();
const transaction = attempt(source);
const candidate = Uint8Array.from(source);
candidate.set(transaction.operations[0].after, Number(transaction.operations[0].offset));
const verdict = validateFormatSafeMutation({ transaction, original: source, output: candidate });
assert.equal(verdict.ok, true, `the zero-fill-free mutation must validate: ${verdict.reason || ''}${verdict.detail || ''}`);
assert.equal(verdict.mutationKind, 'macho-min-version');

console.log('issue-4648 macho zerofill section file-range check: ok');
