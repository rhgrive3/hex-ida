import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  deepFreeze,
  stableDigest,
  stableStringify,
} from '../../js/core/identity/index.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR } from '../../js/ir.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { MEMORY_SSA_BUILD_VERSION, buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
} from '../../js/semantics/memoryssa/queries.js';

/**
 * Independent reference FNV-1a-128 implementation matching stableDigest's
 * canonical JSON byte stream (using stableStringify / JSON.stringify).
 */
function referenceStableDigestFromJsonText(jsonText) {
  let aLow = 0x84222325 | 0;
  let aHigh = 0xcbf29ce4 | 0;
  let bLow = 0xcbf29ce4 | 0;
  let bHigh = 0x84222325 | 0;
  for (let i = 0; i < jsonText.length; i += 1) {
    const code = jsonText.charCodeAt(i);
    aLow ^= code;
    const aCarry = ((aLow >>> 16) * 0x1b3 + (((aLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    aHigh = (Math.imul(aHigh, 0x1b3) + (aLow << 8) + aCarry) | 0;
    aLow = Math.imul(aLow, 0x1b3);
    bLow ^= code;
    const bCarry = ((bLow >>> 16) * 0x1b3 + (((bLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    bHigh = (Math.imul(bHigh, 0x1b3) + (bLow << 8) + bCarry) | 0;
    bLow = Math.imul(bLow, 0x1b3);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(aHigh) + hex(aLow) + hex(bHigh) + hex(bLow);
}

const BASE = 0x100000000n;

function asm(lines, base = BASE) {
  return lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i) * 4n,
      mn: sp < 0 ? s : s.slice(0, sp),
      ops: sp < 0 ? '' : s.slice(sp + 1).trim(),
    };
  });
}

function buildMultiBlockArm64(diamondCount = 20) {
  const lines = [
    'sub sp, sp, #0x40',
    'stp x29, x30, [sp, #0x30]',
    'add x29, sp, #0x30',
    'mov x8, #0x10',
    'str x8, [sp, #0x10]',
    'mov x9, #0x20',
    'str x9, [x0, #0x08]',
  ];
  for (let d = 0; d < diamondCount; d += 1) {
    const curRow = lines.length;
    const mergeRow = curRow + 6;
    const mergeAddr = '0x' + (BASE + BigInt(mergeRow) * 4n).toString(16);
    lines.push(
      `cmp x1, #${d}`,
      `b.eq ${mergeAddr}`,
      'add x8, x8, #1',
      'str x8, [sp, #0x10]',
      'ldr x10, [x0, #0x08]',
      'str x10, [x2, x3]',
      'ldr x11, [sp, #0x10]',
      'ldr x12, [x0, #0x08]',
      'add x8, x11, x12',
    );
  }
  lines.push(
    'mov x0, x8',
    'ldp x29, x30, [sp, #0x30]',
    'add sp, sp, #0x40',
    'ret',
  );
  const rowOfAddress = (addr) => {
    const rel = addr - BASE;
    if (rel < 0n || rel >= BigInt(lines.length) * 4n) return null;
    return Number(rel / 4n);
  };
  const model = buildSemanticModel(asm(lines, BASE), {
    startRow: 0,
    endRow: lines.length - 1,
    rowOfAddress,
  });
  return { model, rowOfAddress };
}

function buildMixedMemorySsaFixture(pairCount = 24) {
  const functionId = 'fn_tail_latency_forwarding_cache';
  const mkOrigin = (id, index = 0) => ({
    instructionIds: [id],
    virtualRanges: [{ start: 0x2000n + BigInt(index * 4), end: 0x2004n + BigInt(index * 4) }],
  });
  const mkMemory = (valueId) => ({
    addressSpace: 'memory',
    addressExpr: { valueId },
    widthBits: 32,
    endian: 'little',
    alignment: 4,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    faults: [],
  });
  const values = [];
  const nodes = [];
  for (let index = 0; index < pairCount; index += 1) {
    values.push(
      { id: `saddr_${index}`, kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: mkOrigin(`saddr_${index}`, index) },
      { id: `laddr_${index}`, kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: functionId, origin: mkOrigin(`laddr_${index}`, index) },
      { id: `stored_${index}`, kind: 'entry', machineType: { kind: 'bitvector', widthBits: 32 }, sourceEntityId: functionId, origin: mkOrigin(`stored_${index}`, index) },
      { id: `loaded_${index}`, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 32 }, definitionNodeId: `load_${index}`, sourceEntityId: `load_${index}`, origin: mkOrigin(`loaded_${index}`, index) },
    );
    nodes.push(
      { id: `store_${index}`, kind: 'store', blockId: 'b0', inputs: [`saddr_${index}`, `stored_${index}`], outputs: [], memory: mkMemory(`saddr_${index}`), attributes: {}, origin: mkOrigin(`store_${index}`, index) },
      { id: `load_${index}`, kind: 'load', blockId: 'b0', inputs: [`laddr_${index}`], outputs: [`loaded_${index}`], memory: mkMemory(`laddr_${index}`), attributes: {}, origin: mkOrigin(`load_${index}`, index) },
    );
  }
  const semanticIr = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id).concat('ret'), origin: mkOrigin('block') }],
    values,
    nodes: nodes.concat([{ id: 'ret', kind: 'return', blockId: 'b0', inputs: values.filter((v) => v.id.startsWith('loaded_')).map((v) => v.id), outputs: [], origin: mkOrigin('ret', pairCount) }]),
    completeness: 'complete',
    unknowns: [],
    origin: mkOrigin('function'),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', successors: [] }],
  });
  const regions = new Map();
  for (let i = 0; i < pairCount; i += 1) {
    regions.set(i, createMemoryRegionRef({
      id: `reg_${i}`,
      kind: 'stack-fixed',
      functionId,
      addressSpace: 'memory',
      offset: String(8 + i * 8),
      widthBits: 32,
      origin: mkOrigin(`reg_${i}`, i),
    }));
  }
  const memorySsa = buildMemorySsa(semanticIr, cfg, {
    identity: {
      binaryId: 'bin_tail_latency',
      functionId,
      semanticIrDigest: stableDigest(semanticIr),
      buildVersion: MEMORY_SSA_BUILD_VERSION,
    },
    resolveRegion(access) {
      const idx = Number(String(access.addressExpr.valueId).split('_')[1]);
      return regions.get(idx);
    },
    queryAlias(left, right) {
      if (left.id === `reg_${pairCount - 1}` || right.id === `reg_${pairCount - 1}`) return 'may';
      return left.id === right.id ? 'must' : 'no';
    },
  });
  return { semanticIr, memorySsa };
}

test('stableDigest ASCII fast-path is 100% bit-identical to JSON.stringify canonical stream', () => {
  const samples = [
    '',
    'a',
    'plain_ascii-0123456789/semantics:node#42',
    ' !#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~',
    'quote"inside',
    'backslash\\inside',
    'control\x00\x01\x08\t\n\r\x1fchars',
    'del\x7fchar',
    'non-ascii: 日本語 🚀 café',
    'lone-surrogate:\uD800:\uDFFF',
    {
      plainKey: 'plainValue',
      'key"with\\escapes': 'val\n\t\x00',
      '日本語キー': ['a', 'b"c', 'd\\e', 'f\x7fg', 0, -0, true, false, null],
      nested: { id: 'fn:0x1000', blockId: 'blk:0', kind: 'phi' },
    },
  ];
  for (const sample of samples) {
    const actual = stableDigest(sample);
    const expected = referenceStableDigestFromJsonText(stableStringify(sample));
    assert.equal(actual, expected, `digest mismatch for ${JSON.stringify(sample)}`);
  }
});

test('deepFreeze WeakSet fast-path preserves re-entry, cycles, typed arrays, and getter semantics', () => {
  const shared = deepFreeze({
    id: 'origin:shared',
    items: ['a', 'b', 'c'],
    nested: { x: 1, y: 2 },
  });
  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(shared.items), true);
  assert.equal(Object.isFrozen(shared.nested), true);

  assert.equal(deepFreeze(shared), shared);

  const cyclic = { name: 'cycle' };
  cyclic.self = cyclic;
  const frozenCycle = deepFreeze(cyclic);
  assert.equal(frozenCycle, cyclic);
  assert.equal(Object.isFrozen(frozenCycle), true);
  assert.equal(deepFreeze(frozenCycle), frozenCycle);

  const buf = new ArrayBuffer(8);
  const view = new Uint8Array(buf);
  assert.equal(deepFreeze(buf), buf);
  assert.equal(deepFreeze(view), view);

  let getterCalls = 0;
  const withGetter = {
    get value() {
      getterCalls += 1;
      return { ok: true };
    },
  };
  deepFreeze(withGetter);
  assert.equal(getterCalls, 1);
  deepFreeze(withGetter);
  assert.equal(getterCalls, 1);

  const t0 = performance.now();
  for (let i = 0; i < 5000; i += 1) {
    deepFreeze({ wrapper: i, shared });
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 2000, `repeated deepFreeze with shared subgraph took ${elapsed.toFixed(1)}ms`);
});

test('forwardingCoverageStates caches failure outcomes and respects AbortSignal', () => {
  const { semanticIr, memorySsa } = buildMixedMemorySsaFixture(24);
  assert.ok(Array.isArray(memorySsa.uses) && memorySsa.uses.length === 24, 'expected 24 memory uses');

  const queryOptions = {
    ir: semanticIr,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  };

  const firstResults = memorySsa.uses.map((use) => forwardMemoryValue(memorySsa, use.id, queryOptions));
  const tRepeatStart = performance.now();
  const secondResults = memorySsa.uses.map((use) => forwardMemoryValue(memorySsa, use.id, queryOptions));
  const repeatElapsedMs = performance.now() - tRepeatStart;
  assert.deepEqual(secondResults, firstResults);
  assert.ok(repeatElapsedMs < 500, `cached forwardMemoryValue sweep took ${repeatElapsedMs.toFixed(1)}ms`);

  const liveController = new AbortController();
  const withLiveSignal = memorySsa.uses.map((use) =>
    forwardMemoryValue(memorySsa, use.id, { ...queryOptions, signal: liveController.signal }));
  assert.deepEqual(withLiveSignal, firstResults);

  const abortedController = new AbortController();
  abortedController.abort();
  const cancelledResult = forwardMemoryValue(memorySsa, memorySsa.uses[0].id, {
    ...queryOptions,
    signal: abortedController.signal,
  });
  assert.equal(cancelledResult.status, 'cancelled');
});

test('multi-block ARM64 buildIR is bit-identical across runs and avoids tail-latency cliff', () => {
  const { model, rowOfAddress } = buildMultiBlockArm64(20);
  const t0 = performance.now();
  const ir1 = buildIR(model, { rowOfAddress });
  const elapsedMs = performance.now() - t0;
  const ir2 = buildIR(model, { rowOfAddress });

  assert.ok(ir1 && ir2, 'expected valid IR');
  assert.ok(ir1.blocks.length >= 40, `expected >= 40 blocks, got ${ir1.blocks.length}`);
  assert.ok(ir1.memorySafety.unknownStores > 0, 'expected unknown store barriers to be hardened');
  assert.ok(ir1.compat?.scalarSsa && ir1.compat?.memorySsa, 'expected canonical scalarSsa and memorySsa');

  const summary = (ir) => ({
    blockCount: ir.blocks.length,
    instCount: ir.instructions.length,
    valueCount: ir.values.length,
    memorySafety: ir.memorySafety,
    ssaDigest: stableDigest(ir.compat.scalarSsa),
    memorySsaDigest: stableDigest(ir.compat.memorySsa),
  });
  assert.deepEqual(summary(ir1), summary(ir2), 'buildIR must be bit-identical across runs');
  assert.ok(elapsedMs < 10000, `40+ block buildIR took ${elapsedMs.toFixed(1)}ms (expected < 10000ms)`);
});
