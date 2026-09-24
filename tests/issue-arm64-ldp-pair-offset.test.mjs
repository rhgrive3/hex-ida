import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OBJDUMP = ['llvm-objdump-18', 'llvm-objdump']
  .find((tool) => spawnSync(tool, ['--version']).status === 0) ?? 'llvm-objdump';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR } from '../js/ir-core.js';
import { buildIR as buildLegacyIR } from '../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';
import { createCxxEvidenceProvider } from '../js/analysis/cxx/project.js';
import { parseOperands } from '../js/arm64.js';
import { analyzeSemanticFunction } from '../js/analysis/semantic-function.js';

function createIrForRows(rows, mode = 'semantic-v2-compat') {
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
  if (mode === 'legacy') {
    return buildLegacyIR(model, { rowOfAddress });
  }
  return buildIR(model, { rowOfAddress, semanticMigrationMode: mode });
}

test('ARM64 ldp W/X registers derive second lane displacement as base + elementSize', () => {
  // ldp w8, w9, [x0, #8] -> loads at 8 and 12
  const rowsW = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'w8, w9, [x0, #8]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsW, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2, `mode ${mode} should produce 2 loads`);
    assert.equal(loads[0].loc?.disp, 8n);
    assert.equal(loads[1].loc?.disp, 12n);
    assert.equal(loads[0].addr?.disp, 8n);
    assert.equal(loads[1].addr?.disp, 12n);
    assert.equal(loads[0].loc?.size, 4);
    assert.equal(loads[1].loc?.size, 4);
  }

  // ldp x8, x9, [x0, #16] -> loads at 16 and 24
  const rowsX = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'x8, x9, [x0, #16]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsX, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2, `mode ${mode} should produce 2 loads`);
    assert.equal(loads[0].loc?.disp, 16n);
    assert.equal(loads[1].loc?.disp, 24n);
    assert.equal(loads[0].addr?.disp, 16n);
    assert.equal(loads[1].addr?.disp, 24n);
    assert.equal(loads[0].loc?.size, 8);
    assert.equal(loads[1].loc?.size, 8);
  }
});

test('ARM64 ldpsw derives second lane displacement as base + 4 with sign extension', () => {
  const rows = [
    { row: 0, address: 0x1000n, mn: 'ldpsw', ops: 'x8, x9, [x0, #8]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rows, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 8n);
    assert.equal(loads[1].loc?.disp, 12n);
    assert.equal(loads[0].addr?.disp, 8n);
    assert.equal(loads[1].addr?.disp, 12n);
    assert.equal(loads[0].loc?.size, 4);
    assert.equal(loads[1].loc?.size, 4);
    if (mode === 'semantic-v2-compat') {
      assert.equal(loads[0].extra?.signed, true);
      assert.equal(loads[1].extra?.signed, true);
    }
  }
});

test('ARM64 stp derives second lane displacement as base + elementSize', () => {
  const rows = [
    { row: 0, address: 0x1000n, mn: 'stp', ops: 'w8, w9, [x0, #8]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rows, mode);
    const stores = ir.instructions.filter((i) => i.op === 'store');
    assert.equal(stores.length, 2);
    assert.equal(stores[0].loc?.disp, 8n);
    assert.equal(stores[1].loc?.disp, 12n);
    assert.equal(stores[0].addr?.disp, 8n);
    assert.equal(stores[1].addr?.disp, 12n);
  }
});

test('ARM64 ldnp and stnp non-temporal pair derive second lane displacement as base + elementSize', () => {
  const rowsLdnp = [
    { row: 0, address: 0x1000n, mn: 'ldnp', ops: 'x0, x1, [x2, #16]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsLdnp, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 16n);
    assert.equal(loads[1].loc?.disp, 24n);
  }

  const rowsStnp = [
    { row: 0, address: 0x1000n, mn: 'stnp', ops: 'w0, w1, [x2, #8]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsStnp, mode);
    const stores = ir.instructions.filter((i) => i.op === 'store');
    assert.equal(stores.length, 2);
    assert.equal(stores[0].loc?.disp, 8n);
    assert.equal(stores[1].loc?.disp, 12n);
  }
});

test('ARM64 SIMD/FP vector pair (S/D/Q) derives second lane displacement', () => {
  // ldp s0, s1, [x0, #16] -> stride 4, loads at 16 and 20
  const rowsS = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 's0, s1, [x0, #16]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsS, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 16n);
    assert.equal(loads[1].loc?.disp, 20n);
  }

  // ldp d0, d1, [x0, #16] -> stride 8, loads at 16 and 24
  const rowsD = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'd0, d1, [x0, #16]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsD, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 16n);
    assert.equal(loads[1].loc?.disp, 24n);
  }

  // ldp q0, q1, [x0, #32] -> stride 16, loads at 32 and 48
  const rowsQ = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'q0, q1, [x0, #32]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsQ, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 32n);
    assert.equal(loads[1].loc?.disp, 48n);
  }
});

test('ARM64 pre-index and post-index writeback separate base writeback from lane offsets', () => {
  // Pre-index: ldp w8, w9, [sp, #16]! -> loads at sp+16 and sp+20, then sp += 16
  const rowsPre = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'w8, w9, [sp, #16]!' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsPre, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 16n);
    assert.equal(loads[1].loc?.disp, 20n);
    assert.equal(loads[0].addr?.disp, 16n);
    assert.equal(loads[1].addr?.disp, 20n);
  }

  // Post-index: ldp w8, w9, [sp], #16 -> loads at sp+0 and sp+4, then sp += 16
  const rowsPost = [
    { row: 0, address: 0x1000n, mn: 'ldp', ops: 'w8, w9, [sp], #16' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' }
  ];
  for (const mode of ['semantic-v2-compat', 'legacy']) {
    const ir = createIrForRows(rowsPost, mode);
    const loads = ir.instructions.filter((i) => i.op === 'load');
    assert.equal(loads.length, 2);
    assert.equal(loads[0].loc?.disp, 0n);
    assert.equal(loads[1].loc?.disp, 4n);
    assert.equal(loads[0].addr?.disp, 0n);
    assert.equal(loads[1].addr?.disp, 4n);
  }
});

test('End-to-end holdout.stripped.elf _ZNK5Thing6updateEi projects loads at offsets 8 and 12', async () => {
  const binary = fileURLToPath(new URL('./fixtures/cxx-dwarf-holdout/holdout.stripped.elf', import.meta.url));
  const symbol = '_ZNK5Thing6updateEi';
  const product = await openProduct(binary);
  assert.ok(!product.unsupported);
  const symbols = product.app.symbols;
  const index = symbols.names.findIndex((name) => name === symbol);
  assert.ok(index >= 0);
  const provider = createCxxEvidenceProvider({
    symbols,
    read: async (addr, len) => {
      const result = await product.app.backend.readAt(addr, len);
      return result?.found ? result.bytes : null;
    },
    pointerBytes: 8,
    architecture: 'arm64',
    snapshotId: 'matched-dwarf-holdout-test',
  });
  await provider.build();
  const disasm = spawnSync(OBJDUMP, ['--disassemble-symbols=' + symbol, '--no-show-raw-insn', binary], { encoding: 'utf8' });
  assert.equal(disasm.status, 0);
  const instructions = [];
  for (const line of disasm.stdout.split('\n')) {
    const match = /^\s*([0-9a-f]+):\s+([a-z][\w.]*)\s*(.*)$/.exec(line);
    if (!match) continue;
    instructions.push({
      address: BigInt(`0x${match[1]}`),
      size: 4,
      length: 4,
      mode: 'a64',
      mnemonic: match[2],
      opStr: match[3].trim(),
      ops: parseOperands(match[3].trim()),
      instructionId: `holdout-${instructions.length}`,
      origin: { instructionIds: [`holdout-${instructions.length}`] },
    });
  }
  const analyzed = analyzeSemanticFunction({
    architecture: 'arm64', platform: 'linux', abiId: 'aapcs64', mode: 'a64',
    decoderSemanticVersion: 'cxx-dwarf-holdout-v1', binaryId: product.sha,
    sliceId: 'matched-dwarf-holdout-test', name: symbol, rawSymbol: symbol,
    instructions, cxxEvidenceProvider: provider,
  });
  const projection = provider.lastAttempt()?.projection;
  assert.ok(projection);
  assert.equal(projection.receiver.classIdentity.className, 'Thing');

  const offsets = projection.members.map((m) => m.offsetBytes.toString());
  assert.deepEqual(offsets.sort((a, b) => Number(a) - Number(b)), ['8', '12']);

  // Pseudocode must render field_8 and field_C (12 in hex)
  assert.match(analyzed.decompiler.pseudocode, /field_8/);
  assert.match(analyzed.decompiler.pseudocode, /field_C/);

  await product.close();
});
