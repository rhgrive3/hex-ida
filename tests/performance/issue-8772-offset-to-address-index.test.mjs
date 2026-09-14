import assert from 'node:assert/strict';
import test from 'node:test';

import { BinaryImage, sectionHasMappedAddress } from '../../js/binary/model.js';
import { inRange } from '../../js/binary/reader.js';

// #8772: BinaryImage.offsetToAddress() had no file-offset index. Every call linearly
// scanned all sections and all segments, sorted the candidates, and then re-resolved
// virtual ownership per candidate — so a scanner that resolves one address per emitted
// string did Θ(strings × mappings) work and a ~1.66 MiB image with 24k small sections
// stalled the resident string scan far beyond any budget. Resolution must be served from
// an index, and the result must stay identical to the previous scan semantics.

// Reference implementation: the pre-fix scan, verbatim.
function offsetToAddressByScan(image, o) {
  const candidates = [];
  for (const s of image.sections) {
    if (!sectionHasMappedAddress(s) || s.address == null || !inRange(o, s.fileOffset, s.fileSize)) continue;
    candidates.push(s);
  }
  for (const s of image.segments) {
    if (!inRange(o, s.fileOffset, s.fileSize)) continue;
    candidates.push(s);
  }
  candidates.sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : 0));
  for (const s of candidates) {
    const a = s.address + (o - s.fileOffset);
    const owner = image._virtualMappingAt(a);
    if (owner) {
      const delta = a - owner.address;
      const fileSize = owner.fileSize ?? 0n;
      if (delta < fileSize && (owner.fileOffset + delta) === o) return a;
    }
  }
  return null;
}

let seed = 0x1234abc;
function random(limit) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % limit;
}

function randomImage() {
  const image = new BinaryImage(new Uint8Array(4096), { format: 'test' });
  const count = 1 + random(10);
  for (let i = 0; i < count; i++) {
    const mapping = {
      name: `m${i}`,
      address: BigInt(random(60)),
      size: BigInt(random(25)),
      fileOffset: BigInt(random(60)),
      fileSize: BigInt(random(25)),
      perms: { read: true },
    };
    if (random(2) === 0) {
      if (random(4) === 0) { mapping.source = 'section-header'; mapping.flags = random(8); }
      image.addSection(mapping);
    } else {
      image.addSegment(mapping);
    }
  }
  return image;
}

test('#8772 indexed offset resolution matches the previous scan semantics exactly', () => {
  for (let trial = 0; trial < 250; trial++) {
    const image = randomImage();
    for (let offset = 0n; offset < 90n; offset++) {
      assert.equal(
        image.offsetToAddress(offset),
        offsetToAddressByScan(image, offset),
        `trial ${trial} offset ${offset}`,
      );
    }
  }
});

test('#8772 overlapping file ranges still prefer the smallest candidate and re-check ownership', () => {
  const image = new BinaryImage(new Uint8Array(1024), { format: 'test' });
  image.addSegment({ name: 'wide-segment', address: 0x4000n, size: 0x400n, fileOffset: 0n, fileSize: 0x400n, perms: { read: true } });
  image.addSection({ name: 'narrow-section', address: 0x1000n, size: 0x40n, fileOffset: 0x100n, fileSize: 0x40n, perms: { read: true } });
  // 0x110 is inside the narrow section (file 0x100..0x140) and the wide segment, whose
  // file range also starts at 0x0; the narrower candidate must win.
  assert.equal(image.offsetToAddress(0x110n), 0x1010n);
  // A candidate whose virtual position is owned by a *different* mapping fails closed:
  // `shadowed` covers file 0x200..0x240 at address 0x2000, but the narrower
  // `owner` mapping owns address 0x2010 and points at unrelated file bytes.
  const ownerCheck = new BinaryImage(new Uint8Array(1024), { format: 'test' });
  ownerCheck.addSection({ name: 'shadowed', address: 0x2000n, size: 0x40n, fileOffset: 0x200n, fileSize: 0x40n, perms: { read: true } });
  ownerCheck.addSection({ name: 'owner', address: 0x2010n, size: 0x4n, fileOffset: 0x900n, fileSize: 0x4n, perms: { read: true } });
  assert.equal(ownerCheck.offsetToAddress(0x210n), null);
  assert.equal(ownerCheck.offsetToAddress(0x901n), 0x2011n);
  // Outside every file range.
  assert.equal(image.offsetToAddress(0x900n), null);
  // The scan contract keeps non-canonical inputs null instead of coercing them.
  assert.equal(image.offsetToAddress(1.5), null);
  assert.equal(image.offsetToAddress('   '), null);
  assert.equal(image.offsetToAddress(-1n), null);
});

test('#8772 resolution is served from the mapping index, not a per-call array scan', () => {
  const image = new BinaryImage(new Uint8Array(4096), { format: 'test' });
  for (let i = 0; i < 500; i++) {
    image.addSection({
      name: `.s${i}`, address: BigInt(0x1000 + i * 8), size: 8n,
      fileOffset: BigInt(i * 8), fileSize: 8n, perms: { read: true },
    });
  }
  for (let i = 0; i < 200; i++) {
    image.addSegment({
      name: `.g${i}`, address: BigInt(0x4000 + i * 8), size: 8n,
      fileOffset: BigInt(2000 + i * 8), fileSize: 8n, perms: { read: true, execute: true },
    });
  }
  assert.equal(image.offsetToAddress(8n), 0x1008n); // warms the index
  let arrayReads = 0;
  const spy = (target) => new Proxy(target, {
    get(obj, property) {
      if (property !== 'length' && typeof property !== 'symbol') arrayReads++;
      return obj[property];
    },
  });
  image.sections = spy(image.sections);
  image.segments = spy(image.segments);
  for (let i = 0; i < 700; i++) image.offsetToAddress(BigInt(i * 8));
  assert.equal(arrayReads, 0, `offset resolution read ${arrayReads} mapping-array elements directly`);
});

test('#8772 the string-scale counterexample stays bounded instead of quadratic', () => {
  const count = 16000;
  const base = 0x100000000n;
  const image = new BinaryImage(new Uint8Array(count * 16), { format: 'test', arch: 'x86_64', bits: 64 });
  for (let i = 0; i < count; i++) {
    image.addSection({
      name: `.d${i}`, address: base + BigInt(i) * 16n, size: 8n,
      fileOffset: BigInt(i) * 16n, fileSize: 8n, perms: { read: true },
    });
  }
  const started = process.hrtime.bigint();
  let resolved = 0;
  for (let i = 0; i < count; i++) {
    if (image.offsetToAddress(BigInt(i) * 16n + 2n) !== null) resolved++;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(resolved, count);
  // 16k resolutions over 16k disjoint mappings took ~28.5 s per lookup-set before the
  // index existed; the bounded path stays far below this ceiling.
  assert.ok(elapsedMs < 10000, `${count} resolutions took ${elapsedMs.toFixed(0)} ms`);
});
