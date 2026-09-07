import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseMsf,
} from '../../../js/analysis/debug/pdb.js';
import {
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

// Issue #5822: findSectionHeaderStream() must honor the DBI header's declared
// optionalDbgHeaderSize. Index 5 (SectionHdr) of the optional debug header
// only exists when the header declares at least 12 bytes; adjacent/trailing
// bytes must never be adopted as section mapping authority.

// Rewrite optionalDbgHeaderSize (DBI header field at offset 48) in every copy
// of the DBI header found in the physical image. The DBI header is identified
// by its version field plus the exact parsed optionalDbgHeaderSize at 48.
function rewriteOptionalDbgHeaderSize(image, dbi, value) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  let rewritten = 0;
  for (let offset = 0; offset + 64 <= image.length; offset += 4) {
    if (view.getUint32(offset + 4, true) !== dbi.versionHeader) continue;
    if (view.getInt32(offset + 48, true) !== dbi.optionalDbgHeaderSize) continue;
    view.setInt32(offset + 48, value, true);
    rewritten += 1;
  }
  return rewritten;
}

test('#5822 zero optionalDbgHeaderSize fails closed instead of reading past the declared extent', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);
  const dbi = parseDbiHeader(msf.streams[3].read());
  assert.ok(dbi, 'fixture must parse a DBI header');

  // Baseline: the untouched fixture proves section headers through index 5.
  const baseline = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: original });
  assert.equal(baseline.parsed.sectionHeaders.length > 0, true,
    'fixture baseline must carry a section-header stream');

  const zeroed = new Uint8Array(original);
  assert.ok(rewriteOptionalDbgHeaderSize(zeroed, dbi, 0) >= 1, 'DBI header must be present in the image');

  const after = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: zeroed });
  // With the optional header declared empty, no section-header stream may be
  // adopted; the probe fails closed and symbols stay segment-relative.
  assert.equal(after.parsed.sectionHeaders.length, 0,
    'declared-absent optional debug header must not mint a section stream');
  assert.ok(after.diagnostics.some((d) => d.includes('no section header stream')),
    'the probe must report the missing section mapping instead of inventing one');
  assert.equal(after.status.completeness, 'partial');
  const symbolAddresses = after.symbols ? after.symbols(after, {}) : null;
  if (symbolAddresses?.records?.length) {
    for (const record of symbolAddresses.records) {
      assert.equal(record.address, null,
        'without section headers, symbol addresses must stay segment-relative');
    }
  }
});

test('#5822 optionalDbgHeaderSize smaller than the SectionHdr entry cannot mint a section stream', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  const dbi = parseDbiHeader(msf.streams[3].read());

  const truncated = new Uint8Array(original);
  assert.ok(rewriteOptionalDbgHeaderSize(truncated, dbi, 10) >= 1,
    '10 bytes cover indices 0-4 but not the SectionHdr index 5');

  const after = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: truncated });
  assert.equal(after.parsed.sectionHeaders.length, 0,
    'a short optional debug header cannot expose the SectionHdr entry');
  assert.equal(after.status.completeness, 'partial');
});

test('#5822 negative optionalDbgHeaderSize fails closed', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  const dbi = parseDbiHeader(msf.streams[3].read());

  const negative = new Uint8Array(original);
  assert.ok(rewriteOptionalDbgHeaderSize(negative, dbi, -1) >= 1);
  const after = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: negative });
  assert.equal(after.parsed.sectionHeaders.length, 0);
  assert.equal(after.status.completeness, 'partial');
});

test('#5822 an optional debug header extending past the DBI stream fails closed', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  const dbi = parseDbiHeader(msf.streams[3].read());
  assert.ok(dbi, 'fixture must parse a DBI header');

  const oversized = new Uint8Array(original);
  assert.ok(rewriteOptionalDbgHeaderSize(oversized, dbi, 0x7fffffff) >= 1,
    'DBI header must be present in the image');

  const after = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: oversized });
  assert.equal(after.parsed.sectionHeaders.length, 0,
    'an optional header beyond the DBI stream cannot expose SectionHdr');
  assert.ok(after.diagnostics.some((d) => d.includes('no section header stream')));
  assert.equal(after.status.completeness, 'partial');
});
