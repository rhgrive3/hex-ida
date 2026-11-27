import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { OP } from '../../js/ir.js';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  inferSemanticTypes,
  semanticSignature,
} from '../../js/decompiler/type-recovery.js';
import { knownCallSignature } from '../../js/decompiler/call-prototypes.js';
import { renderNZCVCondition } from '../../js/decompiler/flag-semantics.js';

const loader = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/js/ir-core.js?seal-test')) return result;
    const source = String(result.source);
    const marker1 = 'const callBindingObserver = attachCanonicalCallArguments(';
    const marker2 = 'sealFacadeAbiBindings(result.legacyV1, callBindingObserver, returnBindingObserver, typedResultObserver, stateHistory);';
    assert.equal(source.split(marker1).length, 2);
    assert.equal(source.split(marker2).length, 2);
    const patched = source
      .replace(marker1, 'opts.__abiFixture?.(result.legacyV1);\n  ' + marker1)
      .replace(marker2, 'opts.__beforeSeal?.(callBindingObserver, returnBindingObserver);\n  ' + marker2);
    return { ...result, source: patched };
  },
});
const {
  buildIR,
  facadeAbiBindingExpected,
  readFacadeAbiBindingHistory,
} = await import('../../js/ir-core.js?seal-test');
loader.deregister();

function makeRiscvAbiAdapter() {
  return {
    supported: true,
    argumentRegisters: () => ['x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17'],
    returnRegister: ({ returnType } = {}) => (returnType === 'double' || returnType === 'float' ? 'f10' : 'x10'),
  };
}

test('1. RISC-V s0-s11 registers are not misclassified as 32-bit floating', () => {
  const x10 = { id: 1, reg: 'x10', bits: 64, uses: [] };
  const s0 = { id: 2, reg: 's0', bits: 64, uses: [] };
  const s1 = { id: 3, reg: 's1', bits: 64, uses: [] };
  const addDst = { id: 4, reg: 'x10', bits: 64, uses: [] };

  const addInst = {
    id: 'i_add', row: 1, block: 0, op: OP.BIN, sub: 'add',
    dst: addDst, args: [{ value: x10 }, { value: s0 }],
  };
  addDst.def = addInst;
  x10.uses.push(addInst);
  s0.uses.push(addInst);

  const movInst = {
    id: 'i_mov', row: 2, block: 0, op: OP.MOV,
    dst: s1, args: [{ value: addDst }],
  };
  s1.def = movInst;
  addDst.uses.push(movInst);

  const retInst = { id: 'i_ret', row: 3, block: 0, op: OP.RET, args: [{ value: addDst }] };
  addDst.uses.push(retInst);

  const ir = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [x10, s0, s1, addDst],
    args: new Map([['x10', x10]]),
    instructions: [addInst, movInst, retInst],
  };

  const recovered = inferSemanticTypes(ir, {}, { abiAdapter: makeRiscvAbiAdapter() });
  const s0Type = recovered.values.get(s0.id);
  const s1Type = recovered.values.get(s1.id);
  assert.notEqual(s0Type?.kind, 'float', 'RISC-V s0 must not be classified as floating');
  assert.notEqual(s0Type?.name, 'float');
  assert.equal(s0Type?.bits, 64);
  assert.notEqual(s1Type?.kind, 'float', 'RISC-V s1 must not be classified as floating');
  assert.equal(s1Type?.bits, 64);
});

test('2. RISC-V x10-x17 argument registers are preserved by hasRealValueUse on fixed-arity calls', () => {
  // x10 (a0) is arg index 0, x11 (a1) is arg index 1.
  // Calling strlen (arity 1) where call.args is empty (matchedIdx < 0):
  // x10 must NOT be dropped (even though /x(\d+)/ gives 10 >= 1),
  // whereas x11 (index 1 >= 1) SHOULD be filtered out.
  const x10 = { id: 10, reg: 'x10', bits: 64, uses: [] };
  const x11 = { id: 11, reg: 'x11', bits: 64, uses: [] };
  const lenDst = { id: 12, reg: 'x10', bits: 64, uses: [] };

  const callStrlen = {
    id: 'c_strlen', row: 1, block: 0, op: OP.CALL, dst: lenDst,
    extra: { name: 'strlen' },
    args: [],
  };
  lenDst.def = callStrlen;
  x10.uses.push(callStrlen);
  x11.uses.push(callStrlen);

  const ret = { id: 'c_ret', row: 2, block: 0, op: OP.RET, args: [{ value: lenDst }] };
  lenDst.uses.push(ret);

  const ir = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [x10, x11, lenDst],
    args: new Map([['x10', x10], ['x11', x11]]),
    instructions: [callStrlen, ret],
  };

  const recovered = inferSemanticTypes(ir, {}, { abiAdapter: makeRiscvAbiAdapter() });
  assert.deepEqual(recovered.args.map((a) => a.reg), ['x10']);
  assert.equal(recovered.args[0].type, 'void *');
});

test('3. recordPassThroughForCall does not invent phantom incoming args when wN or non-dominating defs exist', () => {
  // 3a. Local w2 = 10 and x1 = 0 before strtol(x0, x1, w2): only x0 is incoming.
  const x1Local = { id: 1, reg: 'x1', bits: 64, uses: [] };
  const w2Local = { id: 2, reg: 'w2', bits: 32, uses: [] };
  const resDst = { id: 3, reg: 'x0', bits: 64, uses: [] };

  const defX1 = { id: 'i_x1', row: 1, block: 0, op: OP.MOV, dst: x1Local, args: [{ imm: 0 }] };
  x1Local.def = defX1;
  const defW2 = { id: 'i_w2', row: 2, block: 0, op: OP.MOV, dst: w2Local, args: [{ imm: 10 }] };
  w2Local.def = defW2;
  const callStrtol = {
    id: 'i_call', row: 3, block: 0, op: OP.CALL, dst: resDst,
    extra: { name: 'strtol' },
    args: [],
  };
  resDst.def = callStrtol;
  const ret = { id: 'i_ret', row: 4, block: 0, op: OP.RET, args: [{ value: resDst }] };
  resDst.uses.push(ret);

  const irA = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [x1Local, w2Local, resDst],
    args: new Map(),
    instructions: [defX1, defW2, callStrtol, ret],
  };
  const recA = inferSemanticTypes(irA, {});
  assert.deepEqual(recA.args.map((a) => a.reg), ['x0']);
  assert.equal(recA.args[0].type, 'void *');
  assert.equal(recA.ret.type, 'int64');

  // 3b. Non-dominating block defines x1 before merge block calls strcmp(x0, x1):
  // x1 must NOT become a phantom incoming pass-through arg.
  const b1X1 = { id: 20, reg: 'x1', bits: 64, uses: [] };
  const cmpDst = { id: 21, reg: 'x0', bits: 32, uses: [] };
  const b0Br = { id: 'b0_br', row: 0, block: 0, op: OP.CBR, args: [] };
  const b1Def = { id: 'b1_def', row: 1, block: 1, op: OP.MOV, dst: b1X1, args: [{ imm: 0x1000 }] };
  b1X1.def = b1Def;
  const b3Call = { id: 'b3_call', row: 3, block: 3, op: OP.CALL, dst: cmpDst, extra: { name: 'strcmp' }, args: [] };
  cmpDst.def = b3Call;
  const b3Ret = { id: 'b3_ret', row: 4, block: 3, op: OP.RET, args: [{ value: cmpDst }] };
  cmpDst.uses.push(b3Ret);

  const irB = {
    blocks: [
      { id: 0, idom: -1 },
      { id: 1, idom: 0 },
      { id: 2, idom: 0 },
      { id: 3, idom: 0 },
    ],
    idom: [-1, 0, 0, 0],
    values: [b1X1, cmpDst],
    args: new Map(),
    instructions: [b0Br, b1Def, b3Call, b3Ret],
  };
  const recB = inferSemanticTypes(irB, {});
  assert.deepEqual(recB.args.map((a) => a.reg), ['x0']);

  // 3c. Local w0 def overwrites incoming x0 before puts(w0): no phantom x0 pass-through.
  const x0In = { id: 30, reg: 'x0', bits: 64, uses: [] };
  const w0DefVal = { id: 31, reg: 'w0', bits: 32, uses: [] };
  const putsDst = { id: 32, reg: 'x0', bits: 32, uses: [] };
  const defW0 = { id: 'i_w0', row: 1, block: 0, op: OP.MOV, dst: w0DefVal, args: [{ imm: 0 }] };
  w0DefVal.def = defW0;
  const callPuts = { id: 'i_puts', row: 2, block: 0, op: OP.CALL, dst: putsDst, extra: { name: 'puts' }, args: [] };
  putsDst.def = callPuts;
  const retPuts = { id: 'i_retp', row: 3, block: 0, op: OP.RET, args: [{ value: putsDst }] };
  putsDst.uses.push(retPuts);

  const irC = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [x0In, w0DefVal, putsDst],
    args: new Map([['x0', x0In]]),
    instructions: [defW0, callPuts, retPuts],
  };
  const recC = inferSemanticTypes(irC, {});
  assert.deepEqual(recC.args, [], 'w0 local def must suppress incoming x0 pass-through');
});

test('4. Precomputed dominatedByEarlierCall suppresses second-call pass-through across same and dominating blocks', () => {
  const c1Dst = { id: 1, reg: 'x0', bits: 64, uses: [] };
  const c2Dst = { id: 2, reg: 'x0', bits: 64, uses: [] };
  const call1 = { id: 'c1', row: 1, block: 0, op: OP.CALL, dst: c1Dst, extra: { name: 'strlen' }, args: [] };
  c1Dst.def = call1;
  // Second call in dominated block 1 takes 3 args (memcpy); because block 0 dominates block 1
  // and already has a call, x1 and x2 must NOT be inferred as incoming pass-through args.
  const call2 = { id: 'c2', row: 2, block: 1, op: OP.CALL, dst: c2Dst, extra: { name: 'memcpy' }, args: [] };
  c2Dst.def = call2;
  const ret = { id: 'r1', row: 3, block: 1, op: OP.RET, args: [{ value: c2Dst }] };
  c2Dst.uses.push(ret);

  const ir = {
    blocks: [{ id: 0, idom: -1 }, { id: 1, idom: 0 }],
    idom: [-1, 0],
    values: [c1Dst, c2Dst],
    args: new Map(),
    instructions: [call1, call2, ret],
  };
  const rec = inferSemanticTypes(ir, {});
  assert.deepEqual(rec.args.map((a) => a.reg), ['x0']);
});

test('5. call-prototypes & type-recovery: atol/atoll/strtol/strtoll/lround* use retType long -> int64', () => {
  for (const name of ['atol', 'atoll', 'strtol', 'strtoll', 'lround', 'lroundf', 'llround', 'llroundf']) {
    const sig = knownCallSignature(name);
    assert.ok(sig, `expected signature for ${name}`);
    assert.equal(sig.retType, 'long', `${name} should have retType 'long'`);
  }

  // Tail call to lround recovers int64 return and double arg.
  const tailBr = { id: 't_lround', row: 0, block: 0, op: OP.BR, extra: { name: 'lround' }, args: [] };
  const irTail = {
    blocks: [{ id: 0, idom: -1, succ: [], insts: [tailBr] }],
    idom: [-1],
    values: [],
    args: new Map(),
    instructions: [tailBr],
  };
  const recTail = inferSemanticTypes(irTail, {});
  assert.equal(recTail.ret.type, 'int64');
  assert.equal(semanticSignature('round_long', recTail), 'int64 round_long(double a1)');
});

test('6. flag-semantics: atomicOperandText parenthesizes top-level arithmetic ops and fast-paths decimals', () => {
  assert.equal(renderNZCVCondition('sub', 'lt', 'a + b', 'c', 64), '(int64_t)(a + b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a - b', 'c', 64), '(int64_t)(a - b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a * b', 'c', 64), '(int64_t)(a * b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a / b', 'c', 64), '(int64_t)(a / b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a % b', 'c', 64), '(int64_t)(a % b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'a, b', 'c', 64), '(int64_t)(a, b) < (int64_t)c');

  // Decimal literals, member access, function calls, and unary prefix ops stay unparenthesized.
  assert.equal(renderNZCVCondition('sub', 'lt', 'x', '123', 64), '(int64_t)x < 123');
  assert.equal(renderNZCVCondition('sub', 'lt', 'x', '-42', 64), '(int64_t)x < -42');
  assert.equal(renderNZCVCondition('sub', 'lt', 'p->field', 'c', 64), '(int64_t)p->field < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', 'fn(a, b)', 'c', 64), '(int64_t)fn(a, b) < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', '-x', 'c', 64), '(int64_t)-x < (int64_t)c');
  assert.equal(renderNZCVCondition('sub', 'lt', '*ptr', 'c', 64), '(int64_t)*ptr < (int64_t)c');
});

test('7. sealFacadeAbiBindings: failed calls batch does not invalidate returns isCurrent()', () => {
  const lines = ['mov w0, #7', 'bl #0x100001000', 'ret'];
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: 0x100000000n + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });

  let legacyCall = null;
  let tampered = false;
  let callsSelectionValid = true;
  let callsSelectionChecksAfterSeal = 0;
  let sealed = false;
  const ir = buildIR(model, {
    rowOfAddress,
    returnType: 'int32',
    semanticMigrationMode: 'semantic-v2-compat',
    __abiFixture(legacyV1) {
      legacyCall = legacyV1.instructions.find((inst) => inst.op === 'call');
    },
    __beforeSeal(callObserver) {
      const origSelection = callObserver.selection;
      callObserver.selection = (following) => {
        if (sealed) callsSelectionChecksAfterSeal++;
        return callsSelectionValid && origSelection(following);
      };
    },
    callPrototypeFor() {
      // Mutate the legacy call's projected argument IDs during the prototype callback
      // so the calls batch observation fails in sealFacadeAbiBindings while returns succeeds.
      if (legacyCall?.extra?.abiProjectedArgumentValueIds) {
        legacyCall.extra.abiProjectedArgumentValueIds.push('tampered-before-seal');
        tampered = true;
      }
      return { returnType: 'int32', returnBits: 32, returnsValue: true, args: [{ type: 'int32', bits: 32 }] };
    },
  });
  sealed = true;

  assert.equal(tampered, true);
  const retInst = ir.instructions.find((inst) => inst.op === 'ret');
  const irCall = ir.instructions.find((inst) => inst.op === 'call');
  assert.ok(retInst && irCall);
  assert.equal(facadeAbiBindingExpected(ir, irCall), true);
  assert.equal(readFacadeAbiBindingHistory(ir, irCall), null, 'tampered calls batch must be rejected');

  const retHistory = readFacadeAbiBindingHistory(ir, retInst);
  assert.ok(retHistory, 'returns history must remain sealed when calls batch fails');
  assert.equal(retHistory.isCurrent(), true);

  // If calls' selection predicate later fails, returns' isCurrent() must stay true
  // because the failed calls batch must not have registered its selection check.
  callsSelectionValid = false;
  assert.equal(retHistory.isCurrent(), true, 'failed calls batch must not invalidate returns isCurrent()');
  assert.equal(callsSelectionChecksAfterSeal, 0, 'rejected calls selection check must not be invoked by returns isCurrent()');
  assert.ok(readFacadeAbiBindingHistory(ir, retInst), 'returns history must still be readable');
});
