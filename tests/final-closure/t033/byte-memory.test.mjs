import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, MK } from '../../../js/ir.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import {
  ByteMemory,
  MEMORY_RESULT_STATUS,
} from '../../../js/symbolic/memory/byte-memory.js';
import { symbolicExecute } from '../../../js/symbolic/executor.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';

function valueOf(result) {
  const evaluated = evaluateExpr(result.expression);
  assert.equal(evaluated.status, EVAL_STATUS.VALUE);
  return evaluated.value;
}

test('T033 byte memory preserves little/big endian and partial byte stores', () => {
  const little = new ByteMemory();
  little.store(0x100n, 0x11223344n, { widthBits: 32, endian: 'little' });
  assert.equal(valueOf(little.read(0x100n, 32, { endian: 'little' })), 0x11223344n);
  assert.equal(valueOf(little.read(0x100n, 32, { endian: 'big' })), 0x44332211n);

  little.store(0x101n, 0xaan, { widthBits: 8 });
  assert.equal(valueOf(little.read(0x100n, 32, { endian: 'little' })), 0x1122aa44n);

  const big = new ByteMemory();
  big.store(0x200n, 0x11223344n, { widthBits: 32, endian: 'big' });
  assert.equal(valueOf(big.read(0x200n, 32, { endian: 'big' })), 0x11223344n);
  assert.equal(valueOf(big.read(0x200n, 32, { endian: 'little' })), 0x44332211n);
});

test('T033 holes and symbolic aliases remain explicit unknowns', () => {
  const memory = new ByteMemory();
  const hole = memory.read(0x300n, 32);
  assert.equal(hole.status, MEMORY_RESULT_STATUS.UNKNOWN);
  assert.equal(hole.reason, 'symbolic-memory-byte-hole');

  const pointer = { kind: 'pointer', name: 'p' };
  memory.store(pointer, 0x7fn, { widthBits: 8 });
  assert.equal(memory.tier, 'array');
  assert.equal(memory.read(pointer, 8).status, MEMORY_RESULT_STATUS.EXACT);
  assert.equal(memory.read(0x400n, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);

  memory.store({ kind: 'may-alias' }, 0x1n, { widthBits: 8, aliasRelation: 'may' });
  assert.equal(memory.read(0x100n, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);
  assert.equal(memory.read(0x100n, 8).reason, 'unknown-memory-alias');
});

test('T033 invalidates stale forwarding after potentially overlapping writes', () => {
  const a = { kind: 'pointer', name: 'a' };
  const b = { kind: 'pointer', name: 'b' };

  const symbolic = new ByteMemory();
  symbolic.store(a, 0x11n, { widthBits: 8 });
  symbolic.store(b, 0x22n, { widthBits: 8 });
  assert.equal(symbolic.read(a, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);
  assert.equal(valueOf(symbolic.read(b, 8)), 0x22n);

  const concreteAfterSymbolic = new ByteMemory();
  concreteAfterSymbolic.store(a, 0x33n, { widthBits: 8 });
  concreteAfterSymbolic.store(0x500n, 0x44n, { widthBits: 8 });
  assert.equal(concreteAfterSymbolic.read(a, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);
  assert.equal(valueOf(concreteAfterSymbolic.read(0x500n, 8)), 0x44n);

  const aliasClobber = new ByteMemory();
  aliasClobber.store(0x600n, 0x55n, { widthBits: 8 });
  aliasClobber.store({ kind: 'may-alias' }, 0x66n, { widthBits: 8, aliasRelation: 'may' });
  assert.equal(aliasClobber.read(0x600n, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);
  aliasClobber.store(0x600n, 0x77n, { widthBits: 8 });
  assert.equal(valueOf(aliasClobber.read(0x600n, 8)), 0x77n);
});

test('T033 base offsets stay symbolic and fresh-byte reads respect cell caps', () => {
  const memory = new ByteMemory();
  const p = { base: { kind: 'pointer', name: 'p' }, offset: 4 };
  const q = { base: { kind: 'pointer', name: 'q' }, offset: 4 };
  memory.store(p, 0x11n, { widthBits: 8 });
  assert.equal(valueOf(memory.read(p, 8)), 0x11n);
  memory.store(q, 0x22n, { widthBits: 8 });
  assert.equal(valueOf(memory.read(q, 8)), 0x22n);
  assert.equal(memory.read(4n, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);

  const keyed = new ByteMemory();
  const descriptor = { key: 'keyed', offset: 4 };
  keyed.store(descriptor, 0x33n, { widthBits: 8 });
  assert.equal(valueOf(keyed.read(descriptor, 8)), 0x33n);
  assert.equal(keyed.read(4n, 8).status, MEMORY_RESULT_STATUS.UNKNOWN);

  const capped = new ByteMemory({ maxSymbolicCells: 1 });
  const fresh = capped.read({ kind: 'pointer', name: 'fresh' }, 16, { allowFreshSymbols: true });
  assert.equal(fresh.status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
  assert.equal(capped.stats().symbolicMemoryCells, 1);
});

test('T033 volatile/atomic barriers and alias budgets remain terminally conservative', () => {
  const barrier = new ByteMemory({ initial: new Map([[0x700n, { value: 0x88n, widthBits: 8 }]]) });
  assert.equal(barrier.read(0x700n, 8, { volatile: true }).status, MEMORY_RESULT_STATUS.UNKNOWN);
  barrier.store(0x700n, 0x99n, { widthBits: 8 });
  assert.equal(valueOf(barrier.read(0x700n, 8)), 0x99n);

  const limited = new ByteMemory({ maxAliasForks: 1 });
  limited.store({ kind: 'pointer', name: 'first' }, 0x1n, { widthBits: 8 });
  assert.equal(limited.store({ kind: 'pointer', name: 'second' }, 0x2n, { widthBits: 8 }).status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
  assert.equal(limited.read({ kind: 'pointer', name: 'second' }, 8).status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
  assert.equal(limited.store(0x710n, 0x3n, { widthBits: 8 }).status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
});

test('T033 budget and cancellation produce typed non-exact results', () => {
  const limited = new ByteMemory({ maxConcreteBytes: 1 });
  limited.store(0x10n, 0x1234n, { widthBits: 16 });
  assert.equal(limited.status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
  assert.equal(limited.read(0x10n, 8).status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);

  const seededLimit = new ByteMemory({
    maxConcreteBytes: 1,
    initial: new Map([[0x20n, { value: 0x1234n, widthBits: 16 }]]),
  });
  assert.equal(seededLimit.status, MEMORY_RESULT_STATUS.BUDGET_LIMITED);
  assert.ok(seededLimit.stats().concreteMemoryBytes <= 1);

  const seededCancelled = new ByteMemory({
    initial: new Map([[0x30n, { value: 0x12n, widthBits: 8 }]]),
    isCancelled: () => true,
  });
  assert.equal(seededCancelled.status, MEMORY_RESULT_STATUS.CANCELLED);

  let cancelled = false;
  const memory = new ByteMemory({ isCancelled: () => cancelled });
  cancelled = true;
  assert.equal(memory.read(0x10n, 8).status, MEMORY_RESULT_STATUS.CANCELLED);
});

function memoryIr() {
  const stored = { id: 'value', const: 0x11223344n, bits: 32 };
  const dst = { id: 'loaded', bits: 32 };
  const loc = { kind: MK.GLOBAL, key: 'global:100', address: 0x100n, size: 4 };
  const store = { id: 'store', op: OP.STORE, row: 1, address: 1, loc, extra: { size: 4 }, args: [{ value: stored }] };
  const load = { id: 'load', op: OP.LOAD, row: 2, address: 2, loc, extra: { size: 4 }, dst };
  dst.def = load;
  const ret = { id: 'ret', op: OP.RET, row: 3, address: 3, args: [{ value: dst }] };
  return { entry: 0, blocks: [{ index: 0, insts: [store, load, ret], succ: [] }] };
}

test('T033 executor and translator consume the byte memory model', () => {
  const execution = symbolicExecute(memoryIr(), { symbolicMemory: true });
  assert.equal(execution.memoryModel, 'symbolic-byte-memory-v1');
  assert.equal(execution.paths[0].status, 'complete');
  assert.equal(execution.paths[0].returnValue.value, 0x11223344n);

  const loc = { kind: MK.GLOBAL, key: 'global:100', address: 0x100n, size: 4 };
  const load = { id: 'translate-load', op: OP.LOAD, loc, extra: { size: 4 }, dst: { bits: 32 } };
  const translated = translateSemanticIR(load, {
    symbolicMemory: true,
    memoryInitial: new Map([[0x100n, { value: 0x11223344n, widthBits: 32, endian: 'little' }]]),
  });
  assert.equal(translated.memoryModel, 'symbolic-byte-memory-v1');
  assert.equal(translated.status, 'exact');
  assert.equal(translated.expression.value, 0x11223344n);

  const digestA = stableDigest(new ByteMemory({ initial: new Map([[0x10n, { value: 0x1234n, widthBits: 16 }]]) }).snapshot());
  const digestB = stableDigest(new ByteMemory({ initial: new Map([[0x10n, { value: 0x1234n, widthBits: 16 }]]) }).snapshot());
  assert.equal(digestA, digestB);
});

test('T033 consumers preserve canonical memory uncertainty and access qualifiers', () => {
  const source = new ByteMemory();
  source.store({ kind: 'pointer', name: 'source-pointer' }, 0x1n, { widthBits: 8 });
  source.store({ kind: 'pointer', name: 'other-pointer' }, 0x2n, { widthBits: 8 });
  const dst = { id: 'qualified-loaded', bits: 8 };
  const load = {
    id: 'qualified-load', op: OP.LOAD, row: 1, loc: { kind: MK.GLOBAL, address: 0x900n, size: 1 },
    extra: { size: 1, memoryAccess: { volatile: true } }, dst,
  };
  dst.def = load;
  const ret = { id: 'qualified-ret', op: OP.RET, row: 2, args: [{ value: dst }] };
  const execution = symbolicExecute({ entry: 0, blocks: [{ index: 0, insts: [load, ret], succ: [] }] }, { symbolicMemory: source });
  assert.equal(execution.paths[0].status, 'unknown');
  assert.equal(execution.paths[0].reason, 'volatile-memory-barrier');
  assert.equal(execution.paths[0].memory.symbolicMemoryCells, 1);
  assert.equal(execution.paths[0].memory.storeHistoryEntries, 2);

  const qualified = translateSemanticIR({
    id: 'translate-qualified-load', op: OP.LOAD,
    loc: { kind: MK.GLOBAL, address: 0x901n, size: 1 },
    extra: { size: 1, memoryAccess: { atomic: true, ordering: 'acquire' } },
    dst: { bits: 8 },
  }, {
    symbolicMemory: true,
    memoryInitial: new Map([[0x901n, { value: 0x7fn, widthBits: 8 }]]),
  });
  assert.equal(qualified.status, 'unsupported');
  assert.equal(qualified.expression.kind, 'unknown_semantic');
  assert.equal(qualified.expression.reason, 'atomic-memory-barrier');
});
