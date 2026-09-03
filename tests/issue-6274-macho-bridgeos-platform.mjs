import test from "node:test";
import assert from "node:assert/strict";
import { parseMachO } from "../js/binary/macho.js";

function machoWithBuildVersion(platform) {
  const cmdsize = 24;
  const bytes = new Uint8Array(32 + cmdsize);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xfeedfacf, true);       // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);        // CPU_TYPE_ARM64
  dv.setInt32(8, 0, true);
  dv.setUint32(12, 2, true);               // MH_EXECUTE
  dv.setUint32(16, 1, true);               // ncmds
  dv.setUint32(20, cmdsize, true);         // sizeofcmds
  dv.setUint32(24, 0, true); dv.setUint32(28, 0, true);
  let p = 32;
  dv.setUint32(p, 0x32, true);             // LC_BUILD_VERSION
  dv.setUint32(p + 4, cmdsize, true);
  dv.setUint32(p + 8, platform, true);     // platform
  dv.setUint32(p + 12, 0x00010000, true);  // minos 1.0.0
  dv.setUint32(p + 16, 0x00020000, true);  // sdk 2.0.0
  dv.setUint32(p + 20, 0, true);           // ntools
  return bytes;
}

test("Mach-O: LC_BUILD_VERSION with platform 5 maps to bridgeOS", () => {
  const img = parseMachO(machoWithBuildVersion(5));
  assert.equal(img.platform, "bridgeOS");
  assert.equal(img.metadata.buildVersion.platform, 5);
  assert.equal(img.metadata.buildVersion.platformName, "bridgeOS");
  assert.equal(img.metadata.buildVersion.minos, "1.0.0");
  assert.equal(img.metadata.buildVersion.sdk, "2.0.0");

  // Serialization maintains bridgeOS identity
  const serialized = JSON.parse(JSON.stringify(img));
  assert.equal(serialized.platform, "bridgeOS");
  assert.equal(serialized.metadata.buildVersion.platformName, "bridgeOS");
  assert.equal(serialized.metadata.buildVersion.platform, 5);
});

test("Mach-O: LC_BUILD_VERSION preserves existing platforms 1-4 and 6-12", () => {
  const expected = {
    1: "macOS",
    2: "iOS",
    3: "tvOS",
    4: "watchOS",
    6: "macCatalyst",
    7: "iOS-simulator",
    8: "tvOS-simulator",
    9: "watchOS-simulator",
    10: "driverKit",
    11: "visionOS",
    12: "visionOS-simulator",
  };
  for (const [p, name] of Object.entries(expected)) {
    const img = parseMachO(machoWithBuildVersion(Number(p)));
    assert.equal(img.platform, name);
    assert.equal(img.metadata.buildVersion.platformName, name);
    assert.equal(img.metadata.buildVersion.platform, Number(p));
  }
});

test("Mach-O: LC_BUILD_VERSION falls back to apple-platform-N for truly unknown platform IDs", () => {
  const unknownIds = [0, 13, 99];
  for (const id of unknownIds) {
    const img = parseMachO(machoWithBuildVersion(id));
    assert.equal(img.platform, `apple-platform-${id}`);
    assert.equal(img.metadata.buildVersion.platformName, `apple-platform-${id}`);
    assert.equal(img.metadata.buildVersion.platform, id);
  }
});
