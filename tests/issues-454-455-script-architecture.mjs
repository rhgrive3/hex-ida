import assert from 'node:assert/strict';
import { createApi, makeEmulator, UnsupportedArchitectureError } from '../js/script.js';
import { architectureAdapter } from '../js/architecture/index.js';
import './architecture-abi.mjs';

const BASE = 0x100000000n;
const region = { id:'text', vmAddr:BASE, size:0x1000n, fileOffset:0n, exec:true, name:'.text' };

function fakeApp(architecture, overrides = {}) {
  const patchItems = [];
  const values = new Map([
    ['architecture', architecture],
    ['fileInfo', { format: architecture === 'x86_64' ? 'pe' : 'macho' }],
    ['file', { name:'fixture.bin', size:0x1000 }],
    ['regions', [region]],
  ]);
  const backend = {
    async fetchChunk(_regionId, chunk) {
      assert.equal(chunk, 0);
      return { mn:['nop','ret'], ops:['',''], rows:2 };
    },
    async disassembleAt(addr, options) {
      assert.equal(options.architecture, architecture);
      if (architecture === 'x86_64') return {
        supported:true, architecture, found:true,
        instructions:[
          { address:BigInt(addr), size:1, mnemonic:'push', opStr:'rbp' },
          { address:BigInt(addr) + 1n, size:3, mnemonic:'mov', opStr:'rbp, rsp' },
          { address:BigInt(addr) + 4n, size:5, mnemonic:'call', opStr:'0x100000020' },
        ],
      };
      return { supported:false, architecture, instructions:[] };
    },
    async readAt(_addr, len) { return { found:true, bytes:new Uint8Array(len) }; },
  };
  return {
    store:{ get:(key) => values.get(key) },
    codeRegion:() => region,
    currentSlice:() => ({ info:{} }),
    backend:{ ...backend, ...(overrides.backend || {}) },
    patches:{ add:(offset,before,after,meta) => patchItems.push({ offset,before,after,meta }) },
    symbols:{ functionList:()=>[], nameAt:()=>null, label:()=>null, rename(){}, functionAt:()=>null },
    notes:{ setName(){}, setComment(){} },
    viewer:{ setSymbols(){} },
    ...overrides,
    _patchItems:patchItems,
  };
}

// Adapter owns the assembler and fixed-row mapping for ARM64.
{
  const arm64 = architectureAdapter('arm64');
  assert.equal(typeof arm64.assemble, 'function');
  assert.equal(arm64.rowForAddress(region, BASE + 8n), 2);
  assert.equal(arm64.addressForRow(region, 2), BASE + 8n);
  assert.equal(architectureAdapter('x86_64').rowForAddress(region, BASE + 1n), null);
}

// ARM64 legacy disassembly keeps its exact 4-byte instruction grid.
{
  const app = fakeApp('arm64');
  const { api } = createApi(app, () => {});
  const rows = await api.disasm(BASE, 2);
  assert.deepEqual(rows.map((x) => x.addr), [BASE, BASE + 4n]);
  assert.deepEqual(rows.map((x) => x.mn), ['nop','ret']);
  const built = api.assemble('nop', BASE);
  assert.equal(built.bytes?.length, 4);
}

// x86_64 must use decoder-provided variable-length instruction addresses.
{
  const app = fakeApp('x86_64');
  const { api } = createApi(app, () => {});
  const rows = await api.disasm(BASE, 3);
  assert.deepEqual(rows.map((x) => x.addr), [BASE, BASE + 1n, BASE + 4n]);
  assert.deepEqual(rows.map((x) => x.mn), ['push','mov','call']);

  const assembled = api.assemble('mov x0, #1', BASE);
  assert.equal(assembled.code, 'unsupported-architecture');
  assert.equal(assembled.unsupported, true);
  assert.equal(assembled.architecture, 'x86_64');

  const rejected = await api.patch(BASE, 'mov x0, #1');
  assert.equal(rejected.code, 'unsupported-architecture');
  assert.equal(app._patchItems.length, 0, 'foreign-ISA assembly must never register a patch');

  const raw = await api.patch(BASE + 1n, '90 90');
  assert.equal(raw.ok, true, 'explicit raw bytes remain ISA-neutral');
  assert.equal(raw.mode, 'raw');
  assert.equal(app._patchItems.length, 1);
  assert.equal(app._patchItems[0].after.length, 2);
  assert.equal(app._patchItems[0].meta.mode, 'raw');

  assert.throws(() => makeEmulator(app), (error) => {
    assert.ok(error instanceof UnsupportedArchitectureError);
    assert.equal(error.code, 'unsupported-architecture');
    assert.equal(error.architecture, 'x86_64');
    return true;
  });
}

// Unknown decoder support fails explicitly instead of falling back to a 4-byte grid.
{
  const app = fakeApp('unknown', { backend:{ async disassembleAt() { return { supported:false, architecture:'unknown', instructions:[] }; } } });
  const { api } = createApi(app, () => {});
  const result = await api.disasm(BASE, 1);
  assert.equal(result.code, 'unsupported-architecture');
  assert.equal(result.operation, 'disassemble');
}

// Issue #2558: hex.functions() multi-region scanning
{
  const region1 = { id:'text1', vmAddr:0x1000n, size:0x1000n, exec:true, name:'__TEXT' };
  const region2 = { id:'text2', vmAddr:0x2000n, size:0x1000n, exec:true, name:'__TEXT_EXEC' };
  const symbols = {
    functionList(r, _limit) {
      if (r === region1) return [{ addr:0x1000n, name:'f1', size:0x20 }];
      if (r === region2) return [{ addr:0x2000n, name:'f2', size:0x20 }];
      return [];
    }
  };
  const app = fakeApp('arm64', {
    store: { get: (k) => k === 'regions' ? [region1, region2] : null },
    symbols,
    codeRegion: () => region1,
  });
  const { api } = createApi(app, () => {});
  const funcs = api.functions();
  assert.equal(funcs.length, 2, 'hex.functions() must collect functions across all executable regions');
}

// Issue #2561: hex.decompile() capability guard on non-ARM64
{
  const app = fakeApp('x86_64');
  const { api } = createApi(app, () => {});
  const decomp = await api.decompile(0x1000n);
  assert.equal(decomp?.code, 'unsupported-architecture');
  assert.equal(decomp?.operation, 'decompile');
}

// Issue #2559: hex.xrefsTo / xrefsFrom use the canonical query API while the
// global most-called statistic reuses an already-complete shared ProgramIndex.
{
  const program = {
    gen:undefined,
    callSitesTo: (addr, limit) => [{ site:0x2000n, target:addr }].slice(0, limit),
    refSitesTo: () => [],
    functionRange: () => ({ start:0x1000n, end:0x1040n }),
    calleesOf: () => [{ addr:0x3000n }],
    mostCalled: () => [{ addr:0x3000n, count:5 }],
    graphCompleteness:{ complete:true, supported:true },
    callsCapped:false,
    refsCapped:false,
    statsComplete:true,
  };
  const analysisQueries = {
    async snapshot() { return { id:'fixture-snapshot' }; },
    async xrefs(_snapshot, addr, page) {
      return {
        value:[{ kind:'call', site:0x2000n, target:addr }],
        page:{ offset:Number(page?.offset || 0), limit:Number(page?.limit || 200), returned:1, total:1, next:null },
        status:{ completeness:'complete', scannedRegionIds:['text'], unscannedRegionIds:[] },
      };
    },
    async callees(_snapshot, _addr, page) {
      return {
        value:[{ addr:0x3000n }],
        page:{ offset:Number(page?.offset || 0), limit:Number(page?.limit || 200), returned:1, total:1, next:null },
        status:{ completeness:'complete', scannedRegionIds:['text'], unscannedRegionIds:[] },
      };
    },
  };
  const app = fakeApp('arm64', {
    ensureProgram: async () => program,
    program,
    programKey:'text',
    analysisQueries,
  });
  const { api } = createApi(app, () => {});
  const to = await api.xrefsTo(0x1000n);
  assert.equal(to.length, 1);
  assert.equal(to.completeness, 'complete');
  const from = await api.xrefsFrom(0x1000n);
  assert.equal(from.length, 1);
  assert.equal(from.completeness, 'complete');
  const most = await api.mostCalled(10);
  assert.equal(most.length, 1);
  assert.equal(most.completeness, 'complete');
}

console.log('issues #454/#455 script architecture regressions passed');
