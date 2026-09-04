import assert from 'node:assert/strict';
import { parseDynamicSymbolVersions } from '../js/binary/elf-extended.js';

const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;

class Reader {
  constructor({ verdefVersion = 1, verneedVersion = 1 } = {}) {
    this.length = 0x100;
    this.verdefVersion = verdefVersion;
    this.verneedVersion = verneedVersion;
  }
  u16(offset) {
    if (offset === 0) return 2; // DT_VERSYM[0]
    if (offset === 0x20) return this.verdefVersion;
    if (offset === 0x40) return this.verneedVersion;
    if (offset === 0x24 || offset === 0x56) return 2; // version index 2
    return 1;
  }
  u32(offset) {
    if (offset === 0x2c) return 20; // DT_VERDEF vd_aux
    if (offset === 0x48) return 16; // DT_VERNEED vn_aux
    return 0;
  }
}

function parse(tags, versions = {}) {
  const image = {
    warnings: [],
    metadata: {},
    segments: [{ address: 0n, fileOffset: 0n, fileSize: 0x100n }],
  };
  const result = parseDynamicSymbolVersions(
    new Reader(versions),
    new Map([[DT_VERSYM, [0n]], ...tags]),
    image,
    1,
    (offset) => offset === 0n ? 'VERSION_1' : '',
  );
  return { image, result };
}

function pair(addressTag, countTag) {
  const address = addressTag === DT_VERNEED ? 0x40n : 0x20n;
  return [[addressTag, [address]], [countTag, [1n]]];
}
function diagnostics(image) { return image.metadata.programDynamicDiagnostics?.join('\n') || ''; }

// Current revision-one records remain valid and retain their version metadata.
{
  const { image, result } = parse(pair(DT_VERDEF, DT_VERDEFNUM));
  assert.equal(result.get(0)?.name, 'VERSION_1');
  assert.equal(image.metadata.symbolVersions.complete, true);
}
{
  const { image, result } = parse(pair(DT_VERNEED, DT_VERNEEDNUM), { verneedVersion:1 });
  assert.equal(result.get(0)?.name, 'VERSION_1');
  assert.equal(image.metadata.symbolVersions.complete, true);
}

for (const [addressTag, countTag, versionKey, label] of [
  [DT_VERDEF, DT_VERDEFNUM, 'verdefVersion', 'DT_VERDEF'],
  [DT_VERNEED, DT_VERNEEDNUM, 'verneedVersion', 'DT_VERNEED'],
]) {
  for (const version of [0, 2]) {
    const { image, result } = parse(pair(addressTag, countTag), { [versionKey]:version });
    assert.equal(result.get(0)?.name, null);
    assert.equal(image.metadata.symbolVersions.named, 0);
    assert.equal(image.metadata.symbolVersions.complete, false);
    assert.match(diagnostics(image), new RegExp(`${label} record version ${version}`));
  }
}

console.log('issue #6181 ELF symbol-version record revision validation: PASS');
