import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadRuntimeContext() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  });
  context.globalThis = context;
  context.self = context;
  for (const file of ['js/words.js', 'js/address-provenance.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

function loadProvenance() {
  return loadRuntimeContext().AddressProvenance;
}

const AddressProvenance = loadProvenance();

// 1. Multiple entryKills for the same target must union all killed registers
{
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    entryKills: [
      [8n, [0]],
      [8n, [1]],
    ],
  });

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);

  // Before enter, all are present
  assert.equal(p.base(0, 2), 0x1000n);
  assert.equal(p.base(1, 2), 0x2000n);
  assert.equal(p.base(2, 2), 0x3000n);

  p.enter(8n);

  // Both register 0 and register 1 must be killed (null for regular base queries without fallback scanIndex)
  assert.equal(p.base(0, 2), null, 'r0 must be killed by first entryKill');
  assert.equal(p.base(1, 2), null, 'r1 must be killed by second entryKill');
  assert.equal(p.base(2, 2), 0x3000n, 'r2 must not be killed');
}

// 2. Commutativity: reversing entry order produces identical results
{
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    entryKills: [
      [8n, [1]],
      [8n, [0]],
    ],
  });

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null, 'r0 must be killed');
  assert.equal(p.base(1, 2), null, 'r1 must be killed');
  assert.equal(p.base(2, 2), 0x3000n, 'r2 must not be killed');
}

// 3. Duplicate registers across entries are cleanly deduplicated
{
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    entryKills: [
      [8n, [0, 1]],
      [8n, [1, 2]],
    ],
  });

  assert.equal(p.pendingEntries, 1, 'duplicate targets should count as 1 pending entry');

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);
  p.note(3, 0x4000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null);
  assert.equal(p.base(1, 2), null);
  assert.equal(p.base(2, 2), null);
  assert.equal(p.base(3, 2), 0x4000n);
}

// 4. Different targets do not contaminate each other
{
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 0x10000n,
    entryKills: [
      [8n, [0]],
      [16n, [1]],
    ],
  });

  assert.equal(p.pendingEntries, 2);

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null);
  assert.equal(p.base(1, 2), 0x2000n, 'r1 must remain valid when entering target 8n');

  p.enter(16n);
  assert.equal(p.base(1, 2), null, 'r1 must be killed upon entering target 16n');
}

// 5. Exercise the actual worker composition path. The wrapped scan inherits an
// x0 kill from the normal scanner while the backward-loop prepass contributes
// x1 for the same target. AddressProvenance.create() must observe both records
// and canonicalize them into one effective kill set.
{
  const context = loadRuntimeContext();
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  const literalX1 = 0x58000001; // ldr x1, literal: writes x1 at pc=4
  const backEqToZero = 0x54ffffc0; // b.eq from pc=8 to pc=0
  view.setUint32(4, literalX1, true);
  view.setUint32(8, backEqToZero, true);

  assert.equal(context.Words.classifyWord(literalX1), context.Words.KIND.LITERAL,
    'fixture must exercise the literal-write prepass path');
  assert.equal(context.Words.classifyWord(backEqToZero), context.Words.KIND.CONDBR,
    'fixture must exercise the conditional backward-edge path');
  assert.equal(context.Words.condBranchTarget(backEqToZero, 8n), 0n,
    'fixture branch must target the same entry as the inherited kill');

  const region = { id: 'r', vmAddr: 0n, fileOffset: 0n, size: BigInt(bytes.length) };
  context.regions = new Map([[region.id, region]]);
  context.functionStartsForRegion = () => [];
  context.cancelled = () => false;
  context.yieldToQueue = async () => {};
  context.readRange = async (offset, length) => {
    const start = Number(offset - region.fileOffset);
    return bytes.slice(start, start + length);
  };
  context.WRITES_LOW_REG = Object.create(null);
  context.findXrefs = async () => ({ results: [], cancelled: false, capped: false });

  context.scanProgram = () => {
    const p = context.AddressProvenance.create({
      rangeStart: 0n,
      rangeEnd: 0x10000n,
      entryKills: [[0n, [0]]],
    });
    p.note(0, 0x1000n, 0);
    p.note(1, 0x2000n, 0);
    p.note(2, 0x3000n, 0);
    p.enter(0n);
    return Promise.resolve({
      pendingEntries: p.pendingEntries,
      r0: p.base(0, 2),
      r1: p.base(1, 2),
      r2: p.base(2, 2),
    });
  };

  vm.runInContext(
    fs.readFileSync(path.join(root, 'js/worker-loop-provenance-fix.js'), 'utf8'),
    context,
    { filename: 'js/worker-loop-provenance-fix.js' },
  );

  const result = await context.scanProgram({ regionId: region.id, requestId: 'issue-6225' });
  assert.equal(result.pendingEntries, 0, 'same-target inherited/prepass kills must collapse to one consumed entry');
  assert.equal(result.r0, null, 'inherited x0 kill must survive worker composition');
  assert.equal(result.r1, null, 'prepass x1 kill must survive same-target worker composition');
  assert.equal(result.r2, 0x3000n, 'unrelated provenance must remain intact');
}

// 6. Duplicate kills must retain both first-visit contracts in either order:
// recent exact chains survive; older chains are available only through the
// explicit, bounded entry fallback and are never restored as ordinary proof.
for (const entries of [[[8n, [0]], [8n, [1]]], [[8n, [1]], [8n, [0]]]]) {
  const p = AddressProvenance.create({
    rangeStart: 0n,
    rangeEnd: 16n,
    pairWindow: 2,
    entryKills: entries,
  });
  p.note(0, 0x1000n, 1); // immediately before target instruction index 2
  p.note(1, 0x2000n, 0); // older preheader value: fallback only
  assert.equal(p.enter(8n), true);
  assert.equal(p.pendingEntries, 0);
  assert.equal(p.base(0, 2), 0x1000n, 'immediately preceding exact chain survives');
  assert.equal(p.base(1, 2), null, 'older killed chain is not ordinary proof');
  assert.equal(p.base(1, 2, { allowEntryFallback: true }), 0x2000n);
  assert.equal(p.base(1, 3, { allowEntryFallback: true }), null, 'fallback expires at the original window');
  p.kill(1);
  assert.equal(p.base(1, 2, { allowEntryFallback: true }), null, 'explicit write invalidation clears fallback');
  p.clear();
  assert.equal(p.base(0, 2, { allowEntryFallback: true }), null, 'full boundaries clear both forms');
}

console.log('issue #6225 address-provenance entryKills union regressions PASS');
