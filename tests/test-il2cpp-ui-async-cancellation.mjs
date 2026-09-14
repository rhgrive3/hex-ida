import assert from "node:assert/strict";
import { parseMetadataAuto, parseMetadataAutoAsync, bindMethodAddresses } from "../js/il2cpp.js";

console.log("Testing Issues #2619 and #2557 IL2CPP UI async & cancellation regressions...");

// Create a minimal synthetic global-metadata.dat buffer
function createSyntheticMetadata() {
  const buf = new Uint8Array(4096);
  const dv = new DataView(buf.buffer);
  const SANITY = 0xFAB11BAF;
  dv.setUint32(0, SANITY, true);
  dv.setInt32(4, 29, true); // version 29

  // string offset & count
  const stringOffset = 256;
  const stringData = new TextEncoder().encode("MyClass\0MyMethod\0\0");
  buf.set(stringData, stringOffset);

  // string pair: offset 256, size stringData.length
  // PAIR.string = 2 -> header offset: 8 + 2 * 8 = 24
  dv.setUint32(24, stringOffset, true);
  dv.setUint32(28, stringData.length, true);

  // typeDefinitions: PAIR.typeDefinitions = 19 -> 8 + 19 * 8 = 160
  const typeDefOffset = 512;
  const typeDefSize = 92; // 1 type
  dv.setUint32(160, typeDefOffset, true);
  dv.setUint32(164, typeDefSize, true);
  // type record 0: nameIdx=0, nsIdx=0
  dv.setInt32(typeDefOffset, 0, true);
  dv.setInt32(typeDefOffset + 4, 0, true);

  // methods: PAIR.methods = 5 -> 8 + 5 * 8 = 48
  const methodOffset = 768;
  const methodSize = 40; // 1 method
  dv.setUint32(48, methodOffset, true);
  dv.setUint32(52, methodSize, true);
  // method record 0: nameIdx=8, owner=0, token=0x06000001 (offset 24)
  dv.setInt32(methodOffset, 8, true);
  dv.setInt32(methodOffset + 4, 0, true);
  dv.setUint32(methodOffset + 24, 0x06000001, true);

  return buf;
}

const metadataBuf = createSyntheticMetadata();

// 1. parseMetadataAutoAsync parses valid synthetic metadata
const meta = await parseMetadataAutoAsync(metadataBuf);
assert.equal(meta.version, 29);
assert.equal(meta.classes.length, 1);
assert.equal(meta.classes[0].name, "MyClass");
assert.equal(meta.methods.length, 1);
assert.equal(meta.methods[0].name, "MyMethod");

// 2. parseMetadataAutoAsync cancellation via AbortSignal
const controller = new AbortController();
controller.abort();

await assert.rejects(
  parseMetadataAutoAsync(metadataBuf, { signal: controller.signal }),
  (err) => err.code === "ABORT_ERR"
);

// 3. bindMethodAddresses cancellation via AbortSignal
const bindController = new AbortController();
bindController.abort();

await assert.rejects(
  bindMethodAddresses(meta, { regions: [], signal: bindController.signal }),
  (err) => err.code === "ABORT_ERR"
);

console.log("Issues #2619 and #2557 regressions PASS!");
