import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

function macho64(command, cmdsize, configure = () => {}) {
  const bytes = new Uint8Array(32 + cmdsize + 0x100);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, 0x0100000c, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, cmdsize, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, command, true);
  view.setUint32(36, cmdsize, true);
  configure(view, 32, bytes);
  return bytes;
}

function buildVersion(cmdsize, ntools, platform = 2) {
  return macho64(0x32, cmdsize, (view, offset) => {
    view.setUint32(offset + 8, platform, true);
    view.setUint32(offset + 12, 0x00110002, true);
    view.setUint32(offset + 16, 0x00120000, true);
    view.setUint32(offset + 20, ntools, true);
    for (let i = 0; i < ntools && 24 + (i + 1) * 8 <= cmdsize; i++) {
      view.setUint32(offset + 24 + i * 8, 1, true);
      view.setUint32(offset + 28 + i * 8, 0x00090400, true);
    }
  });
}

function reasons(image) {
  return image.metadata.machoMetadata.reasons;
}

const zeroTools = parseMachO(buildVersion(24, 0));
assert.equal(zeroTools.metadata.machoMetadata.complete, true, 'ntools=0 cmdsize=24 must stay complete');
assert.equal(zeroTools.metadata.buildVersion.source, 'LC_BUILD_VERSION');
assert.equal(zeroTools.metadata.buildVersion.platformName, 'iOS', 'valid platform/minos/sdk parsing must regress-free');
assert.equal(zeroTools.metadata.buildVersion.minos, '17.0.2');
assert.equal(zeroTools.metadata.buildVersion.sdk, '18.0.0');

const oneTool = parseMachO(buildVersion(32, 1));
assert.equal(oneTool.metadata.machoMetadata.complete, true, 'ntools=1 cmdsize=32 must stay complete');
assert.equal(oneTool.metadata.buildVersion.source, 'LC_BUILD_VERSION');

const legacyPadding = parseMachO(buildVersion(32, 0));
assert.equal(legacyPadding.metadata.machoMetadata.complete, true, 'oversized padding policy from #4505 must be preserved');

const truncatedTool = parseMachO(buildVersion(24, 1));
assert.equal(truncatedTool.metadata.machoMetadata.complete, false, 'ntools=1 cmdsize=24 must not remain complete');
assert.ok(reasons(truncatedTool).includes('load-command-0x32-parse-error'), reasons(truncatedTool).join(','));
assert.equal(truncatedTool.metadata.buildVersion, undefined, 'malformed LC_BUILD_VERSION must not publish build provenance');

const countMismatch = parseMachO(buildVersion(32, 2));
assert.equal(countMismatch.metadata.machoMetadata.complete, false, 'ntools=2 cmdsize=32 requires 40 bytes and must be partial');
assert.ok(reasons(countMismatch).includes('load-command-0x32-parse-error'), reasons(countMismatch).join(','));
assert.equal(countMismatch.metadata.buildVersion, undefined);

const hugeToolCount = parseMachO(buildVersion(24, 0xffffffff));
assert.equal(hugeToolCount.metadata.machoMetadata.complete, false, 'unreasonable ntools must fail closed');
assert.ok(reasons(hugeToolCount).includes('load-command-0x32-parse-error'), reasons(hugeToolCount).join(','));

console.log('issue-3768-macho-build-version-ntools: ok');
