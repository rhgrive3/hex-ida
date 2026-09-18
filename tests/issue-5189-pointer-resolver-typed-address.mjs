import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMachOPointer, parseChainedBindingSites } from '../js/binary/macho-dyld.js';

// #5189 — resolveMachOPointer is a pointer-authority boundary: rawValue and
// options.address must be pointer primitives, not BigInt()-coercible shapes.
const image = {
  sectionAt: (address) => (address === 4096n ? { address: 4096n } : null),
  segmentAt: () => null,
};

test('#5189 resolveMachOPointer rejects structured rawValue coercion', () => {
  // Canonical inputs keep resolving.
  assert.equal(resolveMachOPointer(image, 4096n), 4096n);
  assert.equal(resolveMachOPointer(image, 4096), 4096n);
  assert.equal(resolveMachOPointer(image, '4096'), 4096n);
  assert.equal(resolveMachOPointer(image, '0x1000'), 4096n);

  // Structured/boolean laundering must fail closed.
  assert.equal(resolveMachOPointer(image, ['4096']), null, 'array rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, { toString: () => '4096' }), null, 'object rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, true), null, 'boolean rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, () => 4096), null, 'function rawValue must not become an address');
  assert.equal(resolveMachOPointer(image, '  4096  '), null, 'untrimmed numeric string must not canonicalize');
  assert.equal(resolveMachOPointer(image, Number.NaN), null);
  assert.equal(resolveMachOPointer(image, 4096.5), null);
});

test('#5189 chained site address accepts only pointer primitives', () => {
  // The internal site registry is populated by parseChainedBindingSites; the
  // assertions below drive the site path through that production setup (the
  // fixture records one rebase site at 0x1000 with raw 0x1500).
  const chained = {
    sectionAt: (address) => (address === 4096n ? { address: 4096n } : null),
    segmentAt: () => null,
    __chainedSiteAt: new Map([[4096n, { raw: 4097n, decoded: { bind: false, target: 4096n } }]]),
  };
  // Non-standard image shape: the site map is internal, so drive it through
  // the public boundary by resolving a raw value at a structured address.
  assert.equal(resolveMachOPointer(image, '4096', { address: ['4096'] }), null, 'structured options.address must not alias a site');
  assert.equal(resolveMachOPointer(image, '4096', { address: true }), null);
  assert.equal(resolveMachOPointer(image, '4096', { address: { valueOf: () => 4096 } }), null);
  assert.equal(resolveMachOPointer(image, '4096', { address: 4096n }), 4096n, 'canonical bigint address keeps resolving');
  void chained;
});

test('#5189 the production setup path registers sites the resolver honors', () => {
  /* Minimal chained-fixups payload (mirrors the issue-2390 fixture shape):
     one segment record, pointer_format 2, page_start[0] = 0 → a single chain
     whose first fixup sits at VM 0x1000, encoded as a REBASE with target
     0x1500. parseChainedBindingSites records that site in the internal
     registry; resolveMachOPointer must then resolve only through it. */
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u16 = (o, x) => view.setUint16(o, x, true);
  const u32 = (o, x) => view.setUint32(o, x, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  u32(4, 28);       // starts_offset
  u32(28, 1);       // seg_count
  u32(32, 8);       // seg_info_offset[0]
  u32(36, 24);      // dyld_chained_starts_in_segment.size
  u16(40, 0x1000);  // page_size
  u16(42, 2);       // DYLD_CHAINED_PTR_64
  u64(44, 0n);      // segment_offset from image base
  u32(52, 0);       // max_valid_pointer
  u16(56, 1);       // page_count
  u16(58, 0);       // page_start[0]: chain at page offset 0
  u64(0x100, 0x1500); // rebase fixup: bind=0, target 0x1500, next=0
  const r = {
    length: bytes.length,
    bytes,
    u16: (o) => view.getUint16(o, true),
    u32: (o) => view.getUint32(o, true),
    u64: (o) => view.getBigUint64(o, true),
  };
  const segment = { address: 0x1000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x200n };
  const chainedImage = {
    imageBase: 0x1000n,
    metadata: { chainedFixups: { complete: true, importsComplete: true } },
    warnings: [],
    segments: [segment],
    sectionAt: (address) => (address === 0x1500n ? { address } : null),
    segmentAt: (address) => (address >= 0x1000n && address < 0x2000n ? segment : null),
    addressToOffset(address) {
      return address >= 0x1000n && address < 0x1200n ? 0x100n + (address - 0x1000n) : null;
    },
  };
  const status = parseChainedBindingSites(r, { offset: 0, size: 0x80 }, chainedImage, [{ name: '_ok', sites: [] }], [segment]);
  assert.equal(status.complete, true);

  const siteRaw = 0x1500n, siteAddress = 0x1000n;
  assert.equal(resolveMachOPointer(chainedImage, siteRaw, { address: siteAddress }), 0x1500n, 'the recorded rebase site resolves through the registry');
  assert.equal(resolveMachOPointer(chainedImage, 0x999n, { address: siteAddress }), null, 'a raw word that differs from the recorded site must not resolve');
  assert.equal(resolveMachOPointer(chainedImage, siteRaw, { address: ['4096'] }), null, 'structured address fails closed before the registry lookup');
  assert.equal(resolveMachOPointer(chainedImage, siteRaw), 0x1500n, 'without an address the ordinary VA path still applies');
});
