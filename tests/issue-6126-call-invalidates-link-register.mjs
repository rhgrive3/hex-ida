import './issue-5227-effective-address-wrap.test.mjs';
import './issue-5235-scvtf-single-rounding.test.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction, analyzeDataFlow, buildSemanticModel } from '../js/blocks-base.js';

function callOperands(mnemonic) {
  if (mnemonic === 'bl') return '#0x1040';
  if (mnemonic === 'blr' || mnemonic === 'blraaz' || mnemonic === 'blrabz') return 'x9';
  return 'x9, x10';
}

function rows(lines) {
  return lines.map(([row, address, mn, ops]) => makeInstruction({ row, address, mn, ops }));
}

function callRows(mnemonic = 'bl') {
  return rows([
    [0, 0x1000n, 'mov', 'x30, #0x1111'],
    [1, 0x1004n, mnemonic, callOperands(mnemonic)],
    [2, 0x1008n, 'mov', 'x0, x30'],
  ]);
}

test('#6126: BL replaces stale X30 provenance with the known PC+4 link', () => {
  const df = analyzeDataFlow(callRows('bl'), {});
  const x0 = df.finalRegs.get('x0');
  assert.ok(x0 && x0.kind === 'imm', 'post-call X30 should remain precisely tracked');
  assert.equal(x0.value, 0x1008n);
  assert.notEqual(x0.value, 0x1111n, 'pre-call X30 immediate must not survive BL');
  assert.ok(df.flows.some((flow) => flow.kind === 'call-link' && flow.to === 'x30'));
});

test('#6126: BL exposes its implicit X30 write and BLR tracks its link', () => {
  const bl = makeInstruction({ row: 1, address: 0x1004n, mn: 'bl', ops: '#0x2000' });
  assert.equal(bl.isCall, true);
  assert.ok(bl.writes.includes('x30'));

  const df = analyzeDataFlow(callRows('blr'), {});
  const x0 = df.finalRegs.get('x0');
  assert.ok(x0 && x0.kind === 'imm');
  assert.equal(x0.value, 0x1008n);
});

test('#6126: malformed or missing call addresses invalidate X30 without inventing a link', () => {
  for (const address of [null, undefined, '', '  ', true, [], {}, Number.MAX_SAFE_INTEGER + 1, -1n]) {
    const instructions = rows([
      [0, 0x1000n, 'mov', 'x30, #0x1111'],
      [1, address, 'bl', '#0x2000'],
    ]);
    const df = analyzeDataFlow(instructions, {});
    assert.equal(df.finalRegs.has('x30'), false);
    assert.equal(df.flows.some((flow) => flow.kind === 'call-link'), false);
  }
  for (const address of [0n, 0, '0', '0x0']) {
    const df = analyzeDataFlow(rows([[0, address, 'bl', '#0x2000']]), {});
    assert.equal(df.finalRegs.get('x30')?.value, 4n);
  }
});

test('#6126: authenticated link forms classify as calls and write the link register', () => {
  for (const mnemonic of ['blraa', 'blrab', 'blraaz', 'blrabz']) {
    const insn = makeInstruction({ row: 0, address: 0x1000n, mn: mnemonic, ops: callOperands(mnemonic) });
    assert.equal(insn.isCall, true, mnemonic);
    assert.ok(insn.writes.includes('x30'), mnemonic);

    const df = analyzeDataFlow(callRows(mnemonic), {});
    const x0 = df.finalRegs.get('x0');
    assert.ok(x0 && x0.kind === 'imm', mnemonic);
    assert.equal(x0.value, 0x1008n, mnemonic);
  }
});

test('#6126: X30 reads before the call keep their provenance', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x4444'],
    [1, 0x1004n, 'mov', 'x19, x30'],
    [2, 0x1008n, 'bl', '#0x1040'],
  ]), {});
  const x19 = df.finalRegs.get('x19');
  assert.ok(x19 && x19.kind === 'imm' && x19.value === 0x4444n,
    'pre-call copy of X30 keeps its immediate value');
});

test('#6126: call result and caller-saved invalidation remain intact', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x1, #0x5'],
    [1, 0x1004n, 'bl', '#0x2000'],
    [2, 0x1008n, 'mov', 'x2, x0'],
    [3, 0x100cn, 'mov', 'x3, x1'],
  ]), {});
  assert.ok(df.flows.some((flow) => flow.kind === 'call->reg' && flow.to === 'x0'));
  assert.equal(df.finalRegs.get('x2')?.kind, 'callResult');
  assert.equal(df.finalRegs.get('x3')?.kind, 'unknown');
});

test('#6126: ordinary non-call branches do not invalidate X30', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x5555'],
    [1, 0x1004n, 'b', '#0x100c'],
    [2, 0x100cn, 'mov', 'x6, x30'],
  ]), {});
  assert.equal(df.finalRegs.get('x6')?.value, 0x5555n);
});

test('#6126: tail-call classification does not invent a link write for plain B', () => {
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'mov', ops: 'x30, #0x6666' },
    { row: 1, address: 0x1004n, mn: 'b', ops: '#0x2000' },
    { row: 2, address: 0x1008n, mn: 'mov', ops: 'x6, x30' },
  ], { rowOfAddress: () => null });
  const copy = model.flows.find((flow) => flow.kind === 'reg->reg' && flow.to === 'x6');
  assert.equal(copy?.value?.value, 0x6666n);
});
