import assert from 'node:assert/strict';
import { collectRelrRelocations } from '../../js/binary/elf-extended.js';

const DT_RELRSZ = 35n;
const DT_RELR = 36n;
const DT_RELRENT = 37n;
const TABLE_BASE = 0x1000n;

function run(bits, entries) {
  const word = bits === 64 ? 8 : 4;
  const bytes = new Uint8Array(entries.length * word);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < entries.length; index++) {
    if (word === 8) view.setBigUint64(index * word, entries[index], true);
    else view.setUint32(index * word, Number(entries[index]), true);
  }
  const reader = {
    u64(offset) { return view.getBigUint64(offset, true); },
    u32(offset) { return view.getUint32(offset, true); },
  };
  const image = {
    segments: [{ address:TABLE_BASE, fileOffset:0n, fileSize:BigInt(bytes.length) }],
    metadata: {},
    warnings: [],
  };
  const tags = new Map([
    [DT_RELR, [TABLE_BASE]],
    [DT_RELRSZ, [BigInt(bytes.length)]],
    [DT_RELRENT, [BigInt(word)]],
  ]);
  return { image, out:collectRelrRelocations(reader, tags, image, bits) };
}

function assertOverflowPartial(result, bits) {
  assert.equal(result.image.metadata.programDynamicPartial, true);
  assert.ok(
    result.image.metadata.programDynamicDiagnostics?.some((message) =>
      message.includes('DT_RELR') && message.includes(`${bits}-bit address range`)),
    `expected a ${bits}-bit RELR address overflow diagnostic`,
  );
  const max = (1n << BigInt(bits)) - 1n;
  assert.ok(result.out.every((reloc) => reloc.address >= 0n && reloc.address <= max));
}

{
  const result = run(64, [0x2000n, 0x3n]);
  assert.deepEqual(result.out.map((reloc) => reloc.address), [0x2000n, 0x2008n]);
  assert.equal(result.image.metadata.programDynamicPartial, undefined);
}

{
  const result = run(64, [0xfffffffffffffff8n, 0x3n]);
  assert.deepEqual(result.out.map((reloc) => reloc.address), [0xfffffffffffffff8n]);
  assertOverflowPartial(result, 64);
}

{
  const result = run(32, [0xfffffffcn, 0x3n]);
  assert.deepEqual(result.out.map((reloc) => reloc.address), [0xfffffffcn]);
  assertOverflowPartial(result, 32);
}

{
  const result = run(64, [0xfffffffffffffff0n, 0x7n]);
  assert.deepEqual(
    result.out.map((reloc) => reloc.address),
    [0xfffffffffffffff0n, 0xfffffffffffffff8n],
    'valid bitmap relocations before the first overflowing bit may be retained',
  );
  assertOverflowPartial(result, 64);
}

{
  const result = run(64, [0xfffffffffffffe00n, 0x1n]);
  assert.deepEqual(result.out.map((reloc) => reloc.address), [0xfffffffffffffe00n]);
  assertOverflowPartial(result, 64);
}

console.log('issue #4007 ELF RELR address overflow regression PASS');
