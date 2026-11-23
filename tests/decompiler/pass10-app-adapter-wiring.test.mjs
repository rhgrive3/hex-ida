import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { setSemanticMigrationMode } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x1000n;

function buildModel(lines, base = BASE) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - base;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

/**
 * Build a minimal valid ELF64 binary containing:
 * - `.rodata` at fileOffset 0x200, vmAddr 0x20000n containing C strings
 * - `.data.rel.ro` at fileOffset 0x300, vmAddr 0x20100n (zeroed in file, populated via RELATIVE reloc)
 * - Either an SHT_RELA section table or a PT_DYNAMIC DT_RELA table (or both)
 */
function buildMinimalElf64({
  machine = 183, // EM_AARCH64 (62 = EM_X86_64)
  relocType = 1027, // R_AARCH64_RELATIVE (8 = R_X86_64_RELATIVE)
  rodataString = 'elf_rel_ro_hello\0',
  rodataVaddr = 0x20000n,
  rodataFileOff = 0x200,
  dataRelRoVaddr = 0x20100n,
  dataRelRoFileOff = 0x300,
  useSectionHeaders = true,
  useProgramHeaders = false,
} = {}) {
  const buf = new Uint8Array(0x800);
  const view = new DataView(buf.buffer);

  // ELF64 identification header
  buf[0] = 0x7f;
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT

  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, machine, true); // e_machine
  view.setUint32(20, 1, true); // e_version
  view.setUint16(52, 64, true); // e_ehsize

  // Write .rodata string at rodataFileOff
  const encoded = new TextEncoder().encode(rodataString);
  buf.set(encoded, rodataFileOff);

  // Write single Elf64_Rela entry at 0x400:
  //   r_offset = dataRelRoVaddr
  //   r_info   = BigInt(relocType)
  //   r_addend = rodataVaddr
  const relaFileOff = 0x400;
  view.setBigUint64(relaFileOff, dataRelRoVaddr, true);
  view.setBigUint64(relaFileOff + 8, BigInt(relocType), true);
  view.setBigUint64(relaFileOff + 16, rodataVaddr, true);

  if (useSectionHeaders) {
    // Section header table at 0x500: 2 entries (NULL + SHT_RELA)
    const shOff = 0x500;
    view.setBigUint64(40, BigInt(shOff), true); // e_shoff
    view.setUint16(58, 64, true); // e_shentsize
    view.setUint16(60, 2, true); // e_shnum

    const sh1 = shOff + 64;
    view.setUint32(sh1 + 4, 4, true); // sh_type = SHT_RELA
    view.setBigUint64(sh1 + 24, BigInt(relaFileOff), true); // sh_offset
    view.setBigUint64(sh1 + 32, 24n, true); // sh_size
    view.setBigUint64(sh1 + 56, 24n, true); // sh_entsize
  }

  if (useProgramHeaders) {
    // Program header table at 0x80: 2 entries (PT_LOAD covering 0..0x600 at vaddr 0x1fe00n, PT_DYNAMIC at 0x480)
    const phOff = 0x80;
    const dynFileOff = 0x480;
    const loadVaddr = 0x1fe00n;
    view.setBigUint64(32, BigInt(phOff), true); // e_phoff
    view.setUint16(54, 56, true); // e_phentsize
    view.setUint16(56, 2, true); // e_phnum

    // PT_LOAD (p_type = 1)
    view.setUint32(phOff, 1, true);
    view.setBigUint64(phOff + 8, 0n, true); // p_offset
    view.setBigUint64(phOff + 16, loadVaddr, true); // p_vaddr
    view.setBigUint64(phOff + 32, 0x600n, true); // p_filesz
    view.setBigUint64(phOff + 40, 0x600n, true); // p_memsz

    // PT_DYNAMIC (p_type = 2)
    const ph1 = phOff + 56;
    view.setUint32(ph1, 2, true);
    view.setBigUint64(ph1 + 8, BigInt(dynFileOff), true); // p_offset
    view.setBigUint64(ph1 + 16, loadVaddr + BigInt(dynFileOff), true); // p_vaddr
    view.setBigUint64(ph1 + 32, 64n, true); // p_filesz
    view.setBigUint64(ph1 + 40, 64n, true); // p_memsz

    // Dynamic entries at dynFileOff: DT_RELA (7), DT_RELASZ (8), DT_RELAENT (9), DT_NULL (0)
    view.setBigInt64(dynFileOff, 7n, true);
    view.setBigUint64(dynFileOff + 8, loadVaddr + BigInt(relaFileOff), true);
    view.setBigInt64(dynFileOff + 16, 8n, true);
    view.setBigUint64(dynFileOff + 24, 24n, true);
    view.setBigInt64(dynFileOff + 32, 9n, true);
    view.setBigUint64(dynFileOff + 40, 24n, true);
    view.setBigInt64(dynFileOff + 48, 0n, true);
    view.setBigUint64(dynFileOff + 56, 0n, true);
  }

  return buf;
}

function makeRuntimeApp({ elfBytes, regions, model, arch = 'arm64', includeStoreInfo = false }) {
  let arrayBufferCalls = 0;
  const fakeFile = {
    name: 'subject.elf',
    size: elfBytes.byteLength,
    async arrayBuffer() {
      arrayBufferCalls += 1;
      return elfBytes.buffer.slice(elfBytes.byteOffset, elfBytes.byteOffset + elfBytes.byteLength);
    },
  };

  const storeMap = new Map();
  if (includeStoreInfo) {
    storeMap.set('architecture', arch);
    storeMap.set('canDisassemble', true);
    storeMap.set('sliceIndex', 0);
  }

  const fnEntry = { name: 'get_relocated_str', start: BASE, end: BASE + BigInt(model.instructions.length * 4) };
  const app = {
    store: { get: (k) => storeMap.get(k) ?? null },
    symbols: {
      gen: 1,
      functionCount: 1,
      funcs: [BASE],
      functionStartsComplete: true,
      functionAt: (addr) => (BigInt(addr) === BASE ? fnEntry : null),
      nameAt: (addr) => (BigInt(addr) === BASE ? fnEntry.name : null),
      label: (addr) => (BigInt(addr) === BASE ? fnEntry.name : null),
    },
    backend: {
      gen: 1,
      binaryId: 'bin_sha256_' + 'a'.repeat(64),
      formatId: 'elf',
      file: fakeFile,
      platformInfo: {
        formatId: 'elf',
        capability: { architecture: arch, instructionAlignment: 4 },
        slices: [{
          capability: { architecture: arch, instructionAlignment: 4 },
          regions,
        }],
      },
    },
    async analyzeFunction() {
      return {
        model,
        startAddress: BASE,
        endAddress: fnEntry.end,
        setsReturnValue: true,
        completeness: { complete: true },
      };
    },
  };

  return { app, getArrayBufferCalls: () => arrayBufferCalls };
}

test('Pass 10 Track A: caches app.backend.file bytes once, forwards platformInfo.slices[0].regions as sections, and extracts ELF64 SHT_RELA R_AARCH64_RELATIVE', async () => {
  const elfBytes = buildMinimalElf64({
    machine: 183,
    relocType: 1027,
    rodataString: 'pass10_sht_rela_ok\0',
    useSectionHeaders: true,
    useProgramHeaders: false,
  });

  // ARM64 function that loads pointer from .data.rel.ro (0x20100) and returns it
  const model = buildModel([
    'adrp x8, #0x20000',
    'add x8, x8, #0x100',
    'ldr x0, [x8]',
    'ret',
  ]);

  const regions = [
    { id: 'p0_s0', name: '.text', vmAddr: BASE, fileOffset: 0n, size: 0x100n, read: true, write: false, exec: true, zerofill: false },
    { id: 'p0_s1', name: '.rodata', vmAddr: 0x20000n, fileOffset: 0x200n, size: 0x100n, read: true, write: false, exec: false, zerofill: false },
    { id: 'p0_s2', name: '.data.rel.ro', vmAddr: 0x20100n, fileOffset: 0x300n, size: 0x100n, read: true, write: true, exec: false, zerofill: false },
    { id: 'p0_s3', name: '.bss', vmAddr: 0x20200n, fileOffset: 0n, size: 0n, declaredSize: 0x100n, read: true, write: true, exec: false, zerofill: true },
  ];

  const { app, getArrayBufferCalls } = makeRuntimeApp({ elfBytes, regions, model, arch: 'arm64' });
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot = await api.snapshot();

  const res1 = await api.decompile(snapshot, BASE);
  assert.equal(res1.completeness, 'complete');
  const code1 = res1.value?.pseudocode ?? '';
  assert.match(code1, /"pass10_sht_rela_ok"/, `expected relocated .rodata string in decompile output, got:\n${code1}`);
  assert.equal(getArrayBufferCalls(), 1, 'app.backend.file.arrayBuffer() should be called once');

  // Second decompile and translationUnit must reuse the cached Uint8Array
  const res2 = await api.decompile(snapshot, BASE);
  assert.match(res2.value?.pseudocode ?? '', /"pass10_sht_rela_ok"/);
  const tu = await api.translationUnit(snapshot, [BASE]);
  assert.notEqual(tu.completeness, 'unsupported');
  assert.ok(tu.value?.source, 'translationUnit should produce packaged source using cached fileBytes');
  assert.equal(getArrayBufferCalls(), 1, 'cached fileBytes should prevent repeated arrayBuffer() reads');
});

test('Pass 10 Track A: extracts ELF64 PT_DYNAMIC DT_RELA R_AARCH64_RELATIVE when section headers are stripped', async () => {
  const elfBytes = buildMinimalElf64({
    machine: 183,
    relocType: 1027,
    rodataString: 'pass10_pt_dynamic_ok\0',
    useSectionHeaders: false,
    useProgramHeaders: true,
  });

  const model = buildModel([
    'adrp x8, #0x20000',
    'add x8, x8, #0x100',
    'ldr x0, [x8]',
    'ret',
  ]);

  const regions = [
    { id: 'p0_s0', name: '.text', vmAddr: BASE, fileOffset: 0n, size: 0x100n, read: true, write: false, exec: true, zerofill: false },
    { id: 'p0_s1', name: '.rodata', vmAddr: 0x20000n, fileOffset: 0x200n, size: 0x100n, read: true, write: false, exec: false, zerofill: false },
    { id: 'p0_s2', name: '.data.rel.ro', vmAddr: 0x20100n, fileOffset: 0x300n, size: 0x100n, read: true, write: true, exec: false, zerofill: false },
  ];

  const { app } = makeRuntimeApp({ elfBytes, regions, model, arch: 'arm64' });
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot = await api.snapshot();

  const res = await api.decompile(snapshot, BASE);
  const code = res.value?.pseudocode ?? '';
  assert.match(code, /"pass10_pt_dynamic_ok"/, `expected PT_DYNAMIC DT_RELA relocated string, got:\n${code}`);
});

test('Pass 10 Track A: extracts ELF64 R_X86_64_RELATIVE (type 8) and fails closed on truncated/corrupt ELF bytes', async () => {
  const x64Elf = buildMinimalElf64({
    machine: 62, // EM_X86_64
    relocType: 8, // R_X86_64_RELATIVE
    rodataString: 'pass10_x64_rel_ok\0',
    useSectionHeaders: true,
    useProgramHeaders: false,
  });

  const model = buildModel([
    'adrp x8, #0x20000',
    'add x8, x8, #0x100',
    'ldr x0, [x8]',
    'ret',
  ]);

  const regions = [
    { id: 'p0_s0', name: '.text', vmAddr: BASE, fileOffset: 0n, size: 0x100n, read: true, write: false, exec: true, zerofill: false },
    { id: 'p0_s1', name: '.rodata', vmAddr: 0x20000n, fileOffset: 0x200n, size: 0x100n, read: true, write: false, exec: false, zerofill: false },
    { id: 'p0_s2', name: '.data.rel.ro', vmAddr: 0x20100n, fileOffset: 0x300n, size: 0x100n, read: true, write: true, exec: false, zerofill: false },
  ];

  const { app } = makeRuntimeApp({ elfBytes: x64Elf, regions, model, arch: 'arm64' });
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot = await api.snapshot();
  const res = await api.decompile(snapshot, BASE);
  assert.match(res.value?.pseudocode ?? '', /"pass10_x64_rel_ok"/, 'R_X86_64_RELATIVE should be parsed and forwarded');

  // Corrupt/truncated ELF bytes must fail closed without throwing
  const corruptElf = new Uint8Array(72);
  corruptElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  const corruptView = new DataView(corruptElf.buffer);
  corruptView.setUint16(18, 183, true);
  corruptView.setBigUint64(40, 0xdeadbeefn, true); // out-of-bounds e_shoff
  corruptView.setUint16(58, 64, true);
  corruptView.setUint16(60, 100, true);
  const { app: corruptApp } = makeRuntimeApp({ elfBytes: corruptElf, regions, model, arch: 'arm64' });
  const corruptApi = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(corruptApp));
  const corruptSnap = await corruptApi.snapshot();
  const corruptRes = await corruptApi.decompile(corruptSnap, BASE);
  assert.equal(corruptRes.completeness, 'complete', 'corrupt ELF header should fail closed cleanly');
});

test('Pass 10 Track A: forwards architectureId into irFor() and decompile() in semantic-v2-compat mode', async () => {
  // Simple ARM64 floating-point function: fadd d0, d0, d1; ret.
  // In semantic-v2-compat mode, isAArch64Context(ir, opts) requires architectureId / abiAdapter
  // to recognize ARM64 FP registers (d0/d1/v0/v1) rather than returning false.
  const model = buildModel([
    'fadd d0, d0, d1',
    'ret',
  ]);
  const regions = [
    { id: 'p0_s0', name: '.text', vmAddr: BASE, fileOffset: 0n, size: 0x100n, read: true, write: false, exec: true, zerofill: false },
  ];

  // Store intentionally omits `architecture` so architectureId must be resolved from platformInfo.slices[0].capability.architecture
  const { app } = makeRuntimeApp({
    elfBytes: new Uint8Array(16),
    regions,
    model,
    arch: 'aarch64',
    includeStoreInfo: false,
  });

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
    const snapshot = await api.snapshot();
    const res = await api.decompile(snapshot, BASE);
    assert.equal(res.completeness, 'complete');
    const code = res.value?.pseudocode ?? '';
    assert.ok(code.includes('return'), `expected valid decompiled return in v2-compat mode, got:\n${code}`);
    assert.ok(!code.includes('__asm('), `expected semantic FP lowering rather than raw __asm fallback, got:\n${code}`);

    const tu = await api.translationUnit(snapshot, [BASE]);
    assert.notEqual(tu.completeness, 'unsupported');
    assert.ok(!tu.value?.source?.includes('__asm('), 'translationUnit should also forward architectureId');
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
});

import { resolveModelTexts } from '../../js/analyze.js';

test('Pass 10 follow-up: adrp + 0-offset ldr [x1] records addressRef with load=true', () => {
  const model = buildModel([
    'adrp x1, #0x1000',
    'ldr d5, [x1]',
    'ret',
  ]);
  const loadRef = (model.addressRefs || []).find((r) => r.load && BigInt(r.addr) === 0x1000n);
  assert.ok(loadRef, `expected 0-offset adrp+ldr addressRef at 0x1000, got: ${JSON.stringify(model.addressRefs, (_, v) => typeof v === 'bigint' ? v.toString(16) : v)}`);
});

test('Pass 10 follow-up: resolveModelTexts does not deref small integer constants (< 0x40) into ELF header', async () => {
  const model = {
    architecture: 'arm64',
    pointerWidth: 8,
    addressRefs: [{ row: 0, addr: 0x1110n, load: true }],
    calls: [],
    semantic: [],
    facts: { stringRefs: [] },
  };
  const fakeBackend = {
    async readAt(addr) {
      if (BigInt(addr) === 0x1110n) {
        return { found: true, bytes: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), text: '', section: '.rodata' };
      }
      if (BigInt(addr) === 0x1n) {
        return { found: true, bytes: Uint8Array.from([0x45, 0x4c, 0x46, 0x00]), text: 'ELF', section: '' };
      }
      return { found: false };
    },
  };
  await resolveModelTexts(fakeBackend, model);
  assert.equal(model.addressRefs[0].text, undefined, 'small integer 1 must not be misidentified as pointer to ELF header string');
  assert.notEqual(model.addressRefs[0].viaPointer, true);
});
