import assert from 'node:assert/strict';
import { parseDynamicSymbolVersions } from '../js/binary/elf-extended.js';

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;

class Reader {
  constructor() { this.length = 0x100; }
  u16() { return 2; }
  u32(offset) {
    if (offset === 0x2c) return 20; // DT_VERDEF vd_aux
    if (offset === 0x48) return 16; // DT_VERNEED vn_aux
    return 0;
  }
}

function parse(tags) {
  const image = {
    warnings: [],
    metadata: {},
    segments: [{ address: 0n, fileOffset: 0n, fileSize: 0x100n }],
  };
  const result = parseDynamicSymbolVersions(
    new Reader(),
    new Map([[DT_VERSYM, [0n]], ...tags]),
    image,
    1,
    (offset) => offset === 0n ? 'VERSION_1' : '',
  );
  return { image, result };
}

function diagnostics(image) { return image.metadata.programDynamicDiagnostics?.join('\n') || ''; }

// Both absent is a valid no-version-tables state.
{
  const { image } = parse([]);
  assert.equal(image.metadata.symbolVersions.complete, true);
  assert.equal(image.metadata.programDynamicPartial, undefined);
}

// Each address/count pair must be present together.
for (const [addressTag, countTag, label] of [
  [DT_VERDEF, DT_VERDEFNUM, 'DT_VERDEF/DT_VERDEFNUM'],
  [DT_VERNEED, DT_VERNEEDNUM, 'DT_VERNEED/DT_VERNEEDNUM'],
]) {
  for (const tags of [
    [[countTag, [1n]]],
    [[addressTag, [0x20n]]],
  ]) {
    const { image } = parse(tags);
    assert.equal(image.metadata.symbolVersions.complete, false);
    assert.match(diagnostics(image), new RegExp(label.replaceAll('/', '\\/')));
  }
}

// A present pair still decodes normally and remains complete.
{
  const { image, result } = parse([
    [DT_VERDEF, [0x20n]], [DT_VERDEFNUM, [1n]],
    [DT_VERNEED, [0x40n]], [DT_VERNEEDNUM, [1n]],
  ]);
  assert.equal(result.get(0)?.name, 'VERSION_1');
  assert.equal(image.metadata.symbolVersions.complete, true);
  assert.equal(image.metadata.programDynamicPartial, undefined);
}

// An invalid count is not silently folded into the zero-count case.
{
  const { image } = parse([[DT_VERDEF, [0x20n]], [DT_VERDEFNUM, [-1n]]]);
  assert.equal(image.metadata.symbolVersions.complete, false);
  assert.match(diagnostics(image), /DT_VERDEF\/DT_VERDEFNUM count/);
}

console.log('issue #6106 ELF symbol-version pair validation: PASS');
