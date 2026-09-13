import assert from 'node:assert/strict';
import { OP } from '../js/ir.js';
import { symbolicExecute, SYM } from '../js/symbolic/executor.js';

function binResult(sub, { valueBits, dstBits = valueBits, left, right }) {
  const a = { id: 'a', bits: valueBits, ...(left === null ? { kind: 'arg', reg: 'x0' } : { const: left }) };
  const b = { id: 'b', bits: valueBits, ...(right === null ? { kind: 'arg', reg: 'x1' } : { const: right }) };
  const value = { id: 'out', bits: valueBits };
  const inst = { id: 'bin', row: 0, op: OP.BIN, sub, args: [{ value: a }, { value: b }], dst: { id: 'dst', bits: dstBits } };
  value.def = inst;
  const ret = { id: 'ret', row: 1, op: OP.RET, args: [{ value }] };
  const result = symbolicExecute(
    { entry: 0, blocks: [{ index: 0, phis: [], succ: [], insts: [inst, ret] }] },
    { timeoutMs: 1000 },
  );
  assert.equal(result.truncated, false);
  assert.equal(result.paths.length, 1);
  return result.paths[0];
}

function unResult({ sub, valueBits, srcBits, srcConst }) {
  const src = { id: 'src', bits: srcBits, const: srcConst };
  const value = { id: 'out', bits: valueBits };
  const inst = { id: 'un', row: 0, op: OP.UN, sub, args: [{ value: src, bits: srcBits }], dst: value };
  value.def = inst;
  const ret = { id: 'ret', row: 1, op: OP.RET, args: [{ value }] };
  const result = symbolicExecute(
    { entry: 0, blocks: [{ index: 0, phis: [], succ: [], insts: [inst, ret] }] },
    { timeoutMs: 1000 },
  );
  assert.equal(result.paths.length, 1);
  return result.paths[0];
}

function cmpResult(bits, { left, right }) {
  const a = { id: 'ca', bits, ...(left === null ? { kind: 'arg', reg: 'x0' } : { const: left }) };
  const b = { id: 'cb', bits, ...(right === null ? { kind: 'arg', reg: 'x1' } : { const: right }) };
  const flags = { id: 'nzcv-value', bits: 4, reg: 'nzcv' };
  const cmpInst = { id: 'cmp', op: OP.CMP, sub: 'sub', row: 0, address: 0x3000n, block: 0, args: [{ value: a, bits }, { value: b, bits }], dst: flags };
  flags.def = cmpInst;
  const branch = { id: 'branch', op: OP.CBR, cond: 'eq', row: 1, address: 0x3004n, block: 0, args: [{ value: flags, bits: 4 }], extra: { kind: 'cond', target: 0x4000n } };
  const taken = { id: 'taken-ret', op: OP.RET, row: 2, address: 0x4000n, block: 1, args: [] };
  const fallthrough = { id: 'fall-ret', op: OP.RET, row: 3, address: 0x5000n, block: 2, args: [] };
  const ir = {
    entry: 0,
    instructions: [cmpInst, branch, taken, fallthrough],
    values: [a, b, flags],
    blocks: [
      { index: 0, idom: -1, insts: [cmpInst, branch], succ: [1, 2] },
      { index: 1, idom: 0, insts: [taken], succ: [] },
      { index: 2, idom: 0, insts: [fallthrough], succ: [] },
    ],
    args: new Map(),
  };
  return symbolicExecute(ir, { timeoutMs: 1000 }).paths;
}

function assertUnsupportedWidthContract(path, bits, label) {
  assert.equal(path.status, 'unknown', label);
  assert.equal(path.reason, 'unsupported-width', label);
  assert.equal(path.returnValue.kind, SYM.UNKNOWN, label);
  assert.equal(path.returnValue.reason, 'unsupported-width', label);
  assert.equal(path.returnValue.detail.bits, bits, label);
}

function run() {
  // 1. Existing 64-bit (and narrower canonical) results are maintained.
  const add64 = binResult('add', { valueBits: 64, left: 0xffffffffffffffffn, right: 1n });
  assert.equal(add64.status, 'complete');
  assert.equal(add64.returnValue.value, 0n, '64-bit add still wraps at 64 bits');
  const sub64 = binResult('sub', { valueBits: 64, left: 0n, right: 1n });
  assert.equal(sub64.returnValue.value, 0xffffffffffffffffn);
  const shl64 = binResult('shl', { valueBits: 64, left: 1n, right: 63n });
  assert.equal(shl64.returnValue.value, 1n << 63n);
  const lshr24 = binResult('lshr', { valueBits: 24, left: 0x800000n, right: 8n });
  assert.equal(lshr24.returnValue.value, 0x8000n, '#4621 non-power-of-two shift is unchanged');
  const symbolicLshr32 = binResult('lshr', { valueBits: 32, left: null, right: null });
  assert.equal(symbolicLshr32.status, 'complete');
  assert.equal(symbolicLshr32.returnValue.bits, 32);

  // 2. canonical 128-bit add 0xffffffffffffffff + 1 must not collapse to 64-bit zero.
  const add128 = binResult('add', { valueBits: 128, left: 0xffffffffffffffffn, right: 1n });
  if (add128.status === 'complete' && add128.returnValue.kind === SYM.CONST) {
    assert.notEqual(add128.returnValue.value, 0n, '128-bit add must not publish a truncated 64-bit constant');
  }
  assertUnsupportedWidthContract(add128, 128, '128-bit constant add fails closed');

  // 5. constant and symbolic paths share one unsupported-width contract.
  const add128Symbolic = binResult('add', { valueBits: 128, left: null, right: null });
  assert.equal(add128Symbolic.status, 'unknown', '128-bit symbolic add must not mint a bits:64 expression');
  assert.equal(add128Symbolic.reason, add128.reason, 'constant and symbolic share the same reason');
  assert.equal(add128Symbolic.returnValue.detail.bits, add128.returnValue.detail.bits);

  // 4. 128-bit lshr/ashr must not lose the upper bits through a 64-bit clamp.
  const lshr128 = binResult('lshr', { valueBits: 128, left: 1n << 127n, right: 63n });
  assertUnsupportedWidthContract(lshr128, 128, '128-bit lshr fails closed');
  const ashr128 = binResult('ashr', { valueBits: 128, left: -1n, right: 1n });
  assertUnsupportedWidthContract(ashr128, 128, '128-bit ashr fails closed');
  const shl128Symbolic = binResult('shl', { valueBits: 128, left: null, right: null });
  assertUnsupportedWidthContract(shl128Symbolic, 128, '128-bit symbolic shl fails closed');

  // 3. 128-bit comparisons must fail closed instead of comparing at 64 bits.
  const cmpConst = cmpResult(128, { left: 1n << 64n, right: 0n });
  assert.ok(cmpConst.length > 0);
  for (const path of cmpConst) {
    assert.equal(path.status, 'unknown', '128-bit compare must not resolve a 64-bit condition');
    assert.equal(path.reason, 'unsupported-width');
  }
  const cmpSymbolic = cmpResult(128, { left: null, right: null });
  for (const path of cmpSymbolic) {
    assert.equal(path.status, 'unknown');
    assert.equal(path.reason, 'unsupported-width');
    assert.deepEqual(path.constraintText, []);
  }

  // OP.UN width is covered by the same contract.
  const sxt128 = unResult({ sub: 'sxt', valueBits: 128, srcBits: 64, srcConst: -1n });
  assertUnsupportedWidthContract(sxt128, 128, 'sxt into a 128-bit destination fails closed');
  const sxtFrom128 = unResult({ sub: 'sxt', valueBits: 64, srcBits: 128, srcConst: -1n });
  assertUnsupportedWidthContract(sxtFrom128, 128, 'sxt from a 128-bit source fails closed');
  const uxt8 = unResult({ sub: 'uxt8', valueBits: 64, srcBits: 64, srcConst: 0xffffffn });
  assert.equal(uxt8.status, 'complete');
  assert.equal(uxt8.returnValue.value, 0xffn, 'existing narrow extension is unchanged');

  // 6. malformed width keeps the fallback contract; a valid >64 width never falls back silently.
  for (const malformed of ['128', ['128'], {}, 0, -5, 64.5, Number.NaN]) {
    const got = binResult('add', { valueBits: 64, dstBits: malformed, left: 0xffffffffffffffffn, right: 1n });
    assert.equal(got.status, 'complete', 'malformed width keeps the fallback');
    assert.equal(got.returnValue.value, 0n, `malformed width ${String(malformed)} must not become unsupported`);
  }
  const fallbackOversize = binResult('add', { valueBits: 128, dstBits: '128', left: 0xffffffffffffffffn, right: 1n });
  assertUnsupportedWidthContract(fallbackOversize, 128, 'a valid >64 fallback width must not clamp to 64');

  console.log('issue-4618 symbolic executor >64-bit canonical width fail-closed: PASS');
}

run();
