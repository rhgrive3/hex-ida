// Issue #8838 regression: legacy Mach-O must treat LC_DATA_IN_CODE as exact
// negative code authority. Both the DICE source record and a candidate fixed-
// width instruction must be validated as whole spans, not by their first byte.
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

const INFO = {
  segments: [{
    name: '__TEXT', vmaddr: 0x1000n, vmsize: 0x1000n, fileoff: 0n, filesize: 0x1000n,
    initprot: 5, maxprot: 7, validMapping: true, sections: [],
  }],
};

{
  const ranges = parseDataInCode(entries([{ offset: 0x204, length: 4, kind: DICE_KIND_DATA }]), INFO);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0][0], 0x1204n);
  assert.equal(ranges[0][1], 0x1208n);
  assert.equal(ranges[0][2], DICE_KIND_DATA);
  assert.equal(ranges.truncated, false);
  assert.equal(ranges.partialReason, null);
}

{
  const ranges = parseDataInCode(entries([
    { offset: 0x100, length: 8, kind: DICE_KIND_JUMP_TABLE8 },
    { offset: 0x200, length: 16, kind: DICE_KIND_DATA },
  ]), INFO);
  assert.deepEqual(ranges.map((r) => [r[0], r[1], r[2]]), [
    [0x1100n, 0x1108n, DICE_KIND_JUMP_TABLE8],
    [0x1200n, 0x1210n, DICE_KIND_DATA],
  ]);
  assert.equal(ranges.truncated, false);
}

{
  const buf = new Uint8Array(10);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x204, true); dv.setUint16(4, 4, true); dv.setUint16(6, DICE_KIND_DATA, true);
  buf[8] = 0xff; buf[9] = 0xff;
  const ranges = parseDataInCode(buf, INFO);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'size-not-multiple-of-entry');
  assert.equal(ranges.length, 1);
}

{
  const ranges = parseDataInCode(entries([{ offset: 0x9999, length: 4, kind: DICE_KIND_DATA }]), INFO);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'entry-out-of-range');
  assert.equal(ranges.length, 0);
}

// Reviewer blocker: start byte is mapped but [offset,offset+length) crosses the
// file-backed end. The table is partial and contributes no trusted VM range.
{
  const ranges = parseDataInCode(entries([{ offset: 0x0fff, length: 4, kind: DICE_KIND_DATA }]), INFO);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'entry-out-of-range');
  assert.equal(ranges.length, 0);
}

// The same full-span rule is source-isolated: an entry cannot straddle two
// adjacent segment mappings and be laundered as one continuous record.
{
  const adjacent = {
    segments: [
      { vmaddr: 0x1000n, vmsize: 0x1000n, fileoff: 0n, filesize: 0x1000n, validMapping: true },
      { vmaddr: 0x4000n, vmsize: 0x1000n, fileoff: 0x1000n, filesize: 0x1000n, validMapping: true },
    ],
  };
  const ranges = parseDataInCode(entries([{ offset: 0x0fff, length: 4, kind: DICE_KIND_DATA }]), adjacent);
  assert.equal(ranges.truncated, true);
  assert.equal(ranges.partialReason, 'entry-out-of-range');
  assert.equal(ranges.length, 0);
}

// Start fully inside declared data is rejected.
{
  const excluded = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
    dataInCode: [[0x1204n, 0x1208n]],
  });
  assert.equal(excluded.length, 0);
  assert.equal(excluded.rejected, 1);
  assert.equal(excluded.complete, false);
}

// Reviewer blocker: ARM64 start is outside by first-byte membership, but its
// full 4-byte instruction [0x1204,0x1208) overlaps DICE [0x1205,0x1207).
{
  const excluded = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
    dataInCode: [[0x1205n, 0x1207n]],
  });
  assert.equal(excluded.length, 0, 'any-byte overlap of a fixed-width instruction must reject the start');
  assert.equal(excluded.rejected, 1);
  assert.equal(excluded.complete, false);
}

{
  const clean = parseFunctionStarts(Uint8Array.from([0x10, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
    dataInCode: [[0x1204n, 0x1208n]],
  });
  assert.deepEqual(Array.from(clean), [0x1210n]);
  assert.equal(clean.complete, true);
  assert.equal(clean.rejected, 0);
}

{
  const legacy = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x1200n, {
    regions: [{ exec: true, size: 0x400n, vmAddr: 0x1200n }],
    architecture: 'arm64',
  });
  assert.deepEqual(Array.from(legacy), [0x1204n]);
  assert.equal(legacy.complete, true);
}

{
  const worker = fs.readFileSync(path.join(root, 'js/worker-legacy.js'), 'utf8');
  assert.match(worker, /const DATA_IN_CODE_MAX = 8 \* 1024 \* 1024;/);
  assert.match(worker, /dataInCode: dataInCodeRanges/);
  assert.match(worker, /functionStartsExact = !clamped && !dataInCodeIncomplete[\s\S]*list\.complete === true;/);
}

console.log('issue #8838 legacy Mach-O data-in-code span authority: PASS');
