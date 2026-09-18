import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../../js/analysis/demand-driven-runtime.js';

import {
  attachExecutableCoverage,
  executableByteCoverage,
} from '../../../js/analysis/discovery/executable-coverage.js';

const BASE = 0x1000n;
const RET = 0xd65f03c0;
const NOP = 0xd503201f;

function putWord(bytes, offset, word) {
  bytes[offset] = word & 0xff;
  bytes[offset + 1] = (word >>> 8) & 0xff;
  bytes[offset + 2] = (word >>> 16) & 0xff;
  bytes[offset + 3] = (word >>> 24) & 0xff;
}

function fixture(bytes, { funcs = [], ends = [], size = bytes.length } = {}) {
  return executableByteCoverage({
    regions:[{ id:'text', exec:true, vmAddr:BASE, size:BigInt(size) }],
    functions:new BigUint64Array(funcs),
    functionEnds:new BigUint64Array(ends),
    architecture:'arm64',
    endian:'little',
    readBytes:async (address, length) => {
      const offset = Number(address - BASE);
      const count = Number(length);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > bytes.length) return null;
      return bytes.slice(offset, offset + count);
    },
  });
}

test('fully symbolized text keeps NOP padding out of unknown coverage', async () => {
  const bytes = new Uint8Array(32);
  for (let offset = 0; offset < 16; offset += 4) putWord(bytes, offset, RET);
  for (let offset = 16; offset < 32; offset += 4) putWord(bytes, offset, NOP);
  const coverage = await fixture(bytes, { funcs:[BASE], ends:[BASE + 16n] });

  assert.equal(coverage.executableBytes, 32);
  assert.equal(coverage.attributedBytes, 16);
  assert.deepEqual(coverage.unclassified, [
    { start:BASE + 16n, end:BASE + 32n, class:'padding' },
  ]);
  assert.equal(coverage.unclassified.some((range) => range.class === 'unknown'), false);
});

test('executable bytes outside exact function extents remain visible as unknown', async () => {
  const bytes = new Uint8Array(24);
  for (let offset = 0; offset < bytes.length; offset += 4) putWord(bytes, offset, RET);
  const coverage = await fixture(bytes, { funcs:[BASE], ends:[BASE + 12n] });

  assert.equal(coverage.executableBytes, 24);
  assert.equal(coverage.attributedBytes, 12);
  assert.deepEqual(coverage.unclassified, [
    { start:BASE + 12n, end:BASE + 24n, class:'unknown' },
  ]);
});

test('a no-function executable region reports all non-padding bytes as unknown without inventing a start', async () => {
  const bytes = new Uint8Array(16);
  for (let offset = 0; offset < bytes.length; offset += 4) putWord(bytes, offset, RET);
  const starts = new BigUint64Array(0);
  const coverage = await executableByteCoverage({
    regions:[{ id:'exec', exec:true, vmAddr:BASE, size:16n }],
    functions:starts,
    functionEnds:new BigUint64Array(0),
    architecture:'arm64',
    readBytes:async (address, length) => bytes.slice(Number(address - BASE), Number(address - BASE + length)),
  });

  assert.equal(starts.length, 0, 'coverage accounting must never add function starts');
  assert.equal(coverage.attributedBytes, 0);
  assert.deepEqual(coverage.unclassified, [
    { start:BASE, end:BASE + 16n, class:'unknown' },
  ]);
});

test('all-zero instruction words are positive padding evidence rather than unknown-by-absence', async () => {
  const bytes = new Uint8Array(16);
  const coverage = await fixture(bytes);
  assert.deepEqual(coverage.unclassified, [
    { start:BASE, end:BASE + 16n, class:'padding' },
  ]);
});

test('coverage is additive and does not change complete semantics', () => {
  const coverage = { executableBytes:16, attributedBytes:0, unclassified:[{ start:BASE, end:BASE + 16n, class:'unknown' }] };
  const complete = attachExecutableCoverage({ complete:true, capped:false, reasons:[] }, coverage);
  const incomplete = attachExecutableCoverage({ complete:false, capped:true, reasons:['result-budget'] }, coverage);

  assert.equal(complete.complete, true);
  assert.equal(complete.capped, false);
  assert.deepEqual(complete.reasons, []);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.capped, true);
  assert.deepEqual(incomplete.reasons, ['result-budget']);
  assert.equal(complete.coverage, coverage);
  assert.equal(incomplete.coverage, coverage);
});

test('BinaryImage exact extents feed coverage without changing loader completeness', async () => {
  const [{ BinaryImage, functionSeed }, { analysisFromBinaryImage }, { regionsForImage }] = await Promise.all([
    import('../../../js/binary/model.js'),
    import('../../../js/platform/analysis-result.js'),
    import('../../../js/platform/describe.js'),
  ]);
  const bytes = new Uint8Array(32);
  for (let offset = 0; offset < 16; offset += 4) putWord(bytes, offset, RET);
  for (let offset = 16; offset < 32; offset += 4) putWord(bytes, offset, NOP);
  const image = new BinaryImage(bytes, {
    format:'elf', arch:'arm64', bits:64, endian:'little',
    metadata:{ functionDiscovery:{ complete:true } },
  });
  image.addSection({
    name:'.text', address:BASE, size:32n, fileOffset:0n, fileSize:32n,
    perms:{ read:true, write:false, execute:true }, flags:0x6n, source:'section-header',
  });
  image.functions.push(functionSeed(BASE, {
    size:16n, name:'fully_symbolized', source:'symbol', confidence:0.995,
    exactFunctionStart:true, extentConfidence:0.995,
  }));
  image.finalize();

  const analysis = analysisFromBinaryImage(image);
  const coverage = await executableByteCoverage({
    regions:regionsForImage(image), functions:analysis.funcs, functionEnds:analysis.funcEnds,
    architecture:image.arch, endian:image.endian,
    readBytes:(address, size) => image.readVirtualAsync(address, size),
  });
  const discovery = attachExecutableCoverage(analysis.functionDiscovery, coverage);

  assert.equal(analysis.funcs.length, 1);
  assert.equal(analysis.funcs[0], BASE);
  assert.equal(analysis.funcEnds[0], BASE + 16n);
  assert.equal(discovery.complete, true, 'coverage must not reinterpret loader completeness');
  assert.deepEqual(discovery.coverage.unclassified, [
    { start:BASE + 16n, end:BASE + 32n, class:'padding' },
  ]);
});


test('demand discovery completion aggregation preserves additive coverage evidence', async () => {
  const region = { id:'text', exec:true, vmAddr:BASE, size:16n };
  const coverage = {
    executableBytes:16,
    attributedBytes:0,
    unclassified:[{ start:BASE, end:BASE + 16n, class:'unknown' }],
  };
  const app = {
    backend:{
      gen:1,
      binaryId:'coverage-fixture',
      guessFunctions:async () => ({ starts:[], complete:true, discoveryComplete:true }),
    },
    analysisEpoch:1,
    projectRevision:0,
    symbols:{
      gen:1,
      functionCount:0,
      functionStartsComplete:false,
      functionDiscovery:{ complete:false, capped:false, reasons:['platform-function-seeds-not-exhaustive'], coverage },
      addFunctions() { throw new Error('coverage fixture must not add starts'); },
    },
    programRegions:() => [region],
    viewer:{ setSymbols() {} },
  };
  installDemandDrivenAnalysis(app);

  await app.ensureFunctions(region);
  assert.equal(app.symbols.functionDiscovery.complete, true, 'producer completion keeps its existing meaning');
  assert.equal(app.symbols.functionDiscovery.coverage, coverage, 'coverage survives completion metadata aggregation');
  assert.equal(app.symbols.functionCount, 0, 'coverage evidence must not manufacture a function start');
});
