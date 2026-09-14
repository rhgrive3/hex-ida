import assert from "node:assert/strict";
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from "../js/swift.js";

console.log("Testing Issue #2566 Swift metadata paged reader regressions...");

// 1. Synthetic 20,000 entry relative table fixture
const BASE = 0x10000n;
const ENTRY_COUNT = 20000;
const TABLE_SIZE = BigInt(ENTRY_COUNT * 4);

// Create memory buffer with 20,000 valid type descriptors
const mem = new Map(); // pageKey (BigInt) -> Uint8Array
const PAGE_SIZE = 65536;

function getPage(pageAddr) {
  let page = mem.get(pageAddr);
  if (!page) {
    page = new Uint8Array(PAGE_SIZE);
    mem.set(pageAddr, page);
  }
  return page;
}

function writeU32(addr, val) {
  const pageAddr = (BigInt(addr) / BigInt(PAGE_SIZE)) * BigInt(PAGE_SIZE);
  const offset = Number(BigInt(addr) - pageAddr);
  const page = getPage(pageAddr);
  const n = Number(BigInt.asUintN(32, BigInt(val)));
  page[offset] = n & 255;
  page[offset + 1] = (n >>> 8) & 255;
  page[offset + 2] = (n >>> 16) & 255;
  page[offset + 3] = (n >>> 24) & 255;
}

function writeRel32(fieldAddr, targetAddr) {
  writeU32(fieldAddr, BigInt(targetAddr) - BigInt(fieldAddr));
}

function writeStr(addr, str) {
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++) {
    const a = BigInt(addr) + BigInt(i);
    const pageAddr = (a / BigInt(PAGE_SIZE)) * BigInt(PAGE_SIZE);
    const offset = Number(a - pageAddr);
    getPage(pageAddr)[offset] = bytes[i];
  }
  const endAddr = BigInt(addr) + BigInt(bytes.length);
  const endPage = (endAddr / BigInt(PAGE_SIZE)) * BigInt(PAGE_SIZE);
  getPage(endPage)[Number(endAddr - endPage)] = 0;
}

// Build 20,000 relative entries pointing to distinct nominal descriptors
const DESC_BASE = 0x100000n;
for (let i = 0; i < ENTRY_COUNT; i++) {
  const fieldAddr = BASE + BigInt(i * 4);
  const descAddr = DESC_BASE + BigInt(i * 32);
  const nameAddr = DESC_BASE + 0x100000n + BigInt(i * 16);
  writeRel32(fieldAddr, descAddr);
  // ContextDescriptorKind::Class (16)
  writeU32(descAddr, 16);
  writeU32(descAddr + 4n, 0);
  writeRel32(descAddr + 8n, nameAddr);
  writeStr(nameAddr, "Type_" + i);
}

let readCalls = 0;
let totalBytesRead = 0;
const read = async (addr, len) => {
  readCalls++;
  totalBytesRead += len;
  const pageAddr = (BigInt(addr) / BigInt(PAGE_SIZE)) * BigInt(PAGE_SIZE);
  const offset = Number(BigInt(addr) - pageAddr);
  const page = mem.get(pageAddr);
  if (!page) return new Uint8Array(len);
  return page.subarray(offset, Math.min(page.length, offset + len));
};

const sections = [
  { section: "__swift5_types", vmAddr: BASE, size: TABLE_SIZE }
];

console.log("Parsing 20,000 entry Swift metadata table...");
const model = await buildSwiftMetadataModel(read, sections, { budget: 20000 });

assert.equal(model.types.length, 20000, "Must parse all 20,000 types without dropping entries");
assert.equal(model.completeness.types.complete, true, "Must be complete");
assert.equal(model.types[0].name, "Type_0");
assert.equal(model.types[19999].name, "Type_19999");

console.log("  Read calls count:", readCalls, "for 20,000 entries (Underlying RPCs << 20,000)");
// For 20,000 entries, unpaged reader would do >= 40,000 reads (1 table + 1 descriptor + 1 name).
// Paged reader does O(pages) reads (under 100 reads total).
assert.ok(readCalls < 500, "Underlying read calls must be O(pages), not 20,000");

// 2. Cancellation test
const abortController = new AbortController();
abortController.abort("test-abort");
const abortedModel = await buildSwiftMetadataModel(read, sections, { budget: 20000, signal: abortController.signal });
assert.equal(abortedModel, null, "Aborted signal must return null without processing");

console.log("Issue #2566 Swift metadata paged reader regressions PASS!");
