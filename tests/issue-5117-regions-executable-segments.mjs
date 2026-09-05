import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { describeBinaryImage, regionsForImage } from '../js/platform/describe.js';

function imageWith({ segments = [], sections = [] }) {
  const image = new BinaryImage(new Uint8Array(0x3000), { format: 'elf', arch: 'arm64', bits: 64 });
  for (const s of segments) image.addSegment(s);
  for (const s of sections) image.addSection(s);
  return image;
}
const execSeg = {
  name: 'LOAD-X', address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n,
  perms: { read: true, execute: true },
};
const dataSec = {
  name: '.data', address: 0x3000n, size: 0x100n, fileOffset: 0x2000n, fileSize: 0x100n,
  perms: { read: true, write: true },
};

// 1. sectionsなし -> 既存どおりsegmentsを使用
{
  const image = imageWith({ segments: [execSeg] });
  const regions = regionsForImage(image);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'segment');
  assert.equal(regions[0].exec, true);
}

// 2. sectionがsegmentを完全cover -> 不要な重複segment regionを増やさない
{
  const image = imageWith({
    segments: [execSeg],
    sections: [{
      name: '.text', address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n,
      perms: { read: true, execute: true },
    }],
  });
  const regions = regionsForImage(image);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'section');
}

// 3. data sectionだけ + uncovered executable segment -> executable regionを保持
{
  const image = imageWith({ segments: [execSeg], sections: [dataSec] });
  const desc = describeBinaryImage(image);
  const regions = desc.slices[0].regions;
  assert.ok(regions.some((r) => r.exec), 'executable mapping must survive');
  const exec = regions.find((r) => r.exec);
  assert.equal(exec.vmAddr, 0x1000n);
  assert.equal(exec.size, 0x1000n);
}

// 4. segmentの一部だけsection cover -> uncovered spanを保持
{
  const image = imageWith({
    segments: [execSeg],
    sections: [{
      name: '.part', address: 0x1000n, size: 0x400n, fileOffset: 0n, fileSize: 0x400n,
      perms: { read: true, execute: true },
    }],
  });
  const regions = regionsForImage(image);
  assert.ok(regions.some((r) => r.exec));
  // section(0x1000-0x1400) + complement(0x1400-0x2000): covered spanは重複しない
  const starts = regions.map((r) => r.vmAddr);
  assert.ok(starts.includes(0x1000n));
  assert.ok(starts.includes(0x1400n));
  const tail = regions.find((r) => r.vmAddr === 0x1400n);
  assert.equal(tail.size, 0xc00n);
}

// 5. textVMが実際の最初のexec regionを指す
{
  const image = imageWith({ segments: [execSeg], sections: [dataSec] });
  const desc = describeBinaryImage(image);
  assert.equal(desc.slices[0].info.textVM, 0x1000n);
}

// 6. zero-fill section/segmentの既存 semanticsを維持
{
  const image = imageWith({
    segments: [{ name: 'LOAD-BSS', address: 0x4000n, size: 0x200n, fileOffset: 0x2000n, fileSize: 0n, perms: { read: true, write: true } }],
    sections: [dataSec],
  });
  const regions = regionsForImage(image);
  assert.ok(regions.some((r) => r.section === '.data'));
}

console.log('issue #5117 regions keep uncovered executable segments: PASS');
