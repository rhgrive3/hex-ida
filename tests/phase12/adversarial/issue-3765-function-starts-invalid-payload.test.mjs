import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachO } from '../../../js/binary/macho.js';

function fixture({ functionStarts = { offset: 0x300, size: 1 }, payload = [0] } = {}) {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x | 0, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // ARM64 MH_EXECUTE: LC_SEGMENT_64 + LC_FUNCTION_STARTS + LC_DYLD_EXPORTS_TRIE.
  u32(0, 0xfeedfacf); i32(4, 0x0100000c); i32(8, 0); u32(12, 2);
  u32(16, 3); u32(20, 152 + 16 + 16); u32(24, 0); u32(28, 0);

  // File-backed executable __TEXT,__text covering export target imageBase+8.
  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000);
  u64(p + 40, 0); u64(p + 48, 0x200);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 1); u32(p + 68, 0);
  p += 72;
  put(p, '__text'); put(p + 16, '__TEXT');
  u64(p + 32, 0x1000); u64(p + 40, 0x100);
  u32(p + 48, 0); u32(p + 52, 2); u32(p + 64, 0x80000400);

  // LC_FUNCTION_STARTS.
  p = 184;
  u32(p, 0x26); u32(p + 4, 16);
  u32(p + 8, functionStarts.offset); u32(p + 12, functionStarts.size);
  if (functionStarts.offset < bytes.length) {
    bytes.set(payload.slice(0, Math.max(0, bytes.length - functionStarts.offset)), functionStarts.offset);
  }

  // Export trie: `foo` => imageBase + 8 (0x1008).
  p = 200;
  u32(p, 0x80000033); u32(p + 4, 16); u32(p + 8, 0x380); u32(p + 12, 11);
  bytes.set([0x00, 0x01, 0x66, 0x6f, 0x6f, 0x00, 0x07, 0x02, 0x00, 0x08, 0x00], 0x380);

  return parseMachO(bytes);
}

function assertInvalidPayload(image) {
  assert.equal(image.metadata.functionStarts?.complete, false,
    'an undecodable LC_FUNCTION_STARTS payload must materialize incomplete state');
  assert.equal(image.metadata.functionStarts.partialReason, 'invalid-or-truncated-payload');
  assert.equal(image.metadata.machoMetadata.complete, false,
    'invalid function-start payload must lower Mach-O metadata completeness');
  assert.ok(image.metadata.machoMetadata.reasons.includes('function-starts-invalid-payload'));
  const exportSeed = image.functions.find((f) => f.source === 'export');
  assert.ok(exportSeed, 'invalid function-start payload is not closed-world exclusion evidence');
  assert.equal(exportSeed.address, 0x1008n);
}

test('#3765 zero-size LC_FUNCTION_STARTS is explicit partial metadata', () => {
  assertInvalidPayload(fixture({ functionStarts: { offset: 0x300, size: 0 }, payload: [] }));
});

test('#3765 payload offset past EOF is explicit partial metadata', () => {
  assertInvalidPayload(fixture({ functionStarts: { offset: 0x401, size: 1 }, payload: [] }));
});

test('#3765 payload extent crossing EOF is explicit partial metadata', () => {
  assertInvalidPayload(fixture({ functionStarts: { offset: 0x3ff, size: 2 }, payload: [0] }));
});

test('#3765 valid terminated stream retains authoritative behavior', () => {
  const image = fixture();
  assert.equal(image.metadata.functionStarts.complete, true);
  assert.equal(image.metadata.functionStarts.partialReason, null);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.ok(!image.functions.some((f) => f.source === 'export'),
    'complete empty function-start table remains closed-world exclusion evidence');
});

console.log('issue #3765 LC_FUNCTION_STARTS invalid-payload regressions PASS');
