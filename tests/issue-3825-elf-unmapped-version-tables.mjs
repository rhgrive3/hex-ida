import assert from 'node:assert/strict';
import { parseDynamicSymbolVersions } from '../js/binary/elf-extended.js';

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
const BASE = 0x1000n;
const UNMAPPED = 0xdead0000n;

function reader() {
  return { u16() { return 2; }, u32() { return 0; } };
}

function image() {
  return { segments: [{ address: BASE, fileOffset: 0, fileSize: 16 }], metadata: {}, warnings: [] };
}

function parse(tags, symbolCount = 1) {
  const imageValue = image();
  const out = parseDynamicSymbolVersions(reader(), tags, imageValue, symbolCount, () => null);
  return { out, image: imageValue };
}

{
  const { image: img } = parse(new Map([[DT_VERSYM, [BASE]], [DT_VERDEF, [UNMAPPED]], [DT_VERDEFNUM, [1n]]]));
  assert.equal(img.metadata.programDynamicPartial, true);
  assert.equal(img.metadata.symbolVersions.complete, false);
}
{
  const { image: img } = parse(new Map([[DT_VERSYM, [BASE]], [DT_VERNEED, [UNMAPPED]], [DT_VERNEEDNUM, [1n]]]));
  assert.equal(img.metadata.programDynamicPartial, true);
  assert.equal(img.metadata.symbolVersions.complete, false);
}
{
  const { image: img } = parse(new Map([[DT_VERSYM, [BASE]], [DT_VERDEF, [UNMAPPED]], [DT_VERDEFNUM, [0n]]]));
  assert.equal(img.metadata.symbolVersions.complete, true);
}
{
  const { out, image: img } = parse(new Map([[DT_VERSYM, [BASE]], [DT_VERDEF, [UNMAPPED]], [DT_VERDEFNUM, [1n]]]), 1);
  assert.equal(out.get(0)?.index, 2);
  assert.equal(out.get(0)?.name, null);
  assert.equal(img.metadata.symbolVersions.complete, false);
}

console.log('issue-3825-elf-unmapped-version-tables: PASS');
