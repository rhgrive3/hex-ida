import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM = 0xbebafeca;
const FAT_CIGAM_64 = 0xbfbafeca;
const CPU_TYPE_ARM64 = 0x0100000c;

const machoSource = fs.readFileSync(new URL('../../js/macho.js', import.meta.url), 'utf8');
const machoContext = vm.createContext({});
vm.runInContext(machoSource, machoContext, { filename: 'js/macho.js' });
const { detect, parseFat } = machoContext.MachO;

const chainedSource = fs.readFileSync(new URL('../../js/chained.js', import.meta.url), 'utf8');
const exposedChained = `${chainedSource}\nexport { sliceOffset as __sliceOffsetForTest };`;
const chained = await import(`data:text/javascript;base64,${Buffer.from(exposedChained).toString('base64')}`);
const { chainedImportSymbols, __sliceOffsetForTest: sliceOffset } = chained;

function makeFat({ is64, swapped, offset = 0x100, size = 0x80, cputype = CPU_TYPE_ARM64, cpusubtype = 2 }) {
  const entrySize = is64 ? 32 : 20;
  const buffer = new ArrayBuffer(8 + entrySize);
  const dv = new DataView(buffer);
  const magic = is64
    ? (swapped ? FAT_CIGAM_64 : FAT_MAGIC_64)
    : (swapped ? FAT_CIGAM : FAT_MAGIC);
  dv.setUint32(0, magic, false);
  dv.setUint32(4, 1, swapped);
  dv.setInt32(8, cputype, swapped);
  dv.setInt32(12, cpusubtype, swapped);
  if (is64) {
    dv.setBigUint64(16, BigInt(offset), swapped);
    dv.setBigUint64(24, BigInt(size), swapped);
  } else {
    dv.setUint32(16, offset, swapped);
    dv.setUint32(20, size, swapped);
  }
  return buffer;
}

function fileFrom(header, totalSize = 0x200, reads = []) {
  const data = new Uint8Array(totalSize);
  data.set(new Uint8Array(header));
  return {
    size: data.length,
    slice(start, end) {
      reads.push([start, end]);
      const part = data.slice(start, end);
      return { arrayBuffer: async () => part.buffer };
    },
  };
}

for (const is64 of [false, true]) {
  for (const swapped of [false, true]) {
    const fat = makeFat({ is64, swapped });
    const detected = detect(fat);
    assert.equal(detected.kind, 'fat');
    assert.equal(detected.is64, is64);

    const parsed = parseFat(fat, 0x200n);
    assert.ok(parsed);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].offset, 0x100n);
    assert.equal(parsed[0].size, 0x80n);
    assert.equal(parsed[0].cputype, CPU_TYPE_ARM64);
    assert.equal(parsed[0].cpusubtype, 2);

    const slice = await sliceOffset(fileFrom(fat), 0);
    assert.ok(slice);
    assert.equal(slice.base, 0x100n);
    assert.equal(slice.size, 0x80n);
  }
}

const cigam32 = makeFat({ is64: false, swapped: true });
assert.equal(parseFat(cigam32.slice(0, 4), 0x200n), null);
assert.equal(await sliceOffset(fileFrom(cigam32.slice(0, 12)), 0), null);

const outOfBounds = makeFat({ is64: true, swapped: true, offset: 0x1c0, size: 0x80 });
assert.equal(parseFat(outOfBounds, 0x200n), null);
assert.equal(await sliceOffset(fileFrom(outOfBounds), 0), null);

const reads = [];
const chainedFile = fileFrom(makeFat({ is64: false, swapped: true }), 0x200, reads);
await chainedImportSymbols(chainedFile, 0);
assert.ok(reads.some(([start, end]) => start === 0x100 && end >= 0x120),
  'chainedImportSymbols must follow FAT_CIGAM slice offsets before parsing the Mach-O image');

console.log('issue-3607-macho-fat-cigam: PASS');