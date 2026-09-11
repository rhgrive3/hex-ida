import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider, gnuDebugLinkCrc32 } from '../../../js/analysis/debug/dwarf.js';
import { loadDwarfFixtures } from '../../../tools/validation/phase7/lanes/debug.mjs';

// A CRC-verified split-debug companion is an ELF that carries the .debug_*
// sections the stripped binary lacks. Verifying the companion's CRC and then
// ignoring its contents leaves every symbol/type unrestored: the verified
// bytes must become the parse source (#5461).

const fixtures = loadDwarfFixtures();
const splitDebug = fixtures.variants.find((variant) => variant.name === 'split-debug');
const decode = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

test('#5461: a CRC-verified companion restores the stripped DWARF', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    identity: {},
    debugSections: { '.gnu_debuglink': decode(splitDebug.strippedDebugLink) },
    companionBytes: decode(splitDebug.companion),
    snapshotId: 's-5461',
  });

  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.identity.method, 'gnu-debuglink-crc32');
  assert.equal(result.identity.expected, result.identity.observed, 'the companion CRC matches the debug link');
  assert.ok(result.counts.dies > 0, 'the companion DWARF is parsed, not just verified');

  const symbols = provider.symbols(result, {}).records.map((record) => record.name);
  assert.ok(symbols.includes('add_point'), 'the stripped binary functions are recovered from the companion');
  assert.ok(symbols.includes('scale'));

  const types = provider.types(result, {}).records;
  assert.ok(types.length > 0, 'companion type records are restored');
});

test('#5461: without a companion the split-debug contract is unchanged', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    identity: {},
    debugSections: { '.gnu_debuglink': decode(splitDebug.strippedDebugLink) },
    snapshotId: 's-5461-missing',
  });
  assert.equal(result.identity.verdict, 'companion-missing');
  assert.equal(result.counts.dies, 0);
});

test('#5461: a CRC-mismatched companion is rejected regardless of contents', () => {
  const provider = new DwarfDebugInfoProvider();
  const companion = decode(splitDebug.companion);
  const view = new DataView(companion.buffer);
  view.setUint32(0, (view.getUint32(0) ^ 0xffff) >>> 0, true);
  const result = provider.probe({
    identity: {},
    debugSections: { '.gnu_debuglink': decode(splitDebug.strippedDebugLink) },
    companionBytes: companion,
    snapshotId: 's-5461-bad',
  });
  assert.equal(result.identity.verdict, 'identity-mismatch');
  assert.equal(result.counts.dies, 0, 'an unverified companion never becomes a debug source');
});

test('#5461: a verified non-ELF companion does not crash or mint DIEs', () => {
  const provider = new DwarfDebugInfoProvider();
  const companion = new Uint8Array([1, 2, 3, 4, 5]);
  const padded = new Uint8Array(Buffer.concat([Buffer.from('split.debug\0'), Buffer.alloc(3), Buffer.alloc(4)]));
  new DataView(padded.buffer).setUint32((padded.length - 4) & ~3, gnuDebugLinkCrc32(companion), true);
  const result = provider.probe({
    identity: {},
    debugSections: { '.gnu_debuglink': padded },
    companionBytes: companion,
    snapshotId: 's-5461-not-elf',
  });
  assert.equal(result.identity.verdict, 'matched-authoritative', 'CRC identity is about the file, not DWARF extraction');
  assert.equal(result.counts.dies, 0);
});
