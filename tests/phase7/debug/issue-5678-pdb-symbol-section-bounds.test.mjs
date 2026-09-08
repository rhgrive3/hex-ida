import test from 'node:test';
import assert from 'node:assert/strict';

import { PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';
import { debugFunctionEvidence } from '../../../js/analysis/debug/provider.js';
import { loadPdbFixtures, pdbImage } from '../../../tools/validation/phase7/lanes/debug.mjs';

// Issue #5678: a CodeView symbol whose (segment, offsetInSegment) falls
// outside the referenced section's virtual extent is corrupt. The provider
// must not mint an RVA from it, must not mark the descriptor complete, and
// such a record must never reach debugFunctionEvidence as 'exact'.
//
// The corpus PDB's .text section is VA 0x1000 with VirtualSize 122 /
// SizeOfRawData 512. Each test rewrites the S_PUB32 "add_point" record's
// offsetInSegment in the raw PDB bytes.

const CORPUS_TEXT_VA = 0x1000;
const CORPUS_TEXT_VIRTUAL_SIZE = 122;
const CORPUS_TEXT_RAW_SIZE = 512;

function pdbWithPub32Offset(patch) {
  const variant = loadPdbFixtures().variants[0];
  const bytes = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const view = new DataView(bytes.buffer);
  const name = new TextEncoder().encode('add_point\0');
  let patched = 0;
  for (let off = 0; off + 40 <= bytes.length; off += 1) {
    const length = view.getUint16(off, true);
    if (length < 14) continue;
    if (view.getUint16(off + 2, true) !== 0x110e) continue; // S_PUB32
    let match = true;
    for (let i = 0; i < name.length; i += 1) {
      if (bytes[off + 14 + i] !== name[i]) { match = false; break; }
    }
    if (!match) continue;
    patch(view, off, bytes);
    patched += 1;
  }
  assert.ok(patched >= 1, 'fixture must contain the S_PUB32 add_point record');
  return bytes;
}

function symbolsFor(pdbBytes, offsetInSegment) {
  const provider = new PdbDebugInfoProvider();
  const variant = loadPdbFixtures().variants[0];
  const result = provider.probe({ ...pdbImage(variant), pdbBytes });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  const page = provider.symbols(result, {});
  // Only the patched public record: procedure records share the name but keep
  // their own (valid) offsets.
  const records = page.records.filter((record) => record.name === 'add_point'
    && record.descriptor?.offsetInSegment === offsetInSegment);
  assert.ok(records.length >= 1, 'the patched public record must appear on the page');
  return { result, records };
}

test('#5678: an offset inside the section extent keeps its RVA', () => {
  // offsetInSegment 100 is below VirtualSize 122.
  const bytes = pdbWithPub32Offset((view, off) => view.setUint32(off + 8, 100, true));
  const { records } = symbolsFor(bytes, 100);
  for (const record of records) {
    assert.equal(record.address, `0x${(CORPUS_TEXT_VA + 100).toString(16)}`);
    assert.equal(record.descriptor.complete, true);
  }
});

test('#5678: offsetInSegment === virtualExtent - 1 is the last valid byte', () => {
  const bytes = pdbWithPub32Offset((view, off) => view.setUint32(off + 8, CORPUS_TEXT_VIRTUAL_SIZE - 1, true));
  const { records } = symbolsFor(bytes, CORPUS_TEXT_VIRTUAL_SIZE - 1);
  for (const record of records) {
    assert.equal(record.address, `0x${(CORPUS_TEXT_VA + CORPUS_TEXT_VIRTUAL_SIZE - 1).toString(16)}`);
    assert.equal(record.descriptor.complete, true);
  }
});

test('#5678: an offset beyond the virtual extent gets no RVA and stays incomplete', () => {
  const bytes = pdbWithPub32Offset((view, off) => view.setUint32(off + 8, 0x100000, true));
  const { result, records } = symbolsFor(bytes, 0x100000);
  for (const record of records) {
    assert.equal(record.address, null,
      'an out-of-section offset must not be promoted to an RVA');
    assert.equal(record.descriptor.complete, false);
    assert.equal(record.descriptor.isFunction, true);
  }
  const evidence = debugFunctionEvidence(result, { records });
  const escaped = evidence.filter((item) => item.name === 'add_point'
    && item.confidence === 'exact');
  assert.equal(escaped.length, 0,
    'out-of-extent records must never reach function evidence as exact');
});

test('#5678: a zero VirtualSize falls back to SizeOfRawData', () => {
  const bytes = pdbWithPub32Offset((view, off, raw) => {
    view.setUint32(off + 8, CORPUS_TEXT_RAW_SIZE - 1, true);
    // The .text section header lives in the section-header stream; clear its
    // VirtualSize field (IMAGE_SECTION_HEADER offset 8).
    const name = new TextEncoder().encode('.text\0\0\0');
    for (let base = 0; base + 40 <= raw.length; base += 1) {
      let match = true;
      for (let i = 0; i < name.length; i += 1) {
        if (raw[base + i] !== name[i]) { match = false; break; }
      }
      if (!match) continue;
      if (view.getUint32(base + 12, true) !== CORPUS_TEXT_VA) continue;
      view.setUint32(base + 8, 0, true);
      return;
    }
    assert.fail('fixture must contain a .text section header');
  });
  const { records } = symbolsFor(bytes, CORPUS_TEXT_RAW_SIZE - 1);
  for (const record of records) {
    assert.equal(record.address, `0x${(CORPUS_TEXT_VA + CORPUS_TEXT_RAW_SIZE - 1).toString(16)}`,
      'with VirtualSize 0 the raw-data extent governs');
    assert.equal(record.descriptor.complete, true);
  }
});

test('#5678: an offset beyond the raw fallback extent fails closed too', () => {
  const bytes = pdbWithPub32Offset((view, off, raw) => {
    view.setUint32(off + 8, CORPUS_TEXT_RAW_SIZE, true);
    const name = new TextEncoder().encode('.text\0\0\0');
    for (let base = 0; base + 40 <= raw.length; base += 1) {
      let match = true;
      for (let i = 0; i < name.length; i += 1) {
        if (raw[base + i] !== name[i]) { match = false; break; }
      }
      if (!match) continue;
      if (view.getUint32(base + 12, true) !== CORPUS_TEXT_VA) continue;
      view.setUint32(base + 8, 0, true);
      return;
    }
    assert.fail('fixture must contain a .text section header');
  });
  const { records } = symbolsFor(bytes, CORPUS_TEXT_RAW_SIZE);
  for (const record of records) {
    assert.equal(record.address, null);
    assert.equal(record.descriptor.complete, false);
  }
});

test('#5678: a procedure whose declared size runs past the section extent fails closed', () => {
  const variant = loadPdbFixtures().variants[0];
  const bytes = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const view = new DataView(bytes.buffer);
  const name = new TextEncoder().encode('add_point\0');
  let patched = 0;
  for (let off = 0; off + 60 <= bytes.length; off += 1) {
    if (view.getUint16(off, true) < 38) continue;
    const kind = view.getUint16(off + 2, true);
    if (kind !== 0x1110 && kind !== 0x1111) continue; // S_GPROC32 / S_LPROC32
    let match = true;
    for (let i = 0; i < name.length; i += 1) {
      if (bytes[off + 39 + i] !== name[i]) { match = false; break; }
    }
    if (!match) continue;
    // Keep the in-bounds start offset 0, but declare a size that crosses the
    // section extent: the claimed span is not backed by the section.
    view.setUint32(off + 16, 0x100000, true);
    patched += 1;
  }
  assert.ok(patched >= 1, 'fixture must contain a PROC32 add_point record');

  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({ ...pdbImage(variant), pdbBytes: bytes });
  assert.equal(result.identity.verdict, 'matched-authoritative');
  const page = provider.symbols(result, {});
  const procedures = page.records.filter((record) => record.name === 'add_point'
    && record.sizeBytes === 0x100000);
  assert.ok(procedures.length >= 1, 'the patched procedure record must appear');
  for (const record of procedures) {
    assert.equal(record.address, null,
      'a procedure spanning past the section extent must not mint an RVA');
    assert.equal(record.descriptor.complete, false);
  }
  const evidence = debugFunctionEvidence(result, page);
  assert.equal(evidence.filter((item) => item.name === 'add_point' && item.sizeBytes === 0x100000).length, 0,
    'the corrupt procedure must not become function evidence');
});
