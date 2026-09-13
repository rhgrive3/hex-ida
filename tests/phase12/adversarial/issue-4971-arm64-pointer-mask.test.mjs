// Issue #4971 regression: the 64-bit pointer canonicalizer must preserve the
// established lower-48 virtual address, not truncate it to 36 bits.
import assert from 'node:assert/strict';

import { resolveModelTexts } from '../../../js/analyze.js';

function littleEndian(value, length = 8) {
  const bytes = new Uint8Array(length);
  let current = BigInt(value);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return bytes;
}

function modelFor(cell) {
  return {
    addressRefs: [{ addr: cell }],
    semantic: [],
    facts: { stringRefs: [{ addr: cell }], strings: [] },
    calls: [],
  };
}

function backendFor(entries) {
  const reads = [];
  return {
    reads,
    async readAt(address) {
      const key = BigInt(address);
      reads.push(key);
      return entries.get(key) || null;
    },
  };
}

const cell = 0x9000n;
const taggedPointer = 0xabcd123456789abcn;
const canonicalPointer = 0x123456789abcn;
const entries = new Map([
  [cell, { found: true, bytes: littleEndian(taggedPointer), text: '', terminated: false }],
  [canonicalPointer, { found: true, bytes: new Uint8Array(), text: 'canonical', terminated: true }],
]);
const backend = backendFor(entries);
const model = modelFor(cell);

await resolveModelTexts(backend, model, 96, { architecture: 'arm64e' });

assert.ok(backend.reads.includes(canonicalPointer), 'arm64e must preserve lower-48 VA bits during canonicalization');
assert.ok(!backend.reads.includes(0x456789abcn), 'the old 36-bit mask target must not be read');
assert.equal(model.facts.strings[0], 'canonical');

console.log('issue-4971 arm64 pointer mask: PASS');
