import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { createMachOMetadataBudget } from '../../../js/binary/macho-budget.js';
import {
  parseChainedBindingSites, resolveMachOPointer, describeMachOPointerSite,
} from '../../../js/binary/macho-dyld.js';

const imageBase = 0x100000000n;
const PAGE = 0x1000;

// One file-backed __TEXT segment establishes imageBase; `coverageSegments`
// disjoint zero-fill segments each declare `pages` chained pages. pointerFormat
// 0x1234 is unsupported; format 6 is supported (empty 0xffff page-start table =
// declared ownership only, no chain sites).
function buildFixture({ coverageSegments, pages, pointerFormat }) {
  const startsOffset = 16;
  const segCount = 1 + coverageSegments;
  const recordSize = 22 + pages * 2;
  const segmentsBase = startsOffset + 4 + segCount * 4;
  const total = segmentsBase + coverageSegments * recordSize;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  const segments = [{ name: '__TEXT', address: imageBase, size: 0x1000n, fileOffset: 0x1000n, fileSize: 0x1000n }];
  dv.setUint32(0, 0, true); // dyld_chained_fixups version
  dv.setUint32(4, startsOffset, true); // starts_offset, relative to the payload base
  dv.setUint32(startsOffset, segCount, true);
  for (let i = 0; i < coverageSegments; i++) {
    const rel = (segmentsBase + i * recordSize) - startsOffset;
    dv.setUint32(startsOffset + 4 + (i + 1) * 4, rel, true);
    const address = imageBase + BigInt(0x10000 + i * 0x100000);
    const size = BigInt(pages * PAGE);
    segments.push({ name: `__COV${i}`, address, size, fileOffset: 0x2000n, fileSize: 0n });
    const p = segmentsBase + i * recordSize;
    dv.setUint32(p, recordSize, true);
    dv.setUint16(p + 4, PAGE, true);
    dv.setUint16(p + 6, pointerFormat, true);
    dv.setBigUint64(p + 8, address - imageBase, true);
    dv.setUint32(p + 16, 0, true);
    dv.setUint16(p + 20, pages, true);
    const startValue = pointerFormat === 6 ? 0xffff : 0x0000;
    for (let page = 0; page < pages; page++) dv.setUint16(p + 22 + page * 2, startValue, true);
  }
  const image = {
    imageBase,
    bits: 64,
    segments,
    imports: [],
    metadata: { chainedFixups: { complete: true, importsComplete: true } },
    warnings: [],
    libraries: [],
    addressToOffset(address) {
      const a = BigInt(address);
      for (const seg of segments) {
        if (seg.fileSize > 0n && a >= seg.address && a < seg.address + seg.fileSize) return Number(seg.fileOffset + (a - seg.address));
      }
      return null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      const seg = segments.find((s) => a >= s.address && a < s.address + s.size);
      return seg ? { address: seg.address, size: seg.size } : null;
    },
  };
  return { image, segments, bytes, dc: { offset: 0, size: total } };
}

test('#8867 unsupported chained formats still register conservative loader ownership', () => {
  const { image, bytes, segments, dc } = buildFixture({ coverageSegments: 1, pages: 4, pointerFormat: 0x1234 });
  const status = parseChainedBindingSites(new ByteView(bytes), dc, image, [], segments,
    createMachOMetadataBudget(image, { limits: {} }));
  assert.equal(status.bindingSitesComplete, false);
  assert.ok((status.unsupportedPointerFormats || []).includes(0x1234), '#72 unsupported-format diagnostic preserved');
  const covSegment = segments[1];
  const inPage = covSegment.address + 0x1800n;
  assert.ok(image.segmentAt(imageBase + 0x800n), 'a VA-looking raw must still resolve inside this image');
  assert.equal(resolveMachOPointer(image, imageBase + 0x800n, { address: inPage }), null,
    'incomplete owned page must not fall through to raw-VA exactness (#569)');
  const view = describeMachOPointerSite(image, imageBase + 0x800n, inPage);
  assert.equal(view.status, 'incomplete-owned-page');
  assert.equal(view.coverage.complete, false);
});

test('#8867 coverage registration is charged against the shared budget on unsupported formats', () => {
  const coverageSegments = 8;
  const pages = 512;
  const { image, bytes, segments, dc } = buildFixture({ coverageSegments, pages, pointerFormat: 0x1234 });
  const declaredPages = coverageSegments * pages;
  const budget = createMachOMetadataBudget(image, { limits: { operations: 100, records: 100, objects: 100 } });
  const status = parseChainedBindingSites(new ByteView(bytes), dc, image, [], segments, budget);
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(image.metadata.machoMetadata.complete, false, 'budget exhaustion must mark metadata partial');
  assert.ok(image.metadata.machoMetadata.reasons.some((reason) => reason.startsWith('budget:')),
    'a stable budget reason must be recorded');
  assert.ok(budget.used.operations <= 100, `operations budget must be enforced, used=${budget.used.operations} vs ${declaredPages} declared pages`);
  assert.ok(budget.used.records <= 100, `records budget must be enforced, used=${budget.used.records}`);
});

test('#8867 retained coverage coalesces contiguous declared pages into one bounded interval', () => {
  const coverageSegments = 3;
  const pages = 4096;
  const { image, bytes, segments, dc } = buildFixture({ coverageSegments, pages, pointerFormat: 0x1234 });
  const budget = createMachOMetadataBudget(image, { limits: {} });
  const status = parseChainedBindingSites(new ByteView(bytes), dc, image, [], segments, budget);
  assert.equal(status.bindingSitesComplete, false);
  assert.ok(budget.used.records < 64, `retained records must be bounded by runs/segments, got ${budget.used.records} for ${coverageSegments * pages} pages`);
  for (let segIndex = 1; segIndex <= coverageSegments; segIndex++) {
    const cov = segments[segIndex];
    const head = cov.address;
    const mid = cov.address + BigInt(Math.floor(pages / 2) * PAGE) + 0x10n;
    const tail = cov.address + cov.size - 1n;
    for (const address of [head, mid, tail]) {
      assert.equal(describeMachOPointerSite(image, imageBase + 0x800n, address).status, 'incomplete-owned-page',
        'every page of a merged declared run stays loader-owned');
    }
  }
});

test('#8867 an undeclared page does not fabricate ownership over the whole segment', () => {
  // Supported format 6 with an all-empty (0xffff) page-start table: no page is
  // declared, so nothing is coalesced into ownership and an ordinary in-image VA
  // outside any declared page still resolves via the normal proof (#2376 shape).
  const { image, bytes, segments, dc } = buildFixture({ coverageSegments: 1, pages: 2, pointerFormat: 6 });
  parseChainedBindingSites(new ByteView(bytes), dc, image, [], segments,
    createMachOMetadataBudget(image, { limits: {} }));
  const cov = segments[1];
  const uncoveredAddress = cov.address + cov.size; // just past the declared span
  assert.equal(describeMachOPointerSite(image, imageBase + 0x800n, uncoveredAddress).status, 'no-recorded-fixup');
});
