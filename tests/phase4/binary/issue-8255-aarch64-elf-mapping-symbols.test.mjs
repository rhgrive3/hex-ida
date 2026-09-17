import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { parseELF } from '../../../js/binary/elf.js';
import { applyAarch64MappingSymbols } from '../../../js/binary/elf-aarch64-mapping.js';
import { describeBinaryImage } from '../../../js/platform/describe.js';

const ET_REL = 1;
const EM_AARCH64 = 183;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;

function stringTable(names) {
  const encoded = names.map((name) => Buffer.from(name, 'utf8'));
  const size = encoded.reduce((sum, value) => sum + value.length + 1, 1);
  const bytes = new Uint8Array(size);
  const offsets = [];
  let cursor = 1;
  for (const value of encoded) {
    offsets.push(cursor);
    bytes.set(value, cursor);
    cursor += value.length + 1;
  }
  return { bytes, offsets };
}

function buildAarch64MappingElf() {
  // b +8; data word that decodes as BL; mov w0,#0; ret
  const text = Uint8Array.from([
    0x02,0x00,0x00,0x14,
    0x00,0x00,0x00,0x94,
    0x00,0x00,0x80,0x52,
    0xc0,0x03,0x5f,0xd6,
  ]);
  const names = ['$x', '$d', '$x.1', 'foo'];
  const strtab = stringTable(names);
  const shstr = stringTable(['.text', '.symtab', '.strtab', '.shstrtab']);
  let cursor = 64;
  const textOff = cursor; cursor += text.length;
  const symOff = (cursor + 7) & ~7; cursor = symOff + 5 * 24;
  const strOff = cursor; cursor += strtab.bytes.length;
  const shstrOff = cursor; cursor += shstr.bytes.length;
  const shOff = (cursor + 7) & ~7;
  const sectionCount = 5;
  const bytes = new Uint8Array(shOff + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  bytes.set(text, textOff);
  bytes.set(strtab.bytes, strOff);
  bytes.set(shstr.bytes, shstrOff);

  const symbols = [
    { name:0, info:0x00, value:0n, size:0n },
    { name:1, info:0x00, value:4n, size:0n },
    { name:2, info:0x00, value:8n, size:0n },
    { name:3, info:0x12, value:0n, size:16n },
  ];
  for (let i = 0; i < symbols.length; i++) {
    const p = symOff + (i + 1) * 24;
    const s = symbols[i];
    view.setUint32(p, strtab.offsets[s.name], true);
    view.setUint8(p + 4, s.info);
    view.setUint8(p + 5, 0);
    view.setUint16(p + 6, 1, true);
    view.setBigUint64(p + 8, s.value, true);
    view.setBigUint64(p + 16, s.size, true);
  }

  bytes.set([0x7f,0x45,0x4c,0x46,2,1,1,0], 0);
  view.setUint16(16, ET_REL, true);
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 0n, true);
  view.setBigUint64(40, BigInt(shOff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 0, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 4, true);

  const sections = [
    { name:0, type:0, flags:0n, addr:0n, off:0, size:0, link:0, info:0, align:0n, entsize:0n },
    { name:0, type:SHT_PROGBITS, flags:SHF_ALLOC|SHF_EXECINSTR, addr:0n, off:textOff, size:text.length, link:0, info:0, align:4n, entsize:0n },
    { name:1, type:SHT_SYMTAB, flags:0n, addr:0n, off:symOff, size:5*24, link:3, info:4, align:8n, entsize:24n },
    { name:2, type:SHT_STRTAB, flags:0n, addr:0n, off:strOff, size:strtab.bytes.length, link:0, info:0, align:1n, entsize:0n },
    { name:3, type:SHT_STRTAB, flags:0n, addr:0n, off:shstrOff, size:shstr.bytes.length, link:0, info:0, align:1n, entsize:0n },
  ];
  for (let i = 0; i < sections.length; i++) {
    const p = shOff + i * 64;
    const s = sections[i];
    view.setUint32(p, i === 0 ? 0 : shstr.offsets[s.name], true);
    view.setUint32(p + 4, s.type, true);
    view.setBigUint64(p + 8, s.flags, true);
    view.setBigUint64(p + 16, s.addr, true);
    view.setBigUint64(p + 24, BigInt(s.off), true);
    view.setBigUint64(p + 32, BigInt(s.size), true);
    view.setUint32(p + 40, s.link, true);
    view.setUint32(p + 44, s.info, true);
    view.setBigUint64(p + 48, s.align, true);
    view.setBigUint64(p + 56, s.entsize, true);
  }
  return bytes;
}

test('#8255 AArch64 $x/$d mapping symbols publish section-scoped code/data authority', () => {
  const image = parseELF(buildAarch64MappingElf());
  assert.equal(image.arch, 'arm64');
  const foo = image.symbols.find((entry) => entry.name === 'foo');
  assert.ok(foo?.address != null);
  const mapping = image.metadata.aarch64MappingSymbols;
  assert.deepEqual(mapping.mappings.map((entry) => [entry.kind, entry.address - foo.address]), [
    ['instruction', 0n], ['data', 4n], ['instruction', 8n],
  ]);
  assert.equal(image.dataInCode.length, 1);
  assert.equal(image.dataInCode[0].address, foo.address + 4n);
  assert.equal(image.dataInCode[0].length, 4);
  assert.equal(image.isInstructionAllowed(foo.address), true);
  assert.equal(image.isInstructionAllowed(foo.address + 4n), false);
  assert.equal(image.isInstructionAllowed(foo.address + 8n), true);
});

test('#8255 mapping data removes guessed starts but preserves independently authoritative starts', () => {
  const image = parseELF(buildAarch64MappingElf());
  const foo = image.symbols.find((entry) => entry.name === 'foo');
  const dataAddress = foo.address + 4n;
  image.functions.push(
    { address:dataAddress, source:'heuristic', confidence:0.5, exactFunctionStart:false },
    { address:dataAddress, source:'symbol', confidence:0.995, exactFunctionStart:true },
  );
  applyAarch64MappingSymbols(image);
  const starts = image.functions.filter((seed) => seed.address === dataAddress);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].source, 'symbol');
  assert.equal(starts[0].exactFunctionStart, true);
});

test('#8255 platform regions carry mapping-data exclusions to the legacy ARM64 decoder', () => {
  const image = parseELF(buildAarch64MappingElf());
  const foo = image.symbols.find((entry) => entry.name === 'foo');
  const described = describeBinaryImage(image);
  const text = described.productDescriptor.regions.find((region) => region.exec && foo.address >= region.vmAddr && foo.address < region.vmAddr + region.size);
  assert.ok(text);
  assert.deepEqual(text.dataInCode.map((entry) => [entry.address - foo.address, entry.length, entry.kindName]), [
    [4n, 4, 'ELF_AARCH64_MAPPING_DATA'],
  ]);
  assert.equal(described.productDescriptor.formatMetadata.aarch64MappingSymbols.evidence, 'mapping-symbol');
});

function workerContext() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/address-provenance.js', 'js/worker-legacy.js', 'js/worker-fixes.js', 'js/worker-xref-target-identity-fix.js', 'js/worker-xref-memory-fix.js', 'js/worker-kind-fix.js', 'js/worker-function-provenance-fix.js', 'js/worker-loop-provenance-fix.js', 'js/worker-loop-unconditional-fix.js', 'js/worker-data-in-code-fix.js']) {
    vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename:file });
  }
  return context;
}

async function scanFakeCall({ dataInterval }) {
  const context = workerContext();
  context.__bytes = Uint8Array.from([
    0x02,0x00,0x00,0x14,
    0x00,0x00,0x00,0x94,
    0x00,0x00,0x80,0x52,
    0xc0,0x03,0x5f,0xd6,
  ]);
  vm.runInContext(`
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    const __region = {
      id:'code', kind:'section', name:'.text', section:'.text',
      fileOffset:0n, vmAddr:0x1000n, size:BigInt(__bytes.length),
      exec:true, zerofill:false,
      dataInCode:${dataInterval ? "[{ address:0x1004n, length:4, kind:1, kindName:'ELF_AARCH64_MAPPING_DATA' }]" : '[]'},
    };
    regions = new Map([['code', __region]]);
    slices = [{ regions:[__region], functionStarts:[0x1000n] }];
    currentEpoch = 0;
  `, context);
  return vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
}

test('#8255 raw program scan suppresses BL-shaped data while preserving the no-mapping fallback', async () => {
  const fallback = await scanFakeCall({ dataInterval:false });
  assert.equal(fallback.callCount, 1, 'without mapping authority, existing raw ARM64 fallback still sees the BL word');
  assert.equal(fallback.callFrom[0], 0x1004n);

  const mapped = await scanFakeCall({ dataInterval:true });
  assert.equal(mapped.callCount, 0, '$d interval must not publish a fake call edge');
  assert.equal(mapped.kinds[1], 0, '$d interval is classified as non-instruction/OTHER evidence');
});
