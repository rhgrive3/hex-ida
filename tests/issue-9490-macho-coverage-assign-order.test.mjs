import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChainedBindingSites, describeMachOPointerSite } from '../js/binary/macho-dyld.js';
import { ByteView } from '../js/binary/reader.js';

test('#9490 coverageAssign maintains sorted intervals when segments are out of address order', () => {
  const image = {
    imageBase: 0x1000n,
    metadata: { chainedFixups: { complete: true, importsComplete: true } },
    warnings: [],
    segments: [
      { name: 'segB', address: 0x3000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x100n },
      { name: 'segA', address: 0x1000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x100n },
    ],
  };
  parseChainedBindingSites(new ByteView(new Uint8Array(0x100)), { offset: 0, size: 0x80 }, image, [], image.segments);

  const siteA = describeMachOPointerSite(image, 0x1200n, 0x1000n);
  const siteB = describeMachOPointerSite(image, 0x3200n, 0x3000n);

  assert.ok(siteA.coverage, 'segA must have coverage info');
  assert.equal(siteA.coverage.start, 0x1000n);
  assert.equal(siteA.coverage.end, 0x2000n);

  assert.ok(siteB.coverage, 'segB must have coverage info');
  assert.equal(siteB.coverage.start, 0x3000n);
  assert.equal(siteB.coverage.end, 0x4000n);
});
