import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';

// #6274: PLATFORM_BRIDGEOS = 5 must resolve to the canonical Apple platform
// name 'bridgeOS' instead of the generic 'apple-platform-5' fallback.

function thinWithBuildVersion(platform) {
  const bytes = new Uint8Array(64);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xfeedfacf, true);   // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);    // CPU_TYPE_ARM64
  dv.setInt32(8, 0, true);
  dv.setUint32(12, 2, true);           // MH_EXECUTE
  dv.setUint32(16, 1, true);           // ncmds
  dv.setUint32(20, 24, true);          // sizeofcmds
  dv.setUint32(24, 0, true); dv.setUint32(28, 0, true);
  // LC_BUILD_VERSION
  dv.setUint32(32, 0x32, true);        // cmd
  dv.setUint32(36, 24, true);          // cmdsize
  dv.setUint32(40, platform, true);    // platform
  dv.setUint32(44, 0x00010000, true);  // minos 1.0.0
  dv.setUint32(48, 0x00010000, true);  // sdk 1.0.0
  dv.setUint32(52, 0, true);           // ntools
  return bytes;
}

test('#6274 bridgeOS platform 5 maps to canonical bridgeOS identity', () => {
  const img = parseMachO(thinWithBuildVersion(5));
  assert.equal(img.metadata.buildVersion.platform, 5, 'raw platform value preserved');
  assert.equal(img.metadata.buildVersion.platformName, 'bridgeOS');
  assert.equal(img.platform, 'bridgeOS');
});

test('#6274 existing known platform mappings remain unchanged', () => {
  const known = {
    1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS',
    6: 'macCatalyst', 7: 'iOS-simulator', 8: 'tvOS-simulator',
    9: 'watchOS-simulator', 10: 'driverKit', 11: 'visionOS',
    12: 'visionOS-simulator',
  };
  for (const [platform, name] of Object.entries(known)) {
    const img = parseMachO(thinWithBuildVersion(Number(platform)));
    assert.equal(img.metadata.buildVersion.platformName, name, `platform ${platform}`);
    assert.equal(img.platform, name, `platform ${platform}`);
  }
});

test('#6274 unknown platform ids still fall back to apple-platform-N', () => {
  for (const platform of [0, 20, 99]) {
    const img = parseMachO(thinWithBuildVersion(platform));
    assert.equal(img.metadata.buildVersion.platformName, `apple-platform-${platform}`, `platform ${platform}`);
    assert.equal(img.platform, `apple-platform-${platform}`, `platform ${platform}`);
  }
});

test('#6274 bridgeOS identity survives serialization', () => {
  const img = parseMachO(thinWithBuildVersion(5));
  const json = JSON.parse(JSON.stringify(img));
  assert.equal(json.metadata.buildVersion.platform, 5);
  assert.equal(json.metadata.buildVersion.platformName, 'bridgeOS');
  assert.equal(json.platform, 'bridgeOS');
});
