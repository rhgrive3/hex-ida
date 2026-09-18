import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../../js/analysis/demand-driven-runtime.js';
import { executableByteCoverage } from '../../../js/analysis/discovery/executable-coverage.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { describeBinaryImage, regionsForImage } from '../../../js/platform/describe.js';

const BASE = 0x720000n;
const NOP = 0xd503201f;

function wordBytes(word, endian) {
  const bytes = new Uint8Array(4);
  if (endian === 'big') {
    bytes[0] = (word >>> 24) & 0xff;
    bytes[1] = (word >>> 16) & 0xff;
    bytes[2] = (word >>> 8) & 0xff;
    bytes[3] = word & 0xff;
  } else {
    bytes[0] = word & 0xff;
    bytes[1] = (word >>> 8) & 0xff;
    bytes[2] = (word >>> 16) & 0xff;
    bytes[3] = (word >>> 24) & 0xff;
  }
  return bytes;
}

async function directCoverage(bytes, endian) {
  return executableByteCoverage({
    regions:[{ id:'text', exec:true, vmAddr:BASE, size:BigInt(bytes.length), fileSize:BigInt(bytes.length) }],
    functions:new BigUint64Array(0),
    functionEnds:new BigUint64Array(0),
    architecture:'arm64',
    endian,
    readBytes:async (address, size) => bytes.slice(Number(address - BASE), Number(address - BASE + size)),
  });
}

function discoveryApp({ bytes, region, architecture = 'arm64', capability = null }) {
  return {
    backend:{
      gen:1,
      binaryId:'coverage-adversarial',
      guessFunctions:async () => ({ starts:[], complete:true, discoveryComplete:true }),
      readAt:async (address, length) => {
        const offset = Number(address - BASE);
        if (offset < 0 || offset + length > bytes.length) return { found:false, bytes:new Uint8Array(0) };
        return { found:true, bytes:bytes.slice(offset, offset + length) };
      },
    },
    analysisEpoch:1,
    projectRevision:0,
    store:{ get:(key) => key === 'architecture' ? architecture : key === 'capability' ? capability : key === 'sliceIndex' ? 0 : null },
    symbols:{
      gen:1,
      funcs:new BigUint64Array(0),
      funcEnds:new BigUint64Array(0),
      functionCount:0,
      functionStartsComplete:false,
      functionDiscovery:{ complete:false },
      addFunctions() { throw new Error('coverage accounting must not add function starts'); },
    },
    programRegions:() => [region],
    viewer:{ setSymbols() {} },
  };
}

test('A1 prime endian mutation: little and big NOPs require matching canonical byte order', async () => {
  const littleBytes = wordBytes(NOP, 'little');
  const bigBytes = wordBytes(NOP, 'big');

  assert.equal((await directCoverage(littleBytes, 'little')).unclassified[0].class, 'padding');
  assert.equal((await directCoverage(bigBytes, 'big')).unclassified[0].class, 'padding');
  assert.equal((await directCoverage(bigBytes, 'little')).unclassified[0].class, 'unknown');
  assert.equal((await directCoverage(littleBytes, 'big')).unclassified[0].class, 'unknown');
});

test('A1 prime demand runtime propagates BinaryImage-derived capability endianness', async () => {
  const bytes = wordBytes(NOP, 'big');
  const image = new BinaryImage(bytes, { format:'elf', arch:'aarch64_be', bits:64, endian:'big' });
  image.addSection({
    name:'.text', address:BASE, size:4n, fileOffset:0n, fileSize:4n,
    perms:{ read:true, write:false, execute:true }, flags:0x6n, source:'section-header',
  });
  image.finalize();
  const described = describeBinaryImage(image);
  const capability = described.slices[0].capability;
  assert.equal(capability.endianness, 'big', 'fixture must carry parser/image endianness into the canonical capability');

  const region = described.slices[0].regions[0];
  const app = discoveryApp({ bytes, region, architecture:capability.architecture, capability });
  installDemandDrivenAnalysis(app);
  await app.ensureFunctions(region);

  assert.deepEqual(app.symbols.functionDiscovery.coverage.unclassified, [
    { start:BASE, end:BASE + 4n, class:'padding' },
  ]);
  assert.equal(app.symbols.functionCount, 0);
});

test('A1 prime regionsForImage already clips executable accounting to file-backed bytes', async () => {
  const bytes = new Uint8Array(8);
  bytes.set(wordBytes(NOP, 'little'), 0);
  bytes.set(wordBytes(NOP, 'little'), 4);
  const image = new BinaryImage(bytes, { format:'elf', arch:'arm64', bits:64, endian:'little' });
  image.addSection({
    name:'.text', address:BASE, size:16n, fileOffset:0n, fileSize:8n,
    perms:{ read:true, write:false, execute:true }, flags:0x6n, source:'section-header',
  });
  image.finalize();
  const [region] = regionsForImage(image);
  assert.equal(region.size, 8n);
  assert.equal(region.declaredSize, 16n);

  const coverage = await executableByteCoverage({
    regions:[region], functions:new BigUint64Array(0), functionEnds:new BigUint64Array(0),
    architecture:'arm64', endian:'little',
    readBytes:(address, size) => image.readVirtualAsync(address, size),
  });
  assert.equal(coverage.executableBytes, 8);
  assert.deepEqual(coverage.unclassified, [{ start:BASE, end:BASE + 8n, class:'padding' }]);
});

test('A1 prime alternate programRegions provider cannot count a non-file-backed executable tail', async () => {
  const bytes = new Uint8Array(8);
  bytes.set(wordBytes(NOP, 'little'), 0);
  bytes.set(wordBytes(NOP, 'little'), 4);
  const region = { id:'exec', exec:true, vmAddr:BASE, size:16n, fileSize:8n, declaredSize:16n };
  const app = discoveryApp({ bytes, region, capability:{ endianness:'little' } });
  installDemandDrivenAnalysis(app);
  await app.ensureFunctions(region);

  assert.equal(app.symbols.functionDiscovery.coverage.executableBytes, 8);
  assert.deepEqual(app.symbols.functionDiscovery.coverage.unclassified, [
    { start:BASE, end:BASE + 8n, class:'padding' },
  ]);
  assert.equal(app.symbols.functionCount, 0);
});

test('A1 prime explicit zero-fill executable region contributes zero file-backed bytes', async () => {
  const bytes = new Uint8Array(8);
  bytes.set(wordBytes(NOP, 'little'), 0);
  bytes.set(wordBytes(NOP, 'little'), 4);
  const coverage = await executableByteCoverage({
    regions:[
      { id:'file', exec:true, vmAddr:BASE, size:8n, fileSize:8n },
      { id:'zero', exec:true, vmAddr:BASE + 8n, size:8n, fileSize:0n, zerofill:true },
    ],
    functions:new BigUint64Array(0),
    functionEnds:new BigUint64Array(0),
    architecture:'arm64',
    endian:'little',
    readBytes:async (address, size) => bytes.slice(Number(address - BASE), Number(address - BASE + size)),
  });
  assert.equal(coverage.executableBytes, 8);
  assert.deepEqual(coverage.unclassified, [{ start:BASE, end:BASE + 8n, class:'padding' }]);
});

test('stale coverage after epoch change never publishes over newer discovery', async () => {
  const bytes = new Uint8Array(16);
  bytes.set(wordBytes(NOP, 'little'), 0);
  bytes.set(wordBytes(NOP, 'little'), 4);
  bytes.set(wordBytes(NOP, 'little'), 8);
  bytes.set(wordBytes(NOP, 'little'), 12);
  const region = { id:'text', exec:true, vmAddr:BASE, size:16n };
  let releaseOldRead = null;
  let oldReadStarted = null;
  const oldReadGate = new Promise((resolve) => { oldReadStarted = resolve; });
  const app = {
    backend:{
      gen:1,
      binaryId:'coverage-epoch-race',
      guessFunctions:async () => ({ starts:[], complete:true, discoveryComplete:true }),
      readAt:(address, length) => {
        if (app.backend.gen === 1) {
          oldReadStarted();
          return new Promise((resolve) => {
            releaseOldRead = () => resolve({
              found:true,
              bytes:bytes.slice(Number(address - BASE), Number(address - BASE) + Number(length)),
            });
          });
        }
        const offset = Number(address - BASE);
        return Promise.resolve({ found:true, bytes:bytes.slice(offset, offset + Number(length)) });
      },
    },
    analysisEpoch:1,
    projectRevision:0,
    store:{ get:(key) => key === 'architecture' ? 'arm64' : key === 'sliceIndex' ? 0 : null },
    symbols:{
      gen:1,
      funcs:new BigUint64Array(0),
      funcEnds:new BigUint64Array(0),
      functionCount:0,
      functionStartsComplete:false,
      functionDiscovery:{ complete:false },
      addFunctions() { throw new Error('coverage accounting must not add function starts'); },
    },
    programRegions:() => [region],
    viewer:{ setSymbols() {} },
  };
  installDemandDrivenAnalysis(app);

  const oldFinished = app.ensureFunctions(region).then(
    () => ({ settled:'fulfilled' }),
    (error) => ({ settled:'rejected', error }),
  );
  await oldReadGate;
  // A newer demand epoch starts while the old coverage read is in flight.
  app.backend.gen = 2;
  await app.ensureFunctions(region);
  const newKey = app.symbols.functionDiscovery?.discoveryKey;
  assert.ok(newKey?.startsWith('2:'), `newer epoch must publish first (got ${newKey})`);

  releaseOldRead();
  const oldOutcome = await oldFinished;
  assert.equal(oldOutcome.settled, 'rejected', 'stale coverage producer must fail closed');
  assert.equal(app.symbols.functionDiscovery?.discoveryKey, newKey, 'stale coverage must not overwrite newer discovery');
});
