import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { createMachOMetadataBudget } from '../../../js/binary/macho-budget.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

function uleb(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function image(overrides = {}) {
  return {
    metadata: {},
    warnings: [],
    exports: [],
    functions: [],
    libraries: [],
    imageBase: 0x100000000n,
    sectionAt() { return null; },
    ...overrides,
  };
}

function singleEdgeTrie(edge, terminalPayload = [0x00, 0x20]) {
  const edgeBytes = [...new TextEncoder().encode(edge), 0];
  let childOffset = 2 + edgeBytes.length + 1;
  for (;;) {
    const encoded = uleb(childOffset);
    const next = 2 + edgeBytes.length + encoded.length;
    if (next === childOffset) break;
    childOffset = next;
  }
  return Uint8Array.from([
    0x00, 0x01,
    ...edgeBytes,
    ...uleb(childOffset),
    ...uleb(terminalPayload.length),
    ...terminalPayload,
    0x00,
  ]);
}

function twoEdgeTrie() {
  // root -> "ab" -> node @ 6 -> "cd" -> node @ 12 -> regular export @ +0x20
  return Uint8Array.from([
    0x00, 0x01, 0x61, 0x62, 0x00, 0x06,
    0x00, 0x01, 0x63, 0x64, 0x00, 0x0c,
    0x02, 0x00, 0x20, 0x00,
  ]);
}

function rootTerminal(payload) {
  return Uint8Array.from([
    ...uleb(payload.length),
    ...payload,
    0x00,
  ]);
}

function parse(bytes, stringBytes, overrides = {}) {
  const out = image(overrides);
  const budget = createMachOMetadataBudget(out, {
    limits: {
      stringBytes,
      inputBytes: 1 << 20,
      estimatedHeapBytes: 1 << 20,
      operations: 1 << 20,
      records: 1 << 20,
      objects: 1 << 20,
    },
  });
  const status = parseExportTrie(
    new ByteView(bytes, { littleEndian: true }),
    { offset: 0, size: bytes.length },
    out,
    budget,
  );
  return { out, budget, status };
}

// The budget must stop a long edge before TextDecoder allocates the full edge.
{
  const NativeTextDecoder = globalThis.TextDecoder;
  let maxDecodedBytes = 0;
  globalThis.TextDecoder = class TrackingTextDecoder {
    constructor(...args) { this.inner = new NativeTextDecoder(...args); }
    decode(input, ...args) {
      maxDecodedBytes = Math.max(maxDecodedBytes, input?.byteLength ?? 0);
      return this.inner.decode(input, ...args);
    }
  };
  try {
    const bytes = singleEdgeTrie('A'.repeat(256));
    const { out, status } = parse(bytes, 64);
    assert.equal(status.complete, false);
    assert.equal(status.budgetExceeded, true);
    assert.equal(out.exports.length, 0);
    assert.equal(maxDecodedBytes, 0, 'oversized edge must be rejected before decode/allocation');
  } finally {
    globalThis.TextDecoder = NativeTextDecoder;
  }
}

// A NUL that is only reachable beyond the remaining string budget is not scanned into a giant decode.
{
  const NativeTextDecoder = globalThis.TextDecoder;
  let maxDecodedBytes = 0;
  globalThis.TextDecoder = class TrackingTextDecoder {
    constructor(...args) { this.inner = new NativeTextDecoder(...args); }
    decode(input, ...args) {
      maxDecodedBytes = Math.max(maxDecodedBytes, input?.byteLength ?? 0);
      return this.inner.decode(input, ...args);
    }
  };
  try {
    const bytes = singleEdgeTrie('B'.repeat(80));
    const { status } = parse(bytes, 32);
    assert.equal(status.complete, false);
    assert.equal(status.budgetExceeded, true);
    assert.equal(maxDecodedBytes, 0);
  } finally {
    globalThis.TextDecoder = NativeTextDecoder;
  }
}

// Edge strings and the one-time joined path name are both accounted.  The join is denied before allocation.
{
  const { out, budget, status } = parse(twoEdgeTrie(), 15);
  assert.equal(status.complete, false);
  assert.equal(status.budgetExceeded, true);
  assert.equal(out.exports.length, 0);
  assert.equal(budget.snapshot().used.stringBytes, 8, 'only the two decoded edges should be charged before the rejected join');
}

// With enough room, two decoded edge strings (8 bytes UTF-16) plus the joined name (8 bytes) are visible in accounting.
{
  const { out, budget, status } = parse(twoEdgeTrie(), 16);
  assert.equal(status.complete, true);
  assert.equal(out.exports.length, 1);
  assert.equal(out.exports[0].name, 'abcd');
  assert.equal(budget.snapshot().used.stringBytes, 16);
}

// A one-edge name can reuse the decoded edge string without an additional join allocation.
{
  const { out, budget, status } = parse(singleEdgeTrie('ok'), 4);
  assert.equal(status.complete, true);
  assert.equal(out.exports[0].name, 'ok');
  assert.equal(budget.snapshot().used.stringBytes, 4);
  assert.equal(budget.snapshot().used.inputBytes, 3, 'edge bytes including the NUL are charged');
}

// Re-export imported-name CStrings are bounded before decode and retain ordinary small-string behavior.
{
  const NativeTextDecoder = globalThis.TextDecoder;
  let maxDecodedBytes = 0;
  globalThis.TextDecoder = class TrackingTextDecoder {
    constructor(...args) { this.inner = new NativeTextDecoder(...args); }
    decode(input, ...args) {
      maxDecodedBytes = Math.max(maxDecodedBytes, input?.byteLength ?? 0);
      return this.inner.decode(input, ...args);
    }
  };
  try {
    const imported = [...new TextEncoder().encode('C'.repeat(256)), 0];
    const bytes = rootTerminal([0x08, 0x01, ...imported]);
    const { out, status } = parse(bytes, 64, { libraries: ['libx.dylib'] });
    assert.equal(status.complete, false);
    assert.equal(status.budgetExceeded, true);
    assert.equal(out.exports.length, 0);
    assert.equal(maxDecodedBytes, 0, 'oversized re-export name must be rejected before decode/allocation');
  } finally {
    globalThis.TextDecoder = NativeTextDecoder;
  }
}

{
  const imported = [...new TextEncoder().encode('target'), 0];
  const bytes = rootTerminal([0x08, 0x01, ...imported]);
  const { out, budget, status } = parse(bytes, 12, { libraries: ['libx.dylib'] });
  assert.equal(status.complete, true);
  assert.equal(out.exports.length, 1);
  assert.equal(out.exports[0].imported, 'target');
  assert.equal(budget.snapshot().used.stringBytes, 12);
  assert.equal(budget.snapshot().used.inputBytes, 7, 're-export imported bytes including the NUL are charged');
}

console.log('issue-4154-macho-export-trie-string-budget: PASS');
