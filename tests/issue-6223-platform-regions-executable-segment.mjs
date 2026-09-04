import test from 'node:test';
import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { describeBinaryImage, regionsForImage } from '../js/platform/describe.js';

test('issue #6223: executable segment + non-ALLOC .comment retains executable region', () => {
  const image = new BinaryImage(new Uint8Array(0x200), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  image.addSection({
    name: '.comment',
    address: 0n,
    size: 0x20n,
    fileOffset: 0x100n,
    fileSize: 0x20n,
    perms: { read: false, write: false, execute: false },
    source: 'section-header',
  });

  const regions = regionsForImage(image);
  const execRegions = regions.filter((r) => r.exec);
  assert.equal(execRegions.length, 1);
  assert.equal(execRegions[0].vmAddr, 0x1000n);
  assert.equal(execRegions[0].size, 0x100n);
  assert.equal(execRegions[0].kind, 'segment');
});

test('issue #6223: executable segment + non-ALLOC .strtab retains executable region', () => {
  const image = new BinaryImage(new Uint8Array(0x300), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x400000n,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  image.addSection({
    name: '.strtab',
    address: 0n,
    size: 0x80n,
    fileOffset: 0x1000n,
    fileSize: 0x80n,
    perms: { read: false, write: false, execute: false },
    source: 'section-header',
  });

  const regions = regionsForImage(image);
  const execRegions = regions.filter((r) => r.exec);
  assert.equal(execRegions.length, 1);
  assert.equal(execRegions[0].vmAddr, 0x400000n);
  assert.equal(execRegions[0].size, 0x1000n);
});

test('issue #6223: mapped executable section completely covering segment does not duplicate scan', () => {
  const image = new BinaryImage(new Uint8Array(0x1000), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x1000n,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  image.addSection({
    name: '.text',
    address: 0x1000n,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
    source: 'section-header',
  });

  const regions = regionsForImage(image);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'section');
  assert.equal(regions[0].name, '.text');
  assert.equal(regions[0].exec, true);
});

test('issue #6223: section table missing falls back to segments', () => {
  const image = new BinaryImage(new Uint8Array(0x1000), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x1000n,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  const regions = regionsForImage(image);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'segment');
  assert.equal(regions[0].vmAddr, 0x1000n);
  assert.equal(regions[0].exec, true);
});

test('issue #6223: partial section coverage retains uncovered executable segment span', () => {
  const image = new BinaryImage(new Uint8Array(0x2000), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x1000n,
    size: 0x2000n,
    fileOffset: 0n,
    fileSize: 0x2000n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  image.addSection({
    name: '.text',
    address: 0x1000n,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: true },
    source: 'section-header',
  });

  const regions = regionsForImage(image);
  assert.equal(regions.length, 2);
  const sec = regions.find((r) => r.kind === 'section');
  assert.equal(sec.name, '.text');
  assert.equal(sec.vmAddr, 0x1000n);
  assert.equal(sec.size, 0x1000n);

  const seg = regions.find((r) => r.kind === 'segment');
  assert.ok(seg);
  assert.equal(seg.vmAddr, 0x2000n);
  assert.equal(seg.size, 0x1000n);
  assert.equal(seg.exec, true);
});

test('issue #6223: describeBinaryImage slices and productDescriptor have identical safe regions', () => {
  const image = new BinaryImage(new Uint8Array(0x200), {
    format: 'elf',
    arch: 'x86_64',
    bits: 64,
  });

  image.addSegment({
    name: 'LOAD0',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
    source: 'PT_LOAD',
  });

  image.addSection({
    name: '.comment',
    address: 0n,
    size: 0x20n,
    fileOffset: 0x100n,
    fileSize: 0x20n,
    perms: { read: false, write: false, execute: false },
    source: 'section-header',
  });

  const desc = describeBinaryImage(image);
  assert.equal(desc.slices[0].regions, desc.productDescriptor.regions);
  const execRegion = desc.slices[0].regions.find((r) => r.exec);
  assert.ok(execRegion);
  assert.equal(execRegion.vmAddr, 0x1000n);
  assert.equal(desc.slices[0].info.textVM, 0x1000n);
});
