import test from "node:test";
import assert from "node:assert/strict";
import { parseExports, createPEMetadataBudget } from "../js/binary/pe-loader.js";
import { ByteView } from "../js/binary/reader.js";

const BASE = 0x140000000n;

function createExportFixture({
  numberOfFunctions = 1,
  functions = [0x1200],
  names = [{ name: "AliasA", ord: 0 }, { name: "AliasB", ord: 0 }],
  forwarders = {}, // index -> forwarder string
  baseOrdinal = 1,
} = {}) {
  const bytes = new Uint8Array(0x2000);
  const view = new DataView(bytes.buffer);
  const sec = {
    index: 1,
    name: ".edata",
    address: BASE + 0x1000n,
    size: 0x1000n,
    fileOffset: 0x40n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
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

  // Header at 0x40 (RVA 0x1000)
  view.setUint32(0x40 + 12, 0x1080, true); // nameRva
  bytes.set(new TextEncoder().encode("export.dll\0"), 0xc0);
  view.setUint32(0x40 + 16, baseOrdinal, true);
  view.setUint32(0x40 + 20, numberOfFunctions, true);
  view.setUint32(0x40 + 24, names.length, true);

  // Arrays:
  // Functions at RVA 0x1100 (offset 0x140)
  view.setUint32(0x40 + 28, 0x1100, true);
  // Names at RVA 0x1200 (offset 0x240)
  view.setUint32(0x40 + 32, 0x1200, true);
  // Ordinals at RVA 0x1300 (offset 0x340)
  view.setUint32(0x40 + 36, 0x1300, true);

  for (let i = 0; i < functions.length; i++) {
    view.setUint32(0x140 + i * 4, functions[i], true);
  }

  let nameStrOffset = 0x400;
  for (let i = 0; i < names.length; i++) {
    const item = names[i];
    const nameRva = 0x1000 + (nameStrOffset - 0x40);
    view.setUint32(0x240 + i * 4, nameRva, true);
    view.setUint16(0x340 + i * 2, item.ord, true);
    bytes.set(new TextEncoder().encode(item.name + "\0"), nameStrOffset);
    nameStrOffset += item.name.length + 1;
  }

  for (const [fnIdxStr, fwdStr] of Object.entries(forwarders)) {
    const fnIdx = Number(fnIdxStr);
    const fwdRva = 0x1000 + (nameStrOffset - 0x40);
    // Forwarder must be within export dir: dirStart = 0x1000, dirEnd = 0x1000 + size
    view.setUint32(0x140 + fnIdx * 4, fwdRva, true);
    bytes.set(new TextEncoder().encode(fwdStr + "\0"), nameStrOffset);
    nameStrOffset += fwdStr.length + 1;
  }

  const budget = createPEMetadataBudget(image);
  parseExports(new ByteView(bytes, { littleEndian: true }), { rva: 0x1000, size: 0x500 }, image, budget);
  return { image, budget };
}

test("1. NumberOfFunctions=1 with 2 export names for same EAT index retains both aliases", () => {
  const { image } = createExportFixture({
    numberOfFunctions: 1,
    functions: [0x1600],
    names: [
      { name: "AliasA", ord: 0 },
      { name: "AliasB", ord: 0 },
    ],
  });

  assert.equal(image.exports.length, 2);
  const a = image.exports.find((e) => e.name === "AliasA");
  const b = image.exports.find((e) => e.name === "AliasB");
  assert.ok(a, "AliasA must be retained");
  assert.ok(b, "AliasB must be retained");

  // 2. Both resolve to same RVA/address and ordinal
  assert.equal(a.address, BASE + 0x1600n);
  assert.equal(b.address, BASE + 0x1600n);
  assert.equal(a.ordinal, 1);
  assert.equal(b.ordinal, 1);
  assert.equal(a.kind, "export");
  assert.equal(b.kind, "export");

  // Function seeds only once
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, BASE + 0x1600n);
});

test("3. Ordinal-only export without matching name is retained as #ordinal", () => {
  const { image } = createExportFixture({
    numberOfFunctions: 1,
    functions: [0x1700],
    names: [],
    baseOrdinal: 10,
  });

  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, "#10");
  assert.equal(image.exports[0].ordinal, 10);
  assert.equal(image.exports[0].address, BASE + 0x1700n);
});

test("4. Standard 1:1 name-to-ordinal exports work without regression", () => {
  const { image } = createExportFixture({
    numberOfFunctions: 2,
    functions: [0x1600, 0x1700],
    names: [
      { name: "FuncOne", ord: 0 },
      { name: "FuncTwo", ord: 1 },
    ],
    baseOrdinal: 1,
  });

  assert.equal(image.exports.length, 2);
  assert.equal(image.exports[0].name, "FuncOne");
  assert.equal(image.exports[0].ordinal, 1);
  assert.equal(image.exports[1].name, "FuncTwo");
  assert.equal(image.exports[1].ordinal, 2);
});

test("5. Forwarder EAT slot with multiple name aliases retains all aliases", () => {
  const { image } = createExportFixture({
    numberOfFunctions: 1,
    functions: [0], // overridden by forwarders
    forwarders: { 0: "NTDLL.RtlAllocateHeap" },
    names: [
      { name: "HeapAllocAliasA", ord: 0 },
      { name: "HeapAllocAliasB", ord: 0 },
    ],
    baseOrdinal: 5,
  });

  assert.equal(image.exports.length, 2);
  const a = image.exports.find((e) => e.name === "HeapAllocAliasA");
  const b = image.exports.find((e) => e.name === "HeapAllocAliasB");
  assert.ok(a && b);
  assert.equal(a.kind, "forwarder");
  assert.equal(b.kind, "forwarder");
  assert.equal(a.forwarder, "NTDLL.RtlAllocateHeap");
  assert.equal(b.forwarder, "NTDLL.RtlAllocateHeap");
  assert.equal(a.ordinal, 5);
  assert.equal(b.ordinal, 5);
});

test("6. Out-of-range ordinal index (#3776) is not adopted as an alias", () => {
  const { image } = createExportFixture({
    numberOfFunctions: 1, // Only 1 function (index 0)
    functions: [0x1600],
    names: [
      { name: "ValidName", ord: 0 },
      { name: "InvalidOutOfRange", ord: 99 }, // ordIndex >= numberOfFunctions
    ],
    baseOrdinal: 1,
  });

  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, "ValidName");
});
