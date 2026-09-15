import assert from 'node:assert/strict';
import { regionsForImage, describeBinaryImage } from '../js/platform/describe.js';

const image = {
  arch: 'x86_64', bits: 64, endian: 'little', format: 'elf',
  imageBase: 0x1000n,
  fileSize: 8n,
  fileOffset: 0n,
  metadata: {}, warnings: [], libraries: [], imports: [], exports: [],
  sections: [{
    name: '.text.head',
    address: 0x1000n,
    size: 4n,
    fileOffset: 0n,
    fileSize: 4n,
    perms: { read: true, write: false, execute: true },
  }],
  segments: [{
    name: 'LOAD',
    address: 0x1000n,
    size: 8n,
    fileOffset: 0n,
    fileSize: 8n,
    perms: { read: true, write: false, execute: true },
  }],
  summary() { return {}; },
};

const regions = regionsForImage(image);
const execRegions = regions.filter((r) => r.exec);
assert.equal(execRegions.length, 2, 'uncovered executable segment suffix must remain in the region graph');
const covered = execRegions.find((r) => r.kind === 'section');
const suffix = execRegions.find((r) => r.kind === 'segment');
assert.equal(covered.fileOffset, 0n);
assert.equal(covered.size, 4n);
assert.equal(suffix.vmAddr, 0x1004n);
assert.equal(suffix.size, 4n);
assert.equal(suffix.fileOffset, 4n);

assert.equal(covered.vmAddr + covered.size, suffix.vmAddr, 'suffix must start exactly where the section coverage ends');

const desc = describeBinaryImage(image);
assert.equal(desc.slices[0].regions.filter((r) => r.exec).length, 2);
assert.equal(desc.productDescriptor.regions.filter((r) => r.exec).length, 2);
