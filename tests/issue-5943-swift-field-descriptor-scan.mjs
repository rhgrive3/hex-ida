import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSwiftFieldDescriptorScan, parseSwiftFieldDescriptor } from '../js/swift.js';

function u8(...bytes) { return Uint8Array.from(bytes); }
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function descriptorImage({ recordSize = 12, count = 0, records = [], breaks = [] } = {}) {
  const header = new Uint8Array(16);
  header[10] = recordSize & 0xff; header[11] = (recordSize >> 8) & 0xff;
  header[12] = count & 0xff; header[13] = (count >> 8) & 0xff;
  header[14] = (count >> 16) & 0xff; header[15] = (count >> 24) & 0xff;
  const body = new Uint8Array(records.length * recordSize);
  records.forEach((r, i) => body.set(r, i * recordSize));
  const image = new Uint8Array(header.length + body.length);
  image.set(header, 0); image.set(body, header.length);
  const read = async (addr, len) => {
    const start = BigInt(addr), end = start + BigInt(len);
    if (breaks.some(([b0, b1]) => start >= b0 && end <= b1)) return null;
    if (start < 0n || end > BigInt(image.length)) return null;
    return image.subarray(Number(start), Number(end));
  };
  return { image, read, u16le, u32le };
}

test('#5943 count=0 descriptor is complete and empty', async () => {
  const { read } = descriptorImage({ count: 0 });
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.deepEqual(scan.fields, []);
  assert.equal(scan.completeness.complete, true);
  assert.equal(scan.completeness.declared, 0);
});

test('#5943 unreadable descriptor header fails closed with a reason', async () => {
  const { image } = descriptorImage({ count: 0 });
  const read = async () => null;
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.deepEqual(scan.fields, []);
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.reason, 'descriptor-header-unreadable');
  void image;
});

test('#5943 invalid record size fails closed', async () => {
  const { read } = descriptorImage({ recordSize: 8, count: 1 });
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.invalidHeader, true);
  assert.equal(scan.completeness.reason, 'descriptor-record-size-invalid');
});

test('#5943 declared count beyond the budget is capped, not silently empty', async () => {
  const { read } = descriptorImage({ recordSize: 12, count: 4097 });
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.deepEqual(scan.fields, []);
  assert.equal(scan.completeness.capped, true);
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.reason, 'descriptor-count-exceeds-budget');
});

test('#5943 mid-way unreadable record keeps parsed fields but marks incomplete', async () => {
  const record = (i) => u8(...new Array(12).fill(0).map((_, k) => (i === 1 && k === 0 ? 0 : i * 12 + k)));
  const { read } = descriptorImage({
    recordSize: 12, count: 2,
    records: [record(0), record(1)],
    breaks: [[28n, 40n]],
  });
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.equal(scan.fields.length, 1, 'parsed fields are retained');
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.parsed, 1);
  assert.equal(scan.completeness.unreadableEntries, 1);
});

test('#5943 fully readable descriptor keeps the legacy array contract', async () => {
  const record = (i) => u8(...new Array(12).fill(0).map((_, k) => i * 12 + k));
  const { read } = descriptorImage({ recordSize: 12, count: 2, records: [record(0), record(1)] });
  const fields = await parseSwiftFieldDescriptor(read, 0n, 4096);
  assert.equal(fields.length, 2, 'legacy wrapper still returns the bare array');
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.equal(scan.completeness.complete, true);
  assert.deepEqual(scan.fields, fields);
});
