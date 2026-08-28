import assert from "node:assert/strict";
import { BinaryImage } from "../js/binary/model.js";
import { parseMachO } from "../js/binary/macho-core.js";
import { parseELF } from "../js/binary/elf-core.js";
import { scanSourceStrings } from "../js/bytesource/strings.js";
import { createPEMetadataBudget } from "../js/binary/pe-loader.js";

// Issue #2288: custom byte backing with size bigint
{
  const raw = new Uint8Array([0x41, 0x42]);
  const backing = {
    __binaryByteBacking: true,
    size: 2n,
    subarray(start, end) {
      return raw.subarray(start, end);
    },
  };
  const img = new BinaryImage(backing);
  assert.equal(img.fileSize, 2n);
}

// Issues #2269 & #2313: negative VA and fileOffset rejection
{
  const img = new BinaryImage(new Uint8Array([0x41]), { format: "test" });
  assert.throws(() => img.addSegment({ address: -1n, size: 1n, fileOffset: 0n, fileSize: 1n }), RangeError);
  assert.throws(() => img.addSegment({ address: 0n, size: 1n, fileOffset: -1n, fileSize: 1n }), RangeError);
  assert.throws(() => img.addSection({ address: -1n, size: 1n, fileOffset: 0n, fileSize: 1n }), RangeError);
  assert.throws(() => img.addSection({ address: 0n, size: 1n, fileOffset: -1n, fileSize: 1n }), RangeError);
  assert.equal(img.addressToOffset(-1n), null);
  assert.equal(img.offsetToAddress(-1n), null);
  assert.equal(img.segmentAt(-1n), null);
  assert.equal(img.sectionAt(-1n), null);
}

// Issue #2224: offsetToAddress with VA 0 section
{
  const img = new BinaryImage(new Uint8Array(100), { format: "test" });
  img.addSection({
    name: ".text",
    address: 0n,
    size: 100n,
    fileOffset: 0n,
    fileSize: 100n,
    perms: { read: true, execute: true },
  });
  assert.equal(img.offsetToAddress(0n), 0n);
  assert.equal(img.offsetToAddress(10n), 10n);
}

// Issue #2244: createPEMetadataBudget with NaN / Infinity limits
{
  const img = new BinaryImage(new Uint8Array(100), { format: "pe" });
  const budget = createPEMetadataBudget(img, {
    limits: {
      records: NaN,
      operations: Infinity,
      stringBytes: -10,
    },
  });
  assert.equal(typeof budget.limits.records, "number");
  assert.ok(Number.isFinite(budget.limits.records));
  assert.ok(budget.limits.records > 0);
  assert.equal(typeof budget.limits.operations, "number");
  assert.ok(Number.isFinite(budget.limits.operations));
  assert.ok(budget.limits.operations > 0);
  assert.ok(budget.limits.stringBytes > 0);
}

// Issue #2235: scanSourceStrings chunk boundary run continuation
{
  const boundary = 64 * 1024;
  const bytes = new Uint8Array(boundary + 16);
  bytes.fill(0);
  bytes.set(new TextEncoder().encode("ABCDEFGHIJKL"), boundary - 4);
  const img = new BinaryImage(bytes, { format: "test" });
  img.addSection({ name: ".data", address: 0n, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { read: true } });
  
  const result = await scanSourceStrings(img, bytes, {
    minLength: 4,
    chunkSize: boundary,
  });
  const found = result.results.find(r => r.text.includes("ABCDEF"));
  assert.ok(found, "Should find the complete string crossing boundary");
  assert.equal(found.text, "ABCDEFGHIJKL");
}

console.log("Batch 1 binary regressions passed!");
