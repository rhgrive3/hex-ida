import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlideInfo5Structure, walkSlideInfo5Sync } from '../../js/binary/dyld-shared-cache-slide-v5.js';

function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }
function u16(b, o, v) { new DataView(b.buffer).setUint16(o, v, true); }

test('slide info v5 decodes regular/auth chains with pointer-unit deltas', () => {
  const pageSize = 4096;
  const mapping = { address: 0x180000000n, size: 4096n, fileOffset: 0n };
  const mappings = [mapping];
  const infoBytes = new Uint8Array(26);
  u32(infoBytes, 0, 5); u32(infoBytes, 4, pageSize); u32(infoBytes, 8, 1); u32(infoBytes, 12, 0);
  u64(infoBytes, 16, 0x180000000n); u16(infoBytes, 24, 2);
  const info = parseSlideInfo5Structure(infoBytes, mapping, 4096n);
  const data = new Uint8Array(pageSize);
  const regular = 0x120n | (0xABn << 34n) | (3n << 52n);
  const auth = 0x240n | (0x1234n << 34n) | (1n << 50n) | (1n << 51n) | (1n << 63n);
  u64(data, 16, regular); u64(data, 40, auth);
  const records = walkSlideInfo5Sync(data, mapping, info, 0x4000n, mappings, 8);
  assert.equal(records.length, 2);
  assert.equal(records[0].storageAddress, 0x180000010n);
  assert.equal(records[0].targetAddress, 0x180000120n);
  assert.equal(records[0].runtimeTargetAddress, 0x180004120n);
  assert.equal(records[0].authenticated, false);
  assert.equal(records[0].high8, 0xAB);
  assert.equal(records[1].storageAddress, 0x180000028n);
  assert.equal(records[1].targetAddress, 0x180000240n);
  assert.equal(records[1].authenticated, true);
  assert.equal(records[1].diversity, 0x1234);
  assert.equal(records[1].addressDiversity, true);
  assert.equal(records[1].keyIsData, true);
});

test('slide info v5 accepts cross-subcache targets only inside declared shared region', () => {
  const mapping = { address: 0x180000000n, size: 4096n, fileOffset: 0n };
  const infoBytes = new Uint8Array(26);
  u32(infoBytes, 0, 5); u32(infoBytes, 4, 4096); u32(infoBytes, 8, 1); u64(infoBytes, 16, 0x180000000n); u16(infoBytes, 24, 0);
  const info = parseSlideInfo5Structure(infoBytes, mapping, 4096n);
  const data = new Uint8Array(4096);
  u64(data, 0, 0x5000n);
  assert.throws(() => walkSlideInfo5Sync(data, mapping, info, 0n, [mapping], 4), /outside declared shared region/);
  const records = walkSlideInfo5Sync(data, mapping, info, 0n, [mapping], 4, { start: 0x180000000n, size: 0x10000n });
  assert.equal(records.length, 1);
  assert.equal(records[0].targetAddress, 0x180005000n);
  assert.equal(records[0].targetInCurrentFileMappings, false);
  assert.equal(records[0].targetInSharedRegion, true);
});

test('slide info v5 rejects malformed page counts', () => {
  const mapping = { address: 0x180000000n, size: 4096n, fileOffset: 0n };
  const infoBytes = new Uint8Array(26);
  u32(infoBytes, 0, 5); u32(infoBytes, 4, 4096); u32(infoBytes, 8, 2); u64(infoBytes, 16, 0x180000000n);
  assert.throws(() => parseSlideInfo5Structure(infoBytes, mapping, 4096n), /page count/);
});
