import assert from 'node:assert/strict';
import test from 'node:test';

import { BinaryImage } from '../../js/binary/model.js';
import { MemoryByteSource } from '../../js/binary/source.js';
import { scanStrings } from '../../js/binary/strings.js';
import { scanSourceStrings } from '../../js/bytesource/strings.js';

// #8736: the eligible scan domain was built as one range per mapping, so N sections
// aliasing the same file bytes made both scanners traverse those bytes N times. `seen`
// only suppressed duplicate results after the work, so the result cap could never be
// reached and a counting ByteSource re-read one physical range once per alias. The domain
// is a union now: each eligible byte is claimed by exactly one range, first claimant wins.

const PAYLOAD = 4096;

function aliasBytes() {
  const bytes = new Uint8Array(PAYLOAD + 64);
  bytes.fill(0x41, 32, 32 + PAYLOAD);
  for (let at = 32; at < 32 + PAYLOAD; at += 97) bytes[at] = 0x00;
  return bytes;
}

function aliasImage(bytes, aliases) {
  const image = new BinaryImage(bytes, { format: 'test', arch: 'x86_64', bits: 64 });
  for (let i = 0; i < aliases; i++) {
    image.addSection({
      name: `.alias${i}`, address: BigInt(0x1000 + i), size: BigInt(PAYLOAD),
      fileOffset: 32n, fileSize: BigInt(PAYLOAD), perms: { read: true },
    });
  }
  return image;
}

function addAliases(image, aliases, fileOffset, size) {
  for (let i = 0; i < aliases; i++) {
    image.addSection({
      name: `.alias${i}`, address: BigInt(0x1000 + i * 0x1000), size,
      fileOffset, fileSize: size, perms: { read: true },
    });
  }
  return image;
}

// A binary byte backing that counts every element probe, so the observable is work and
// not wall-clock.
function countingBytes(bytes) {
  let probes = 0;
  const target = {
    __binaryByteBacking: true,
    subarray: (from, to) => bytes.subarray(from, to),
  };
  const proxy = new Proxy(target, {
    get(obj, property) {
      if (typeof property === 'symbol') return obj[property];
      if (property === '__binaryByteBacking' || property === 'subarray') return obj[property];
      if (property === 'length') return bytes.length;
      if (!/^[0-9]+$/.test(property)) return obj[property];
      probes++;
      return bytes[Number(property)];
    },
  });
  return { proxy, probes: () => probes };
}

const options = { utf16: false, minLength: 4, maxLength: 4096, limit: 200000 };

test('#8736 aliased sections yield exactly the results of a single section', () => {
  const bytes = aliasBytes();
  const one = scanStrings(aliasImage(bytes, 1), options);
  assert.ok(one.length > 1);
  for (const aliases of [8, 200, 5000]) {
    assert.deepEqual(scanStrings(aliasImage(bytes, aliases), options), one,
      `${aliases} aliases must not add, drop, or reattribute results`);
  }
});

test('#8736 the resident scan probes each eligible byte once, independent of alias count', () => {
  const counts = [];
  for (const aliases of [1, 400]) {
    const bytes = aliasBytes();
    const counter = countingBytes(bytes);
    scanStrings(aliasImage(counter.proxy, aliases), options);
    counts.push(counter.probes());
  }
  const [single, aliased] = counts;
  assert.ok(single > PAYLOAD / 2, `the single-section baseline should sweep the payload, saw ${single} probes`);
  assert.ok(aliased <= single, `400 aliases probed ${aliased} times against ${single} for one`);
});

test('#8736 the source-backed scan does not reread aliased bytes', async () => {
  const reference = await runSourceScan(1);
  assert.ok(reference.results.length > 1);
  for (const aliases of [100, 1000]) {
    const scan = await runSourceScan(aliases);
    assert.equal(scan.reads, 1, `${aliases} aliases caused ${scan.reads} source reads for one 4 KiB range`);
    assert.equal(scan.logical, PAYLOAD);
    assert.deepEqual(scan.results, reference.results, `${aliases} aliases changed the source scan results`);
  }
});

async function runSourceScan(aliases) {
  const bytes = aliasBytes();
  const source = new MemoryByteSource(bytes, { maxReadLength: 64 * 1024 });
  let reads = 0;
  let logical = 0;
  const original = source.readExactly.bind(source);
  source.readExactly = async (offset, length, opts) => {
    reads++; logical += Number(length);
    return original(offset, length, opts);
  };
  const image = new BinaryImage(null, {
    format: 'test', source, fileSize: BigInt(bytes.length), arch: 'x86_64', bits: 64,
  });
  addAliases(image, aliases, 32n, BigInt(PAYLOAD));
  const scan = await scanSourceStrings(image, source, { ...options, chunkSize: 64 * 1024 });
  return { reads, logical, results: scan.results };
}

test('#8736 each eligible byte belongs to one range and the first claimant owns the overlap', () => {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = 0x30 + (i % 60);
  const image = new BinaryImage(bytes, { format: 'test' });
  image.addSection({ name: 'first', address: 0x1000n, size: 0x400n, fileOffset: 0n, fileSize: 0x400n, perms: { read: true } });
  image.addSection({ name: 'alias', address: 0x2000n, size: 0x400n, fileOffset: 0n, fileSize: 0x400n, perms: { read: true } });
  image.addSection({ name: 'tail', address: 0x3000n, size: 0x200n, fileOffset: 0x300n, fileSize: 0x200n, perms: { read: true } });
  const opts = { utf16: false, minLength: 8, maxLength: 64, limit: 100000 };
  const results = scanStrings(image, opts);
  assert.ok(results.length > 0);
  const offsets = results.map((entry) => entry.fileOffset);
  assert.equal(new Set(offsets).size, offsets.length, 'one byte offset was emitted twice');
  assert.ok(offsets.every((offset) => offset < 0x500n), 'bytes outside the eligible union were scanned');
  assert.ok(results.some((entry) => entry.section === 'first'));
  assert.ok(results.some((entry) => entry.section === 'tail'));
  assert.ok(!results.some((entry) => entry.section === 'alias'), 'a fully aliased range must not rescan claimed bytes');
  assert.deepEqual(scanStrings(image, opts), results);
});

test('#8736 a partially overlapping mapping reports only the bytes it newly claims', () => {
  // Documented boundary rule: the first claimant owns the overlap, so a mapping that
  // starts inside an earlier mapping contributes only its exclusive tail. Every eligible
  // byte is therefore still reported, and no byte is reported twice.
  const bytes = new Uint8Array(512);
  bytes.fill(0x5a, 0, 128);
  bytes.fill(0x21, 128, 512);
  const image = new BinaryImage(bytes, { format: 'test' });
  image.addSection({ name: 'earlier', address: 0x1000n, size: 0x21n, fileOffset: 0n, fileSize: 128n, perms: { read: true } });
  image.addSection({ name: 'later', address: 0x2000n, size: 0x100n, fileOffset: 0x40n, fileSize: 0x1c0n, perms: { read: true } });
  const results = scanStrings(image, { utf16: false, minLength: 8, maxLength: 512 });
  const offsets = results.map((entry) => Number(entry.fileOffset));
  assert.deepEqual(offsets, [0, 128], 'the union must be reported once with claim-boundary attribution');
  assert.deepEqual(results.map((entry) => entry.section), ['earlier', 'later']);
  assert.equal(results[0].byteLength, 128);
  assert.equal(results[1].byteLength, 512 - 128);
});

test('#8736 executable filtering is applied to the union, not after duplicate scanning', () => {
  const bytes = new Uint8Array(1024);
  bytes.fill(0x42, 0, 512);
  const build = () => {
    const image = new BinaryImage(bytes, { format: 'test' });
    image.addSection({ name: 'rx', address: 0x1000n, size: 0x200n, fileOffset: 0n, fileSize: 0x200n, perms: { read: true, execute: true } });
    image.addSection({ name: 'rw', address: 0x2000n, size: 0x200n, fileOffset: 0x100n, fileSize: 0x200n, perms: { read: true } });
    image.addSection({ name: 'rw-alias', address: 0x3000n, size: 0x200n, fileOffset: 0x100n, fileSize: 0x200n, perms: { read: true } });
    return image;
  };
  const opts = { utf16: false, minLength: 4, maxLength: 256 };
  const withoutExecutable = scanStrings(build(), opts);
  const withExecutable = scanStrings(build(), { ...opts, includeExecutable: true });
  // The executable prefix is skipped, but the non-executable alias that straddles it is
  // still scanned from its own start, and its duplicate alias never re-reads claimed bytes.
  assert.ok(withoutExecutable.length > 0);
  assert.ok(withoutExecutable.every((entry) => entry.fileOffset >= 0x100n));
  assert.ok(!withoutExecutable.some((entry) => entry.section === 'rx'));
  assert.ok(withExecutable.some((entry) => entry.fileOffset < 0x100n), 'executable inclusion found no prefix bytes');
  for (const results of [withoutExecutable, withExecutable]) {
    const offsets = results.map((entry) => `${entry.fileOffset}:${entry.encoding}`);
    assert.equal(new Set(offsets).size, offsets.length);
  }
  assert.deepEqual(scanStrings(build(), opts), withoutExecutable);
});

test('#8736 segment gap coverage from #3766 survives the section union', () => {
  const bytes = new Uint8Array(1024);
  bytes.fill(0x5a, 0, 256);
  bytes.fill(0x21, 400, 600);
  const image = new BinaryImage(bytes, { format: 'test' });
  image.addSection({ name: 'covered', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  image.addSection({ name: 'covered-alias', address: 0x2000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n, perms: { read: true } });
  image.addSegment({ name: 'segment', address: 0x3000n, size: 0x400n, fileOffset: 0n, fileSize: 0x400n, perms: { read: true } });
  const results = scanStrings(image, { utf16: false, minLength: 4, maxLength: 256 });
  const offsets = results.map((entry) => Number(entry.fileOffset));
  assert.ok(offsets.some((offset) => offset >= 256 && offset < 512), 'segment-only gap bytes were not scanned');
  assert.ok(offsets.every((offset) => offset < 512), 'the scan exceeded the segment file range');
  assert.equal(new Set(offsets).size, offsets.length);
  assert.ok(results.some((entry) => entry.section === 'covered'));
  assert.ok(!results.some((entry) => entry.section === 'covered-alias'));
});
