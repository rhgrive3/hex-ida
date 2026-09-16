import assert from 'node:assert/strict';
import { parseChainedBindingSites, resolveMachOPointer, describeMachOPointerSite } from '../js/binary/macho-dyld.js';

function fixture(format, raw, imports = [{ name: '_ok', sites: [] }]) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 28, true);       // starts_offset
  view.setUint32(28, 1, true);      // seg_count
  view.setUint32(32, 8, true);      // seg_info_offset[0]
  view.setUint32(36, 24, true);     // dyld_chained_starts_in_segment.size
  view.setUint16(40, 0x1000, true); // page_size
  view.setUint16(42, format, true); // pointer_format
  view.setBigUint64(44, 0n, true);  // segment_offset from image base
  view.setUint32(52, 0, true);      // max_valid_pointer
  view.setUint16(56, 1, true);      // page_count
  view.setUint16(58, 0, true);      // page_start[0]
  view.setBigUint64(0x100, raw, true);

  const r = {
    length: bytes.length,
    bytes,
    u16: (o) => view.getUint16(o, true),
    u32: (o) => view.getUint32(o, true),
    u64: (o) => view.getBigUint64(o, true),
  };
  const segment = { address: 0x1000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x200n };
  const image = {
    imageBase: 0x1000n,
    metadata: { chainedFixups: { complete: true, importsComplete: true } },
    warnings: [],
    segments: [segment],
    sectionAt(address) { return address >= 0x1000n && address < 0x2000n ? { address } : null; },
    segmentAt(address) { return address >= 0x1000n && address < 0x2000n ? segment : null; },
    addressToOffset(address) {
      return address >= 0x1000n && address < 0x1200n ? 0x100n + (address - 0x1000n) : null;
    },
  };
  const status = parseChainedBindingSites(r, { offset: 0, size: 0x80 }, image, imports, [segment]);
  return { image, imports, status, raw, address: 0x1000n };
}

function assertInvalid(result, label) {
  assert.equal(result.status.complete, false, `${label}: metadata must be partial`);
  assert.equal(result.status.bindingSitesComplete, false, `${label}: binding-site completeness must be false`);
  assert.equal(result.status.bindingSites, 0, `${label}: no bind site may be published`);
  assert.ok(result.status.bindingSiteReasons.some((reason) => reason.includes('reserved/zero bits')), `${label}: typed structural reason`);
  assert.ok(result.image.warnings.some((warning) => warning.includes('reserved/zero bits')), `${label}: warning records structural invalidity`);
  assert.equal(describeMachOPointerSite(result.image, result.raw, result.address).status, 'incomplete-owned-page', `${label}: malformed word must not be recorded as an exact site`);
  assert.equal(resolveMachOPointer(result.image, result.raw, { address: result.address }), null, `${label}: malformed word must not resolve exactly`);
}

function assertValidRebase(format, raw, expectedTarget, label) {
  const result = fixture(format, raw);
  assert.equal(result.status.complete, true, `${label}: valid record stays complete`);
  assert.equal(result.status.bindingSitesComplete, true, `${label}: valid page is complete`);
  assert.equal(describeMachOPointerSite(result.image, raw, result.address).status, 'recorded-site', `${label}: exact site is recorded`);
  assert.equal(resolveMachOPointer(result.image, raw, { address: result.address }), expectedTarget, `${label}: exact rebase target resolves`);
}

function assertValidBind(format, raw, label) {
  const imports = [{ name: '_ok', sites: [] }];
  const result = fixture(format, raw, imports);
  assert.equal(result.status.complete, true, `${label}: valid bind stays complete`);
  assert.equal(result.status.bindingSitesComplete, true, `${label}: valid bind page is complete`);
  assert.equal(result.status.bindingSites, 1, `${label}: bind site is published`);
  assert.equal(imports[0].sites.length, 1, `${label}: import receives the bind site`);
}

// DYLD_CHAINED_PTR_64 and DYLD_CHAINED_PTR_64_OFFSET rebases: bits 44..50 reserved.
assertValidRebase(2, 0x1800n, 0x1800n, 'format2 valid rebase');
assertValidRebase(6, 0x800n, 0x1800n, 'format6 valid rebase');
for (const format of [2, 6]) {
  assertInvalid(fixture(format, 0x1800n | (1n << 44n)), `format${format} rebase reserved bit44`);
  assertInvalid(fixture(format, 0x1800n | (0x7fn << 44n)), `format${format} rebase reserved mask`);
}

// DYLD_CHAINED_PTR_64(_OFFSET) binds: bits 32..50 reserved.
for (const format of [2, 6]) {
  assertValidBind(format, 1n << 63n, `format${format} valid bind`);
  assertInvalid(fixture(format, (1n << 63n) | (1n << 32n)), `format${format} bind reserved bit32`);
  assertInvalid(fixture(format, (1n << 63n) | (1n << 50n)), `format${format} bind reserved bit50`);
}

// ARM64E 16-bit-ordinal bind/auth-bind: bits 16..31 are specified zero.
for (const format of [1, 7, 9, 10]) {
  assertValidBind(format, 1n << 62n, `format${format} valid unauth bind`);
  assertInvalid(fixture(format, (1n << 62n) | (1n << 16n)), `format${format} unauth bind zero bit16`);
  assertValidBind(format, (1n << 63n) | (1n << 62n), `format${format} valid auth bind`);
  assertInvalid(fixture(format, (1n << 63n) | (1n << 62n) | (1n << 31n)), `format${format} auth bind zero bit31`);
}

// ARM64E_USERLAND24 bind/auth-bind: bits 24..31 are specified zero.
assertValidBind(12, 1n << 62n, 'format12 valid unauth bind');
assertInvalid(fixture(12, (1n << 62n) | (1n << 24n)), 'format12 unauth bind zero bit24');
assertValidBind(12, (1n << 63n) | (1n << 62n), 'format12 valid auth bind');
assertInvalid(fixture(12, (1n << 63n) | (1n << 62n) | (1n << 31n)), 'format12 auth bind zero bit31');

console.log('issue #4216 chained pointer reserved/zero-bit validation: PASS');
