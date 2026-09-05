import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction, analyzeDataFlow } from '../js/blocks-base.js';

function insnsForCall(mn = 'bl', addr = 0x1004n) {
  return [
    makeInstruction({ row: 0, address: 0x1000n, mn: 'mov', ops: 'x30, #0x1111' }),
    makeInstruction({ row: 1, address: addr, mn, ops: '#0x2000' }),
    makeInstruction({ row: 2, address: 0x1008n, mn: 'mov', ops: 'x0, x30' }),
  ];
}

test('issue #6126 - pre-call X30 is not propagated after BL', () => {
  const insns = insnsForCall('bl', 0x1004n);
  const flow = analyzeDataFlow(insns, {});
  const copy = flow.flows.find((f) => f.row === 2 && f.to === 'x0');
  assert.ok(copy, 'expected reg->reg flow for mov x0,x30');
  const v = copy.value?.value ?? copy.value?.addr;
  assert.notEqual(v, 0x1111n, 'stale pre-call X30 value must not survive BL');
});

test('issue #6126 - BL exposes implicit X30 write', () => {
  const bl = makeInstruction({ row: 1, address: 0x1004n, mn: 'bl', ops: '#0x2000' });
  assert.ok(bl.writes.includes('x30'), 'call writes should include x30');
  assert.equal(bl.isCall, true);
});

test('issue #6126 - BL with known address tracks X30 as PC+4', () => {
  const insns = insnsForCall('bl', 0x1004n);
  const flow = analyzeDataFlow(insns, {});
  const x30 = flow.finalRegs.get('x0');
  // x0 is copy of post-call x30, should be PC+4 = 0x1008
  const val = x30?.value ?? x30?.addr;
  assert.equal(val, 0x1008n);
});

test('issue #6126 - BLR also invalidates pre-call X30', () => {
  const insns = [
    makeInstruction({ row: 0, address: 0x1000n, mn: 'mov', ops: 'x30, #0x1111' }),
    makeInstruction({ row: 1, address: 0x1004n, mn: 'blr', ops: 'x9' }),
    makeInstruction({ row: 2, address: 0x1008n, mn: 'mov', ops: 'x0, x30' }),
  ];
  assert.equal(insns[1].isCall, true);
  assert.ok(insns[1].writes.includes('x30'));
  const flow = analyzeDataFlow(insns, {});
  const copy = flow.flows.find((f) => f.row === 2 && f.to === 'x0');
  assert.ok(copy);
  assert.notEqual(copy.value?.value ?? copy.value?.addr, 0x1111n);
});

test('issue #6126 - BLRAA/BLRAB keep call classification and link write', () => {
  for (const mn of ['blraa', 'blrab']) {
    const insn = makeInstruction({ row: 0, address: 0x1000n, mn, ops: 'x9, x10' });
    assert.equal(insn.isCall, true, mn);
    assert.ok(insn.writes.includes('x30'), mn);
  }
});

test('issue #6126 - x0 call-result and caller-saved invalidation preserved', () => {
  const insns = [
    makeInstruction({ row: 0, address: 0x1000n, mn: 'mov', ops: 'x1, #0x5' }),
    makeInstruction({ row: 1, address: 0x1004n, mn: 'bl', ops: '#0x2000' }),
    makeInstruction({ row: 2, address: 0x1008n, mn: 'mov', ops: 'x2, x0' }),
  ];
  const flow = analyzeDataFlow(insns, {});
  const x0 = flow.finalRegs.get('x0');
  // after mov x2,x0, x0 still holds callResult, x2 holds copy
  assert.ok(flow.flows.some((f) => f.kind === 'call->reg' && f.to === 'x0'));
});

test('issue #6126 - ordinary non-call does not kill x30', () => {
  const insns = [
    makeInstruction({ row: 0, address: 0x1000n, mn: 'mov', ops: 'x30, #0x1111' }),
    makeInstruction({ row: 1, address: 0x1004n, mn: 'add', ops: 'x1, x2, #0x1' }),
    makeInstruction({ row: 2, address: 0x1008n, mn: 'mov', ops: 'x0, x30' }),
  ];
  const flow = analyzeDataFlow(insns, {});
  const copy = flow.flows.find((f) => f.row === 2 && f.to === 'x0');
  assert.equal(copy?.value?.value, 0x1111n);
});
