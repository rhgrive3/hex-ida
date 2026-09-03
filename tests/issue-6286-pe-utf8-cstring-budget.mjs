import test from "node:test";
import assert from "node:assert/strict";
import { parseExports, parseImports, createPEMetadataBudget } from "../js/binary/pe-loader.js";
import { ByteView } from "../js/binary/reader.js";

const BASE = 0x140000000n;

function createFixture(strBytes, fillNonNull = false) {
  const bytes = new Uint8Array(0x2000);
  const view = new DataView(bytes.buffer);
  const sec = {
    index: 1,
    name: ".edata",
    address: BASE + 0x1000n,
    size: 0x1000n,
    fileOffset: 0x40n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    imageBase: BASE,
    sections: [sec],
    sectionAt: () => sec,
    addressToOffset: (addr) => addr - BASE - 0x1000n + 0x40n,
    exports: [],
    functions: [],
    warnings: [],
    metadata: {},
  };
  // Export dir at offset 0x40 (RVA 0x1000)
  view.setUint32(0x40 + 12, 0x1080, true); // nameRva -> points to 0x1080 (offset 0xc0)
  view.setUint32(0x40 + 16, 1, true);      // baseOrdinal
  view.setUint32(0x40 + 20, 0, true);      // numberOfFunctions
  view.setUint32(0x40 + 24, 0, true);      // numberOfNames
  if (fillNonNull) {
    bytes.fill(0x41, 0xc0, 0x1040);
  } else if (strBytes) {
    bytes.set(strBytes, 0xc0);
  }
  const budget = createPEMetadataBudget(image);
  parseExports(new ByteView(bytes, { littleEndian: true }), { rva: 0x1000, size: 40 }, image, budget);
  return { image, budget };
}

test("1. ASCII AAAA\\0 accounts for raw 5 inputBytes", () => {
  const { budget } = createFixture(new TextEncoder().encode("AAAA\0"));
  assert.equal(budget.used.inputBytes, 5);
  assert.equal(budget.used.stringBytes, 8); // "AAAA".length * 2
});

test("2. UTF-8 猫\\0 accounts for raw 4 inputBytes (3 bytes + 1 NUL)", () => {
  const { budget } = createFixture(new TextEncoder().encode("猫\0"));
  assert.equal(budget.used.inputBytes, 4);
  assert.equal(budget.used.stringBytes, 2); // "猫".length * 2
});

test("3. UTF-8 猫猫猫猫\\0 accounts for raw 13 inputBytes (12 bytes + 1 NUL)", () => {
  const { budget } = createFixture(new TextEncoder().encode("猫猫猫猫\0"));
  assert.equal(budget.used.inputBytes, 13);
  assert.equal(budget.used.stringBytes, 8); // 4 * 2
});

test("4. Supplementary plane UTF-8 character accounts for raw byte count through NUL", () => {
  // 🐱 is 4 bytes in UTF-8 (0xF0 0x9F 0x90 0xB1), plus NUL = 5 bytes
  const { budget } = createFixture(new TextEncoder().encode("🐱\0"));
  assert.equal(budget.used.inputBytes, 5);
  assert.equal(budget.used.stringBytes, 4); // surrogate pair length 2 * 2
});

test("5. Unterminated string fails closed and does not decode without NUL", () => {
  const { image, budget } = createFixture(null, true);
  assert.equal(image.metadata.exportName, undefined);
  assert.equal(budget.used.inputBytes, 0);
  assert.ok(image.metadata.peMetadata?.reasons?.some((r) => r.includes("unterminated-string")));
});

test("6. mappedCStringAtOffset accounts for raw bytes through NUL in import hint-name", () => {
  const bytes = new Uint8Array(0x2000);
  const view = new DataView(bytes.buffer);
  const sec = {
    index: 1,
    name: ".idata",
    address: BASE + 0x1000n,
    size: 0x1000n,
    fileOffset: 0x40n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    imageBase: BASE,
    bits: 64,
    sections: [sec],
    sectionAt: () => sec,
    addressToOffset: (addr) => addr - BASE - 0x1000n + 0x40n,
    imports: [],
    libraries: [],
    warnings: [],
    metadata: {},
  };

  // Import Directory at 0x40 (RVA 0x1000)
  // OriginalFirstThunk at RVA 0x1040 (offset 0x80)
  view.setUint32(0x40 + 0, 0x1040, true);
  // Name RVA at 0x1060 (offset 0xa0) -> "lib.dll\0" (8 bytes raw)
  view.setUint32(0x40 + 12, 0x1060, true);
  bytes.set(new TextEncoder().encode("lib.dll\0"), 0xa0);
  // FirstThunk at RVA 0x1050 (offset 0x90)
  view.setUint32(0x40 + 16, 0x1050, true);

  // Thunk points to IMAGE_IMPORT_BY_NAME at RVA 0x1080 (offset 0xc0)
  view.setBigUint64(0x80, 0x1080n, true);
  view.setBigUint64(0x90, 0x1080n, true);

  // Hint at 0xc0 (2 bytes) = 0
  view.setUint16(0xc0, 0, true);
  // Name at 0xc2: "猫猫\0" (6 UTF-8 bytes + 1 NUL = 7 bytes)
  bytes.set(new TextEncoder().encode("猫猫\0"), 0xc2);

  const budget = createPEMetadataBudget(image);
  parseImports(new ByteView(bytes, { littleEndian: true }), { rva: 0x1000, size: 40 }, image, budget);

  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, "猫猫");
  assert.equal(image.imports[0].library, "lib.dll");
});
