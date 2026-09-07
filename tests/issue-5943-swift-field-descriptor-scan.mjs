import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSwiftMetadataModel, parseSwiftFieldDescriptorScan, parseSwiftFieldDescriptor } from '../js/swift.js';

function u8(...bytes) { return Uint8Array.from(bytes); }
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function descriptorImage({ recordSize = 12, count = 0, records = [], breaks = [], rejects = [] } = {}) {
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
    if (rejects.some(([b0, b1]) => start >= b0 && end <= b1)) throw new Error('synthetic-read-rejection');
    if (breaks.some(([b0, b1]) => start >= b0 && end <= b1)) return null;
    if (start < 0n || end > BigInt(image.length)) return null;
    return image.subarray(Number(start), Number(end));
  };
  return { image, read, u16le, u32le };
}

function writeU16(image, offset, value) {
  image[offset] = value & 0xff;
  image[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(image, offset, value) {
  image[offset] = value & 0xff;
  image[offset + 1] = (value >>> 8) & 0xff;
  image[offset + 2] = (value >>> 16) & 0xff;
  image[offset + 3] = (value >>> 24) & 0xff;
}

function writeI32(image, offset, value) {
  writeU32(image, offset, value >>> 0);
}

function rejectingModelImage() {
  const image = new Uint8Array(400);
  writeI32(image, 0, 100); // __swift5_types entry -> nominal descriptor @100.
  writeU32(image, 100, 17); // struct context descriptor.
  writeI32(image, 108, 72); // name field @108 -> "Pair" @180.
  writeI32(image, 116, 184); // fieldDescriptor field @116 -> descriptor @300.
  writeU32(image, 120, 2); // declared nominal fields.
  image.set(new TextEncoder().encode('Pair\0'), 180);
  writeU16(image, 310, 12); // FieldRecordSize.
  writeU32(image, 312, 2); // NumFields.

  const read = async (addr, len, allowPartial = false) => {
    const start = BigInt(addr), end = start + BigInt(len);
    if (start === 328n && len === 12) throw new Error('synthetic-record-read-rejection');
    if (start < 0n || start >= BigInt(image.length)) return null;
    if (end > BigInt(image.length)) {
      return allowPartial ? image.subarray(Number(start)) : null;
    }
    return image.subarray(Number(start), Number(end));
  };
  return { image, read };
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

test('#5943 rejected descriptor header fails closed instead of throwing', async () => {
  const read = async () => { throw new Error('synthetic-header-read-rejection'); };
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.deepEqual(scan.fields, []);
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.reason, 'descriptor-header-unreadable');
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
  assert.equal(scan.completeness.declared, 4097);
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

test('#5943 rejected record read retains parsed fields and marks incomplete', async () => {
  const record = (i) => u8(...new Array(12).fill(0).map((_, k) => (i === 1 && k === 0 ? 0 : i * 12 + k)));
  const { read } = descriptorImage({
    recordSize: 12, count: 2,
    records: [record(0), record(1)],
    rejects: [[28n, 40n]],
  });
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, 4096);
  assert.equal(scan.fields.length, 1, 'fields parsed before a rejected read are retained');
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.reason, 'field-record-unreadable');
  assert.equal(scan.completeness.declared, 2);
  assert.equal(scan.completeness.scanned, 1);
  assert.equal(scan.completeness.parsed, 1);
  assert.equal(scan.completeness.unreadableEntries, 1);
});

test('#5943 rejected field-name read retains prior fields and marks incomplete', async () => {
  const record = (i) => u8(...new Array(12).fill(0).map((_, k) => i * 12 + k));
  const { image, read } = descriptorImage({
    recordSize: 12, count: 2, records: [record(0), record(1)],
  });
  writeI32(image, 36, 164); // second record name pointer targets address 200.
  const rejectingRead = async (addr, len, allowPartial = false) => {
    if (BigInt(addr) === 200n) throw new Error('synthetic-field-name-read-rejection');
    return read(addr, len, allowPartial);
  };
  const scan = await parseSwiftFieldDescriptorScan(rejectingRead, 0n, 4096);
  assert.equal(scan.fields.length, 1, 'fields parsed before a rejected name read are retained');
  assert.equal(scan.fields[0].name, 'field_0');
  assert.equal(scan.completeness.complete, false);
  assert.equal(scan.completeness.reason, 'field-name-unreadable');
  assert.equal(scan.completeness.declared, 2);
  assert.equal(scan.completeness.scanned, 1);
  assert.equal(scan.completeness.parsed, 1);
  assert.equal(scan.completeness.unreadableEntries, 1);
});

test('#5943 metadata model retains fields parsed before a rejected record read', async () => {
  const { read } = rejectingModelImage();
  const model = await buildSwiftMetadataModel(read, [{ section: '__swift5_types', vmAddr: 0n, size: 4n }], {
    reader: read,
    budget: 4096,
  });
  assert.ok(model);
  assert.equal(model.types.length, 1);
  assert.equal(model.types[0].name, 'Pair');
  assert.equal(model.types[0].fields.length, 1, 'model keeps fields parsed before the rejection');
  assert.equal(model.types[0].fields[0].name, 'field_0');
  assert.equal(model.completeness.types.complete, false);
  assert.equal(model.complete, false);
  assert.ok(model.warnings.some((warning) => warning.includes('field metadata is incomplete (field-record-unreadable)')));
  assert.ok(!model.warnings.some((warning) => warning.includes('field metadata could not be parsed')),
    'rejected record reads are structured incompleteness, not a parser throw');
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
