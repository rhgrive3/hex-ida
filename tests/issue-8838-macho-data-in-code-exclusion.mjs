// Issue #8838 regression: the classic/legacy Mach-O path records the
// LC_DATA_IN_CODE command as `{ dataoff, datasize }` but no consumer decoded
// the `data_in_code_entry[]` payload, so bytes the file explicitly declared as
// data inside an executable section remained eligible for `LC_FUNCTION_STARTS`
// promotion. The canonical js/binary/macho-core.js (#8124) already implements
// the opposite invariant: parseDataInCode fills `image.dataInCode` and
// parseFunctionStarts refuses any start whose address lies inside a declared
// range via `image.isDataInCode(addr)`.
//
// This test asserts the two pieces of the legacy fix:
//   (a) the new `MachO.parseDataInCode(buf, info)` helper decodes each 8-byte
//       record, maps its file offset into a VM address using the segment
//       layout from `parseSlice()`, and marks the result truncated when the
//       payload is malformed or references an unmapped range;
//   (b) `MachO.parseFunctionStarts(...)` accepts a `dataInCode: [[lo,hi], ...]`
//       option and rejects any delta inside one of those VM ranges, so a
//       function-start stream that points at declared data cannot become
//       complete exact evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', src)(globalThis);
const { parseFunctionStarts, parseDataInCode } = globalThis.MachO;

const DICE_KIND_DATA = 1;
const DICE_KIND_JUMP_TABLE8 = 2;

function entries(list) {
  const bytes = new Uint8Array(list.length * 8);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    dv.setUint32(i * 8, e.offset, true);
    dv.setUint16(i * 8 + 4, e.length, true);
    dv.setUint16(i * 8 + 6, e.kind, true);
  }
  return bytes;
}

// The fixture used in the issue body: a single executable text segment at
// vmaddr 0x1000 with fileoff 0 / filesize 0x1000, so a data_in_code_entry
// declaring fileRange [0x204, 0x208) maps to VM [0x1204, 0x1208).
const INFO = {
  segments: [{
    name: '__TEXT', vmaddr: 0x1000n, vmsize: 0x1000n, fileoff: 0n, filesize: 0x1000n,
    initprot: 5, maxprot: 7, validMapping: true, sections: [],
  }],
};

// --- (a) parseDataInCode decodes exact ranges -------------------------------
{
  const buf = entries([{ offset: 0x204, length: 4, kind: DICE_KIND_DATA }]);
  const ranges = parseDataInCode(buf, INFO);
  assert.equal(ranges.length, 1, 'one record decoded');
  assert.equal(ranges[0][0], 0x1204n, 'start VM = seg.vmaddr + (entryOff - seg.fileoff)');
  assert.equal(ranges[0][1], 0x1208n, 'end VM = start + length');
  assert.equal(ranges[0][2], DICE_KIND_DATA, 'kind preserved');
  assert.equal(ranges.truncated, false);
  assert.equal(ranges.partialReason, null);
}

// Multiple records including a non-DATA kind are all decoded; the legacy
// worker treats every declared kind as an exclusion range, matching the
// canonical parser's `image.isDataInCode()` behavior (which does not
// discriminate by kind — every data_in_code_entry is a real "not code" claim).
{
  const buf = entries([
    { offset: 0x100, length: 8, kind: DICE_KIND_JUMP_TABLE8 },
    { offset: 0x200, length: 16, kind: DICE_KIND_DATA },
  ]);
  const ranges = parseDataInCode(buf, INFO);
  assert.deepEqual(ranges.map((r) => [r[0], r[1], r[2]]), [
    [0x1100n, 0x1108n, DICE_KIND_JUMP_TABLE8],
    [0x1200n, 0x1210n, DICE_KIND_DATA],
  ]);
  assert.equal(ranges.truncated, false);
}

// Trailing partial record — the parser must mark truncated so the caller
// refuses to bless function starts as complete exact evidence.
{
  const buf = new Uint8Array(10);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x204, true); dv.setUint16(4, 4, true); dv.setUint16(6, DICE_KIND_DATA, true);
  // 2 extra trailing bytes — malformed, not silently dropped.
  buf[8] = 0xff; buf[9] = 0xff;
  const ranges = parseDataInCode(buf, INFO);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'size-not-multiple-of-entry');
  assert.equal(ranges.length, 1, 'the complete record is still decoded');
}

// An entry whose file offset lies outside every file-mapped segment marks
// `truncated` with reason `entry-out-of-range` and does not contribute a range.
{
  const buf = entries([{ offset: 0x9999, length: 4, kind: DICE_KIND_DATA }]);
  const ranges = parseDataInCode(buf, INFO);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'entry-out-of-range');
  assert.equal(ranges.length, 0);
}

// --- (b) parseFunctionStarts rejects a delta inside a declared range --------
// The exact counterexample from the issue body: a function-start stream that
// lands on 0x1204, which is inside a DICE_KIND_DATA range [0x1204, 0x1208).
{
  const fsBytes = Uint8Array.from([0x04, 0x00]); // base 0x1000, delta 4 → 0x1004 ...
  // base at 0x1200 so the first start is 0x1204 to match the fixture
  const fsBytes2 = Uint8Array.from([0x04, 0x00]);
  const excluded = parseFunctionStarts(fsBytes2, 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
    dataInCode: [[0x1204n, 0x1208n]],
  });
  assert.equal(excluded.length, 0, 'start inside a data-in-code range must be rejected');
  assert.equal(excluded.rejected, 1);
  assert.equal(excluded.complete, false);
  void fsBytes;
}

// Positive: same stream, same regions, but the delta is NOT inside any declared
// range → complete=true is preserved (no over-tightening).
{
  const excluded = parseFunctionStarts(Uint8Array.from([0x10, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
    dataInCode: [[0x1204n, 0x1208n]],
  });
  assert.deepEqual(Array.from(excluded), [0x1210n]);
  assert.equal(excluded.complete, true);
  assert.equal(excluded.rejected, 0);
}

// Regression guard: an options object without `dataInCode` retains the exact
// pre-#8838 behavior (the change is purely additive on the caller side).
{
  const legacy = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
  });
  assert.deepEqual(Array.from(legacy), [0x1204n]);
  assert.equal(legacy.complete, true);
}

// --- (c) Worker-source guard: analyzeSlice plumbs data-in-code into the call.
{
  const worker = fs.readFileSync(path.join(root, 'js/worker-legacy.js'), 'utf8');
  assert.match(worker, /const DATA_IN_CODE_MAX = 8 \* 1024 \* 1024;/,
    'the worker must cap the data_in_code_entry[] payload read');
  assert.match(worker, /dataInCode: dataInCodeRanges/,
    'analyzeSlice must forward the decoded data-in-code ranges to parseFunctionStarts');
  assert.match(worker, /functionStartsExact = !clamped && !dataInCodeIncomplete[\s\S]*list\.complete === true;/,
    'incomplete data-in-code decoding must forbid complete function-start authority');
}

console.log('issue #8838 legacy Mach-O data-in-code exclusion authority: PASS');
