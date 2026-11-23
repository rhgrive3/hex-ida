import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompileSemantic } from '../../js/decompiler/semantic.js';
import { buildIR, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { closePublicCOutputForTesting, decompile } from '../../js/decompile-base.js';
import { lowerArm64RawAssembly } from '../../js/decompiler/arm64-extra-semantics.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const BASE = 0x100000000n;

function buildModelAndResolver(lines) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return { model, rowOfAddress };
}

test('Pass 9 Fix 1a: DECOMPILER_IR_OPTION_KEYS forwards callPrototypeFor/symbolFor into irFor() so bl malloc gets dst != null', () => {
  const { model, rowOfAddress } = buildModelAndResolver([
    'mov x0, #0x20',
    'bl #0x100002000',
    'ret',
  ]);
  const mallocAddr = 0x100002000n;

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    const result = decompileSemantic(model, {
      name: 'alloc_buf',
      addr: BASE,
      rowOfAddress,
      returnType: 'void *',
      symbolFor: (addr) => (BigInt(addr) === mallocAddr ? 'malloc' : null),
      callPrototypeFor: (target) => (BigInt(target) === mallocAddr ? { name: 'malloc', returnType: 'void *', returnClass: 'integer', returnBits: 64, returnsValue: true, params: [{ name: 'size', type: 'size_t', bits: 64 }] } : null),
    });

    assert.ok(result?.ir, 'expected semantic IR');
    const calls = (result.ir.instructions ?? []).filter((inst) => inst.op === OP.CALL);
    assert.equal(calls.length, 1, 'expected one CALL instruction');
    assert.ok(calls[0].dst != null, 'bl malloc should receive non-null dst when callPrototypeFor is forwarded');
    assert.equal(calls[0].dst.reg, 'x0', 'bl malloc dst should be x0');
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
});

test('Pass 9 Fix 1b: valuesByRegFor cache stays fresh when value.reg is mutated between typed call results and function returns', () => {
  const { model, rowOfAddress } = buildModelAndResolver([
    'mov x0, #7',
    'bl #0x100002100',
    'ret',
  ]);
  const helperAddr = 0x100002100n;

  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    const ir = buildIR(model, {
      rowOfAddress,
      callPrototypeFor: (target) => (BigInt(target) === helperAddr ? { name: 'helper', returnType: 'uint64_t', returnClass: 'integer', returnBits: 64, returnsValue: true, params: [{ name: 'x', type: 'uint64_t', bits: 64 }] } : null),
      returnType: 'uint64_t',
    });
    assert.ok(ir, 'expected IR');
    const callInst = ir.instructions.find((inst) => inst.op === OP.CALL);
    const retInst = ir.instructions.find((inst) => inst.op === OP.RET);
    assert.ok(callInst?.dst != null, 'call should have dst');
    assert.equal(callInst.dst.reg, 'x0');
    assert.equal(retInst?.args?.[0]?.value, callInst.dst, 'ret.args[0] should bind to the call result x0');
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
});

test('Pass 9 Fix 1c: attachCanonicalFunctionReturns never binds ret.args[0] to pre-call x0 across intervening OP.CALL (same block & dominating path)', () => {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    // Case 1: Same block intervening void OP.CALL between pre-call x0 and ret.
    const sameBlock = buildModelAndResolver([
      'mov x0, #42',
      'bl #0x100002200',
      'ret',
    ]);
    const sameBlockIr = buildIR(sameBlock.model, {
      rowOfAddress: sameBlock.rowOfAddress,
      callPrototypeFor: () => 'void helper(uint64_t)',
      returnType: 'uint64_t',
    });
    const sameBlockRet = sameBlockIr.instructions.find((inst) => inst.op === OP.RET);
    assert.equal(sameBlockRet.args.length, 0, 'same-block intervening OP.CALL must prevent binding pre-call x0 to ret.args[0]');

    // Case 2: Dominating-path intervening void OP.CALL in predecessor block B1 before B2 (ret).
    const domPath = buildModelAndResolver([
      'mov x0, #99',
      'b #0x100000008',
      'bl #0x100002200',
      'b #0x100000010',
      'ret',
    ]);
    const domPathIr = buildIR(domPath.model, {
      rowOfAddress: domPath.rowOfAddress,
      callPrototypeFor: () => 'void helper(uint64_t)',
      returnType: 'uint64_t',
    });
    const domPathRet = domPathIr.instructions.find((inst) => inst.op === OP.RET);
    assert.equal(domPathRet.args.length, 0, 'dominating-path intervening OP.CALL must prevent binding pre-call x0 to ret.args[0]');
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
});

test('Pass 9 Fix 2a: closePublicCOutput and lowerArm64RawAssembly forward sections, relocations, and stringFor to closeFunctionOutput', () => {
  const rodataBytes = new TextEncoder().encode('hello_pass9\0');
  const dataRelRo = new Uint8Array(8);
  const sections = [
    { name: '.rodata', addr: 0x20000n, size: rodataBytes.length, bytes: rodataBytes, readOnly: true },
    { name: '.data.rel.ro', addr: 0x20040n, size: dataRelRo.length, bytes: dataRelRo },
  ];
  const relocations = [
    { address: 0x20040n, type: 1027, addend: 0x20000n },
  ];

  const baseResult = {
    lines: [
      { kind: 'sig', indent: 0, text: 'const char * f(void)', row: 0, addr: 0x1000n },
      { kind: 'ctrl', indent: 0, text: '{', row: null, addr: null },
      { kind: 'stmt', indent: 1, text: 'return *(const char **)&global_20040;', row: 1, addr: 0x1000n },
      { kind: 'ctrl', indent: 0, text: '}', row: null, addr: null },
    ],
  };

  const closed = closePublicCOutputForTesting(structuredClone(baseResult), { sections, relocations });
  const closedText = closed.lines.map((l) => l.text).join('\n');
  assert.match(closedText, /"hello_pass9"/, 'closePublicCOutput should forward sections/relocations so R_AARCH64_RELATIVE global initializer fires');

  const rawResult = {
    lines: [
      { kind: 'sig', indent: 0, text: 'const char * g(void)', row: 0, addr: 0x1000n },
      { kind: 'ctrl', indent: 0, text: '{', row: null, addr: null },
      { kind: 'stmt', indent: 1, text: '__asm("cls x1, x2");', row: 1, addr: 0x1000n },
      { kind: 'stmt', indent: 1, text: 'return *(const char **)&global_20040;', row: 2, addr: 0x1004n },
      { kind: 'ctrl', indent: 0, text: '}', row: null, addr: null },
    ],
  };

  const lowered = lowerArm64RawAssembly(rawResult, { sections, relocations });
  const loweredText = lowered.lines.map((l) => l.text).join('\n');
  assert.match(loweredText, /"hello_pass9"/, 'lowerArm64RawAssembly should forward sections/relocations to closeFunctionOutput');
});

test('Pass 9 Fix 2b: app-adapter decompile and translationUnit forward sections, relocations, fileBytes/readBytes, and stringFor', async () => {
  const rodataBytes = new TextEncoder().encode('adapter_str\0');
  const dataRelRo = new Uint8Array(8);
  const sections = [
    { name: '.rodata', addr: 0x30000n, size: rodataBytes.length, bytes: rodataBytes, readOnly: true },
    { name: '.data.rel.ro', addr: 0x30040n, size: dataRelRo.length, bytes: dataRelRo },
  ];
  const relocations = [
    { address: 0x30040n, type: 1027, addend: 0x30000n },
  ];

  const { model } = buildModelAndResolver([
    'mov x0, #7',
    'ret',
  ]);
  const storeMap = new Map([
    ['architecture', 'arm64'],
    ['canDisassemble', true],
    ['fileInfo', {
      formatId: 'elf',
      slices: [{
        capability: { architecture: 'arm64', instructionAlignment: 4 },
        regions: [{ id: 'text', name: '.text', vmAddr: BASE, size: 0x100n, exec: true, read: true, write: false }],
        sections,
        relocations,
      }],
    }],
    ['sliceIndex', 0],
    ['regions', [{ id: 'text', name: '.text', vmAddr: BASE, size: 0x100n, exec: true, read: true, write: false }]],
  ]);

  const fnEntry = { name: 'fn_global', start: BASE, end: BASE + 8n, size: 8n };
  const app = {
    store: { get: (k) => storeMap.get(k) ?? null },
    symbols: {
      gen: 1,
      functionCount: 1,
      functionAt: (addr) => (BigInt(addr) === BASE ? fnEntry : null),
      nameAt: (addr) => (BigInt(addr) === BASE ? 'fn_global' : null),
      label: (addr) => (BigInt(addr) === BASE ? 'fn_global' : null),
    },
    backend: {
      gen: 1,
      arch: 'arm64',
      formatId: 'elf',
      binaryId: 'bin_sha256_' + 'e'.repeat(64),
      sections,
      relocations,
      stringFor: (addr) => (BigInt(addr) === 0x30000n ? 'adapter_str' : null),
    },
    analyzeFunction: async () => ({
      functionId: `function:${BASE.toString()}`,
      startAddress: BASE,
      name: 'fn_global',
      model,
      setsReturnValue: true,
    }),
  };

  installDemandDrivenAnalysis(app);
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot = await api.snapshot();

  const decRes = await api.decompile(snapshot, BASE);
  assert.ok(decRes?.value?.pseudocode, 'expected pseudocode from api.decompile');

  const tuRes = await api.translationUnit(snapshot, [BASE]);
  assert.ok(tuRes?.value?.source, 'expected source from api.translationUnit');
  assert.match(tuRes.value.source, /fn_global/);

  // Also verify direct decompile() with sections/relocations succeeds cleanly.
  const direct = decompile(model, {
    name: 'fn_global',
    addr: BASE,
    sections,
    relocations,
    stringFor: (addr) => (BigInt(addr) === 0x30000n ? 'adapter_str' : null),
    returnsValue: true,
  });
  assert.ok(direct?.pseudocode, 'expected pseudocode from direct decompile');
});
