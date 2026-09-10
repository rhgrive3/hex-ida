import assert from 'node:assert/strict';
import test from 'node:test';

import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';
import { SymbolIndex } from '../../js/symbols.js';

function makeApp(dataRegion, target = dataRegion.vmAddr + 0x20n) {
  const text = { id:'text', kind:'section', section:'.text', exec:true, read:true, write:false, vmAddr:0x1000n, size:0x100n, declaredSize:0x100n };
  const symbols = new SymbolIndex({ funcs:new BigUint64Array([0x1000n]), functionStartsComplete:true, regions:[text] });
  const app = {
    backend: {
      gen:0,
      scanProgram(regionId) {
        return Promise.resolve({
          regionId,
          vmAddr:text.vmAddr,
          callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0), callCount:0,
          refFrom:new BigUint64Array([0x1010n]), refTo:new BigUint64Array([target]), refKind:new Uint8Array([1]), refCount:1,
          kinds:new Uint8Array(0), kindsCovered:0, words:0,
          complete:true,
        });
      },
    },
    store:{ get(key) { if (key === 'regions') return [text, dataRegion]; return null; } },
    programRegions:() => [text],
    symbols,
  };
  installSharedAppArtifacts(app);
  return app;
}

async function statsFor(region) {
  const app = makeApp(region);
  return (await app.ensureProgram()).globalReferenceStats;
}

for (const [name, extra] of [
  ['ELF .data', { section:'.data', read:true, write:true }],
  ['ELF .bss', { section:'.bss', read:true, write:true, zerofill:true, size:0n, declaredSize:0x100n }],
  ['ELF .rodata', { section:'.rodata', read:true, write:false }],
  ['PE .rdata', { section:'.rdata', read:true, write:false }],
  ['Mach-O __data', { section:'__data', segment:'__DATA', read:true, write:true }],
]) {
  test(`#4311 counts a global reference into ${name}`, async () => {
    const region = {
      id:`data-${name}`, kind:'section', exec:false, vmAddr:0x4000n, size:0x100n, declaredSize:0x100n,
      zerofill:false,
      ...extra,
    };
    const stats = await statsFor(region);
    assert.equal(stats.scannedRefs, 1);
    assert.equal(stats.counts.get('16416')?.refs, 1);
    assert.equal(stats.complete, true);
  });
}

test('#4311 canonical writable metadata classifies custom data sections without name heuristics', async () => {
  const stats = await statsFor({
    id:'custom', kind:'section', section:'.vendor_globals', exec:false, read:true, write:true,
    vmAddr:0x5000n, size:0x80n, declaredSize:0x80n, zerofill:false,
  });
  assert.equal(stats.counts.get(String(0x5020n))?.refs, 1);
  assert.equal(stats.complete, true);
});

test('#4311 unknown non-executable range classification cannot publish complete negative evidence', async () => {
  const region = {
    id:'mystery', kind:'section', section:'.vendor_ro', exec:false,
    vmAddr:0x6000n, size:0x80n, declaredSize:0x80n,
    // deliberately lacks canonical read/write/zerofill classification
  };
  const app = makeApp(region, 0x7000n); // scanned ref is outside every recognized data range
  const stats = (await app.ensureProgram()).globalReferenceStats;
  assert.equal(stats.counts.size, 0);
  assert.equal(stats.scannedRefs, 1);
  assert.equal(stats.complete, false);
  assert.equal(stats.reason, 'global-data-range-classification-incomplete');
});

test('#4311 canonical permissions alone do not classify an unfamiliar read-only section as non-data', async () => {
  const app = makeApp({
    id:'custom-ro', kind:'section', section:'.vendor_constants', exec:false, read:true, write:false,
    vmAddr:0x6800n, size:0x80n, declaredSize:0x80n, zerofill:false,
  }, 0x7000n);
  const stats = (await app.ensureProgram()).globalReferenceStats;
  assert.equal(stats.counts.size, 0);
  assert.equal(stats.complete, false);
  assert.equal(stats.reason, 'global-data-range-classification-incomplete');
});

test('#4311 an unavailable region universe cannot publish complete global-reference stats', async () => {
  const text = { id:'text-only', exec:true, vmAddr:0x1000n, size:0x100n, section:'.text' };
  const symbols = new SymbolIndex({ funcs:new BigUint64Array([0x1000n]), functionStartsComplete:true, regions:[text] });
  const app = {
    backend:{
      gen:0,
      scanProgram:() => Promise.resolve({
        regionId:text.id, vmAddr:text.vmAddr,
        refFrom:new BigUint64Array([0x1010n]), refTo:new BigUint64Array([0x4000n]), refKind:new Uint8Array([1]), refCount:1,
        callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0), callCount:0,
        kinds:new Uint8Array(0), kindsCovered:0, words:0, complete:true,
      }),
    },
    store:{ get:() => null },
    programRegions:() => [text],
    symbols,
  };
  installSharedAppArtifacts(app);
  const stats = (await app.ensureProgram()).globalReferenceStats;
  assert.equal(stats.complete, false);
  assert.equal(stats.reason, 'global-data-range-classification-incomplete');
});

test('#4311 malformed executable/address metadata and lookalike section names fail closed', async () => {
  for (const region of [
    { id:'exec-shape', kind:'section', section:'.data', exec:1, read:true, write:true, vmAddr:0x7100n, size:0x80n, declaredSize:0x80n, zerofill:false },
    { id:'negative-va', kind:'section', section:'.data', exec:false, read:true, write:true, vmAddr:-0x80n, size:0x40n, declaredSize:0x40n, zerofill:false },
    { id:'lookalike', kind:'section', section:'.database', exec:false, read:true, write:false, vmAddr:0x7200n, size:0x80n, declaredSize:0x80n, zerofill:false },
  ]) {
    const app = makeApp(region, 0x7f00n);
    const stats = (await app.ensureProgram()).globalReferenceStats;
    assert.equal(stats.counts.size, 0, region.id);
    assert.equal(stats.complete, false, region.id);
    assert.equal(stats.reason, 'global-data-range-classification-incomplete', region.id);
  }
});

test('#4311 executable and zero-sized ranges stay excluded', async () => {
  const executable = await statsFor({
    id:'exec-data', kind:'section', section:'.data', exec:true, read:true, write:true,
    vmAddr:0x4000n, size:0x100n, declaredSize:0x100n, zerofill:false,
  });
  assert.equal(executable.counts.size, 0);
  const zero = await statsFor({
    id:'zero-data', kind:'section', section:'.data', exec:false, read:true, write:true,
    vmAddr:0x4000n, size:0n, declaredSize:0n, zerofill:false,
  });
  assert.equal(zero.counts.size, 0);
});
