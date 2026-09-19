import assert from 'node:assert/strict';
import test from 'node:test';
import { BinaryImage, functionSeed } from '../../../js/binary/model.js';
import { retainElfLoaderEntryExtents } from '../../../js/binary/elf-loader-entry-extent.js';
import { analysisFromBinaryImage } from '../../../js/platform/analysis-result.js';
import { SymbolIndex } from '../../../js/symbols.js';

const START = 0x1000n;
const NOP = 0xd503201f, RET = 0xd65f03c0;
const FRAME = [NOP, 0xa9bf7bfd, 0x910003fd, 0xa8c17bfd, RET];

function fixture(words = FRAME, { tag = 'DT_INIT', name = 'arbitrary_entry', sources = true } = {}) {
  const bytes = new Uint8Array(8192);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  const size = BigInt(words.length * 4);
  const image = new BinaryImage(bytes, { format:'elf', arch:'arm64', bits:64, endian:'little', metadata:{ type:3 } });
  image.addSegment({ address:START, size:8192n, fileOffset:0n, fileSize:8192n, source:'PT_LOAD', perms:{ read:true, execute:true } });
  image.addSection({ index:1, name:'.arbitrary', address:START, size, fileOffset:0n, fileSize:size,
    source:'section-header', flags:6n, perms:{ read:true, execute:true } });
  image.functions.push(functionSeed(START, { name, source:sources ? (tag === 'DT_INIT' ? 'dt-init' : 'dt-fini') : 'symbol',
    confidence:0.9, exactFunctionStart:true, loaderEntryContract:tag }));
  image.metadata[tag === 'DT_INIT' ? 'dtInit' : 'dtFini'] = { address:START, source:'PT_DYNAMIC' };
  return image;
}

test('loader extent: arbitrary names and both loader contracts reach the production symbol index', () => {
  for (const tag of ['DT_INIT', 'DT_FINI']) {
    const image = retainElfLoaderEntryExtents(fixture(FRAME, { tag }));
    assert.equal(image.functions[0].end, START + 20n);
    assert.equal(image.functions[0].extentSource, 'elf-loader-linear-return');
    const analysis = analysisFromBinaryImage(image);
    assert.equal(new SymbolIndex(analysis).functionAt(START).end, START + 20n);
  }
});

test('loader extent: variable-length straight-line body and call to a proven outside entry', () => {
  const image = fixture([0xd28000e0, NOP, 0x9400003e, RET]); // BL from 0x1008 to 0x1100
  image.functions.push(functionSeed(0x1100n, { source:'symbol', exactFunctionStart:true }));
  retainElfLoaderEntryExtents(image);
  assert.equal(image.functions[0].size, 16n);
});

test('loader extent: unsupported control flow, gaps, early returns and unproven calls stay unknown', () => {
  for (const words of [
    [NOP, NOP], [RET, NOP], [0, RET], [0xffffffff, RET], [0x14000001, RET],
    [0x54000020, RET], [0xd61f0000, RET], [0xd63f0000, RET], [0xd4000001, RET],
    [0xd4200000, RET], [0x94000040, RET], [0x94000001, RET], [NOP, 0xd65f0000],
  ]) {
    const image = retainElfLoaderEntryExtents(fixture(words));
    assert.equal(image.functions[0].end, null, words.map((w) => w.toString(16)).join(','));
  }
});

test('loader extent: section/name-only, wrong metadata, interior starts, data and conflicting mapping are not proof', () => {
  const mutations = [
    (im) => { im.functions[0].loaderEntryContracts = []; },
    (im) => { im.functions[0].source = 'symbol'; },
    (im) => { im.metadata.dtInit.address += 4n; },
    (im) => { im.functions.push(functionSeed(START + 4n)); },
    (im) => { im.addDataInCodeEntry({ offset:4, length:4, address:START + 4n, kind:1 }); },
    (im) => { im.sections[0].fileOffset = 4n; },
    (im) => { im.segments[0].fileSize = 4n; },
    (im) => { im.sections[0].size = 19n; },
    (im) => { im.sections[0].perms.execute = false; },
    (im) => { im.addSegment({ address:START, size:8192n, fileOffset:0n, fileSize:8192n,
      source:'PT_LOAD', perms:{ read:true, execute:false } }); },
    (im) => { im.addSegment({ address:START, size:8192n, fileOffset:0n, fileSize:8192n,
      source:'PT_LOAD', perms:{ read:true, execute:true } }); },
    (im) => { im.addSection({ ...im.sections[0], index:2 }); },
    (im) => { im.arch = 'x86_64'; },
    (im) => { im.endian = 'big'; },
  ];
  for (const mutate of mutations) {
    const image = fixture(); mutate(image); retainElfLoaderEntryExtents(image);
    assert.equal(image.functions[0].end, null, String(mutate));
  }
});

test('loader extent: bounded work and existing extent evidence are preserved', () => {
  const oversized = fixture([...Array(1024).fill(NOP), RET]);
  retainElfLoaderEntryExtents(oversized);
  assert.equal(oversized.functions[0].end, null);
  const known = fixture(); known.functions[0].end = START + 4n; known.functions[0].size = 4n;
  retainElfLoaderEntryExtents(known);
  assert.equal(known.functions[0].end, START + 4n);
});
