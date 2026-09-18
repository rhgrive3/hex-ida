import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';
import { SymbolIndex } from '../js/symbols.js';
import { App } from '../js/app.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';
import { elfLoaderEntrySectionAnalysisWindow } from '../js/binary/elf-mapping.js';

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u64 = (v) => [...u32(Number(BigInt(v) & 0xffffffffn)), ...u32(Number((BigInt(v) >> 32n) & 0xffffffffn))];
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_INIT = 12n;
const DT_FINI = 13n;
const DT_SYMTABSZ = 39n;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const EM_AARCH64 = 183;

const TEXT_OFF = 0x100;
const TEXT_VA = 0x1000n;
const DYNSTR_OFF = 0x300;
const DYNSTR_VA = 0x2100n;
const DYNSYM_OFF = 0x340;
const DYNSYM_VA = 0x2140n;
const DYN_OFF = 0x440;
const DYN_VA = 0x3000n;
const SHSTR_OFF = 0x600;
const SH_OFF = 0x680;

function buildElf64({
  loaderTag = DT_INIT,
  entry = TEXT_VA,
  symbolAddress = entry,
  functionName = '_runtime_entry',
  textFlags = 0x6n,
  textSize = 0x40n,
  textLoadFilesz = 0x40n,
  includeLoaderTag = true,
} = {}) {
  const enc = new TextEncoder();
  const dynstr = enc.encode(`\0${functionName}\0$x\0`);
  const functionNameOffset = 1;
  const mappingNameOffset = 1 + functionName.length + 1;
  const dynsym = new Uint8Array(72);
  const sv = new DataView(dynsym.buffer);
  // Zero-size STT_FUNC GLOBAL HIDDEN.
  sv.setUint32(24, functionNameOffset, true);
  sv.setUint8(28, (1 << 4) | 2);
  sv.setUint8(29, 2);
  sv.setUint16(30, 1, true);
  sv.setBigUint64(32, BigInt(symbolAddress), true);
  sv.setBigUint64(40, 0n, true);
  // Same-address AArch64 mapping symbol: local STT_NOTYPE, zero size.
  sv.setUint32(48, mappingNameOffset, true);
  sv.setUint8(52, 0);
  sv.setUint8(53, 0);
  sv.setUint16(54, 1, true);
  sv.setBigUint64(56, BigInt(symbolAddress), true);
  sv.setBigUint64(64, 0n, true);

  const dynamic = [
    ...(includeLoaderTag ? [[loaderTag, BigInt(entry)]] : []),
    [DT_STRTAB, DYNSTR_VA], [DT_STRSZ, BigInt(dynstr.length)],
    [DT_SYMTAB, DYNSYM_VA], [DT_SYMENT, 24n], [DT_SYMTABSZ, BigInt(dynsym.length)],
  ];
  const dynBytes = dynamic.flatMap(([tag, value]) => [...u64(tag), ...u64(value)]);
  dynBytes.push(...u64(DT_NULL), ...u64(0n));
  const shstr = enc.encode('\0.text\0.dynamic\0.dynstr\0.shstrtab\0');
  const fileEnd = Math.max(DYN_OFF + dynBytes.length, SH_OFF + 5 * 64, Number(TEXT_OFF + Number(textSize)));
  const bytes = new Uint8Array(fileEnd);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 64n, true);
  view.setBigUint64(40, BigInt(SH_OFF), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 4, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 5, true);
  view.setUint16(62, 4, true);

  const phdr = (i, type, flags, off, va, filesz, memsz) => {
    const p = 64 + i * 56;
    view.setUint32(p, type, true);
    view.setUint32(p + 4, flags, true);
    view.setBigUint64(p + 8, BigInt(off), true);
    view.setBigUint64(p + 16, BigInt(va), true);
    view.setBigUint64(p + 24, BigInt(va), true);
    view.setBigUint64(p + 32, BigInt(filesz), true);
    view.setBigUint64(p + 40, BigInt(memsz), true);
    view.setBigUint64(p + 48, 0x100n, true);
  };
  // Executable runtime mapping. Section-level negative cases below must not be
  // rescued into a section window merely because this segment is executable.
  phdr(0, PT_LOAD, 5, TEXT_OFF, TEXT_VA, textLoadFilesz, 0x100n);
  phdr(1, PT_LOAD, 4, DYNSTR_OFF, 0x2100n, 0x200n, 0x200n);
  phdr(2, PT_DYNAMIC, 4, DYN_OFF, DYN_VA, BigInt(dynBytes.length), BigInt(dynBytes.length));
  phdr(3, PT_LOAD, 4, DYN_OFF, DYN_VA, BigInt(dynBytes.length), BigInt(dynBytes.length));

  // AArch64 RET at the entry mapping; target validation only needs file-backed bytes.
  bytes.set([0xc0, 0x03, 0x5f, 0xd6], TEXT_OFF + Number(BigInt(entry) - TEXT_VA));
  bytes.set(dynstr, DYNSTR_OFF);
  bytes.set(dynsym, DYNSYM_OFF);
  bytes.set(dynBytes, DYN_OFF);
  bytes.set(shstr, SHSTR_OFF);

  const shdr = (i, { name = 0, type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, entsize = 0n } = {}) => {
    const p = SH_OFF + i * 64;
    view.setUint32(p, name, true);
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 8, flags, true);
    view.setBigUint64(p + 16, addr, true);
    view.setBigUint64(p + 24, offset, true);
    view.setBigUint64(p + 32, size, true);
    view.setUint32(p + 40, link, true);
    view.setBigUint64(p + 56, entsize, true);
  };
  shdr(0);
  shdr(1, { name:1, type:SHT_PROGBITS, flags:textFlags, addr:TEXT_VA, offset:BigInt(TEXT_OFF), size:textSize });
  shdr(2, { name:7, type:SHT_DYNAMIC, flags:0x3n, addr:DYN_VA, offset:BigInt(DYN_OFF), size:BigInt(dynBytes.length), link:3, entsize:16n });
  shdr(3, { name:16, type:SHT_STRTAB, flags:0x2n, addr:DYNSTR_VA, offset:BigInt(DYNSTR_OFF), size:BigInt(dynstr.length) });
  shdr(4, { name:24, type:SHT_STRTAB, offset:BigInt(SHSTR_OFF), size:BigInt(shstr.length) });
  return bytes;
}

function indexed(image) {
  const analysis = analysisFromBinaryImage(image);
  const symbols = new SymbolIndex(analysis);
  symbols.setFunctionRegions([{ id:'exec', vmAddr:TEXT_VA, size:0x100n, exec:true }], false);
  return { analysis, symbols };
}

function appRange(symbols, start = TEXT_VA) {
  const region = { id:'exec', vmAddr:TEXT_VA, size:0x100n, exec:true };
  return App.prototype.validatedFunctionRange.call({
    symbols,
    executableRegionFor(address) {
      const a = BigInt(address);
      return a >= region.vmAddr && a < region.vmAddr + region.size ? region : null;
    },
  }, start);
}

async function adapterRangeProbe(symbols, start = TEXT_VA) {
  const regions = [{ id:'exec', vmAddr:TEXT_VA, size:0x100n, exec:true }];
  let requestedLength = null;
  const values = new Map([
    ['regions', regions], ['architecture', 'arm64'], ['instructionAlignment', 4],
  ]);
  const app = {
    symbols,
    store:{ get(key) { return values.get(key) ?? null; } },
    backend:{
      formatId:'elf',
      async disassembleAt(address, { length }) {
        requestedLength = length;
        return { supported:true, found:true, readComplete:true, instructions:[{ address, length:4, mnemonic:'ret', opStr:'' }] };
      },
    },
  };
  const result = await createAppAnalysisQueryAdapter(app).instructions(null, { functionId:start });
  return { result, requestedLength };
}

for (const [tag, contract, functionName] of [
  [DT_INIT, 'DT_INIT', '_init'],
  [DT_FINI, 'DT_FINI', '_fini'],
]) {
  const image = parseELF(buildElf64({ loaderTag:tag, functionName }));
  const seed = image.functions.find((item) => item.address === TEXT_VA);
  assert.ok(seed, `${contract}: zero-size loader function must remain a function seed`);
  assert.equal(seed.end, null, `${contract}: loader window must not become exact end`);
  assert.equal(seed.size, null, `${contract}: loader window must not become exact size`);
  assert.ok(seed.sources.includes('symbol'), `${contract}: same-address FUNC evidence must survive merge`);
  assert.ok(seed.sources.includes(contract === 'DT_INIT' ? 'dt-init' : 'dt-fini'), `${contract}: loader evidence must survive merge`);
  assert.deepEqual(seed.loaderEntryContracts, [contract]);
  assert.equal(seed.analysisWindow?.end, TEXT_VA + 0x40n);

  const { analysis, symbols } = indexed(image);
  assert.equal(symbols.nameAt(TEXT_VA), functionName, `${contract}: STT_FUNC must outrank same-address mapping symbol`);
  assert.equal(analysis.funcEnds[0], 0n, `${contract}: platform result must not publish the section end as exact extent`);
  assert.equal(symbols.functionAt(TEXT_VA)?.end, null, `${contract}: functionAt exact extent must remain unknown`);
  assert.equal(symbols.functionList(null, 10)[0]?.size, null, `${contract}: function list size must remain unknown`);
  assert.equal(symbols.functionStartAt(TEXT_VA + 4n), null, `${contract}: section window must not become containment authority`);
  assert.equal(symbols.functionWindowBound(TEXT_VA), TEXT_VA + 0x40n, `${contract}: exact loader entry may use section end as analysis bound`);

  const range = appRange(symbols);
  assert.equal(range.ok, true);
  assert.equal(range.end, TEXT_VA + 0x40n);
  assert.equal(range.complete, false);
  assert.equal(range.reason, 'function-end-unproven');
  assert.equal(range.provenance, 'elf-loader-contract+section-analysis-window');
  assert.deepEqual(range.analysisWindow?.contracts, [contract]);

  const probe = await adapterRangeProbe(symbols);
  assert.equal(probe.requestedLength, 0x40, `${contract}: query adapter must decode only through the section analysis window`);
  assert.equal(probe.result.status.completeness, 'partial');
  assert.equal(probe.result.status.reason, 'function-end-unproven');
  assert.equal(probe.result.value[0]?.mnemonic, 'ret');
}

// The section end is only a ceiling: a nearer independently known function
// start must stop the loader-entry analysis window before it can cross into the
// next function.
const crossingSymbols = new SymbolIndex({
  funcs:new BigUint64Array([TEXT_VA, TEXT_VA + 0x10n]),
  funcEnds:new BigUint64Array([0n, 0n]),
  functionProvenance:[
    {
      source:'dt-init', confidence:0.9, confirmed:true,
      loaderEntryContracts:['DT_INIT'],
      analysisWindow:{
        kind:'elf-loader-entry-section',
        start:TEXT_VA,
        end:TEXT_VA + 0x40n,
        sectionIndex:1,
        provenance:'ELF loader entry at canonical executable file-backed section start',
      },
    },
    { source:'symbol', confidence:1, confirmed:true },
  ],
});
crossingSymbols.setFunctionRegions([{ id:'exec', vmAddr:TEXT_VA, size:0x100n, exec:true }], false);
assert.equal(crossingSymbols.functionAnalysisWindow(TEXT_VA)?.end, TEXT_VA + 0x10n,
  'loader analysis window must clamp to a nearer known function start');
assert.equal(crossingSymbols.functionWindowBound(TEXT_VA), TEXT_VA + 0x10n,
  'loader privilege must not widen the generic function window past the next function');
assert.equal(appRange(crossingSymbols).end, TEXT_VA + 0x10n,
  'App validated range must stop before the next function');
const crossingProbe = await adapterRangeProbe(crossingSymbols);
assert.equal(crossingProbe.requestedLength, 0x10,
  'query adapter must not decode across a nearer known function start');

const ordinary = indexed(parseELF(buildElf64({ includeLoaderTag:false, functionName:'ordinary' })));
assert.equal(ordinary.symbols.functionAt(TEXT_VA)?.end, null);
assert.equal(ordinary.symbols.functionWindowBound(TEXT_VA), null, 'ordinary executable section start must not receive loader fallback');
assert.equal(appRange(ordinary.symbols).ok, false);

const middle = indexed(parseELF(buildElf64({ entry:TEXT_VA + 4n, symbolAddress:TEXT_VA + 4n, functionName:'middle' })));
assert.equal(middle.symbols.functionWindowBound(TEXT_VA + 4n), null, 'loader entry in the middle of a section must not receive section fallback');
assert.equal(appRange(middle.symbols, TEXT_VA + 4n).ok, false);

for (const [label, options] of [
  ['non-executable section', { textFlags:0x2n }],
  ['non-file-backed section', { textSize:0x80n, textLoadFilesz:0x40n }],
  ['malformed zero-size section', { textSize:0n }],
]) {
  const { symbols } = indexed(parseELF(buildElf64({ ...options, functionName:label.replaceAll(' ', '_') })));
  assert.equal(symbols.functionWindowBound(TEXT_VA), null, `${label}: must fail closed without a loader analysis window`);
  assert.equal(appRange(symbols).ok, false, `${label}: unproven extent must remain unavailable`);
}



const loaderSection = {
  index:1,
  source:'section-header',
  address:TEXT_VA,
  size:0x40n,
  fileOffset:0x100n,
  fileSize:0x40n,
  flags:0x6n,
  perms:{ read:true, write:false, execute:true },
};
const loaderSegment = {
  source:'PT_LOAD',
  address:TEXT_VA,
  size:0x100n,
  fileOffset:0x100n,
  fileSize:0x100n,
  perms:{ read:true, write:false, execute:true },
};
assert.equal(elfLoaderEntrySectionAnalysisWindow({ arch:'x64', metadata:{ type:3 }, sections:[loaderSection], segments:[loaderSegment] }, TEXT_VA), null,
'non-ARM64 ELF loader entries must not receive the ARM64 analysis-window fallback');
assert.equal(elfLoaderEntrySectionAnalysisWindow({ metadata:{ type:3 }, sections:[
  { ...loaderSection, fileOffset:0x900n },
], segments:[loaderSegment] }, TEXT_VA), null,
'mismatched section/PT_LOAD file offsets must fail closed');
assert.equal(elfLoaderEntrySectionAnalysisWindow({ metadata:{ type:3 }, sections:[loaderSection], segments:[
  loaderSegment,
  { ...loaderSegment, fileOffset:0x200n },
] }, TEXT_VA), null,
'conflicting overlapping PT_LOAD file provenance must fail closed');

const selfDeclaredLoaderImage = {
  format:'elf',
  arch:'arm64',
  // Canonical executable/file-backed section evidence exists, but there is no
  // DT_INIT/DT_FINI metadata from either dynamic-table parser.
  metadata:{ type:3, functionDiscovery:{ complete:true } },
  sections:[loaderSection],
  segments:[loaderSegment],
  symbols:[], exports:[], imports:[],
  functions:[{
    address:TEXT_VA,
    source:'dt-init',
    sources:['dt-init'],
    confidence:0.9,
    exactFunctionStart:true,
    loaderEntryContracts:['DT_INIT'],
  }],
};
const selfDeclaredAnalysis = analysisFromBinaryImage(selfDeclaredLoaderImage);
assert.equal(selfDeclaredAnalysis.functionProvenance[0]?.loaderEntryContracts?.length ?? 0, 0,
  'self-declared dt-init source without parsed loader metadata must not retain loader privilege');
assert.equal(selfDeclaredAnalysis.functionProvenance[0]?.analysisWindow ?? null, null,
  'canonical section backing alone must not turn a forged dt-init label into a loader window');
const selfDeclaredSymbols = new SymbolIndex(selfDeclaredAnalysis);
selfDeclaredSymbols.setFunctionRegions([{ id:'exec', vmAddr:TEXT_VA, size:0x100n, exec:true }], false);
assert.equal(selfDeclaredSymbols.functionAnalysisWindow(TEXT_VA), null,
  'DT_INIT/DT_FINI privilege must require parsed dynamic-table metadata');

const forgedImage = {
  format:'elf',
  metadata:{ type:3, functionDiscovery:{ complete:true } },
  sections:[], segments:[], symbols:[], exports:[], imports:[],
  functions:[{
    address:TEXT_VA,
    source:'dt-init',
    sources:['dt-init'],
    confidence:0.9,
    exactFunctionStart:true,
    loaderEntryContracts:['DT_INIT'],
    analysisWindow:{
      kind:'elf-loader-entry-section',
      start:TEXT_VA,
      end:TEXT_VA + 0x100000000n,
      sectionIndex:0,
      provenance:'forged-window',
    },
  }],
};
const forgedAnalysis = analysisFromBinaryImage(forgedImage);
assert.equal(forgedAnalysis.functionProvenance[0]?.analysisWindow ?? null, null,
  'platform boundary must drop a forged loader window without canonical ELF section backing');
const forgedSymbols = new SymbolIndex(forgedAnalysis);
assert.equal(forgedSymbols.functionWindowBound(TEXT_VA), null,
  'forged loader window must not become an analysis bound');
const forgedProbe = await adapterRangeProbe(forgedSymbols);
assert.equal(forgedProbe.requestedLength, null,
  'adapter must not request decode bytes from a forged loader window');
assert.equal(forgedProbe.result.status?.reason, 'function-end-unproven');

console.log('issue #9203 ELF DT_INIT/DT_FINI loader analysis window: PASS');
