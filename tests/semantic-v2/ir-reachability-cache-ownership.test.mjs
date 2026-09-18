/*
 * The Semantic IR must stay a pure data structure.
 *
 * Regression: `blockReachability(ir)` used to memoize its closure on the IR
 * itself as `ir._canReachBlock`. A single unknown-store query therefore appended
 * a function-valued own property to the IR, so `structuredClone(ir)` threw
 * DataCloneError even for a small CFG, and the Phase 8 identity walk rejected
 * the function-valued property as non-semantic metadata.
 *
 * Reachability is a runtime-only memo and now lives in a module-owned WeakMap
 * keyed by IR. These contracts pin the ownership: queries must not move the
 * query cache into the IR, must keep the previous barrier semantics, and must
 * still reuse the explored answers for one IR.
 *
 * The same ownership now covers the build-time closures: the IR no longer
 * carries `defUse` (or the legacy `newValue`) as a function-valued own
 * property. The def-use index is the published `values` table and is read
 * through the canonical `defUseFor(ir)` accessor, so the IR is a serializable
 * semantic value.
 */
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, MK, hasUnknownStoreBarrier, defUseFor } from '../../js/ir.js';
import * as irBaseModule from '../../js/ir-base.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, index) => {
    const text = line.trim();
    const split = text.indexOf(' ');
    return {
      row: index,
      address: BASE + BigInt(index * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    if (delta < 0n || delta >= BigInt(lines.length * 4)) return null;
    return Number(delta / 4n);
  };
  return { model: buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress }), rowOfAddress };
}

// entry(0) -> body(1) -> exit(2): a concrete store, an unknown indexed store and
// a load laid out so that ordering between them is only decidable by walking the
// block graph.
function irWithUnknownStore() {
  const concreteStore = { id: 'i_concrete_store', op: OP.STORE, loc: { kind: MK.GLOBAL, address: 0x3000n, size: 8 }, block: 0, row: 0 };
  const unknownStore = { id: 'i_unknown_store', op: OP.STORE, loc: { kind: MK.UNKNOWN, size: 8 }, block: 1, row: 0 };
  const load = { id: 'i_load', op: OP.LOAD, loc: { kind: MK.GLOBAL, address: 0x3000n, size: 8 }, block: 2, row: 0 };
  const ir = {
    instructions: [concreteStore, unknownStore, load],
    blocks: [{ succ: [1] }, { succ: [2] }, { succ: [] }],
  };
  return { ir, concreteStore, unknownStore, load };
}

function irWithoutUnknownStore() {
  const concreteStore = { id: 'i_concrete_store', op: OP.STORE, loc: { kind: MK.GLOBAL, address: 0x3000n, size: 8 }, block: 0, row: 0 };
  const load = { id: 'i_load', op: OP.LOAD, loc: { kind: MK.GLOBAL, address: 0x3000n, size: 8 }, block: 2, row: 0 };
  const ir = { instructions: [concreteStore, load], blocks: [{ succ: [1] }, { succ: [2] }, { succ: [] }] };
  return { ir, concreteStore, load };
}

function functionValuedOwnKeys(value) {
  return Reflect.ownKeys(value).filter((key) => typeof Object.getOwnPropertyDescriptor(value, key).value === 'function');
}

// ── barrier semantics are unchanged ──────────────────────────────────────────
{
  const { ir, concreteStore, load } = irWithUnknownStore();
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true,
    'an unknown store on the concrete-store -> load path stays a barrier');
  assert.equal(hasUnknownStoreBarrier(ir, load, { block: 1, row: 1 }), false,
    'reachability stays directional: the load cannot reach back to the unknown store');
}

{
  const { ir, concreteStore, load } = irWithoutUnknownStore();
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), false,
    'a concrete store alone is not an unknown-store barrier');
}

// ── the query cache never becomes IR state ───────────────────────────────────
for (const [label, query] of [['js/ir.js', hasUnknownStoreBarrier], ['js/ir-base.js', irBaseModule.hasUnknownStoreBarrier]]) {
  const { ir, concreteStore, load } = irWithUnknownStore();
  const keysBefore = Reflect.ownKeys(ir).map(String).sort();

  assert.equal(query(ir, concreteStore, load), true, `${label}: barrier answer changed`);
  assert.equal(query(ir, concreteStore, load), true, `${label}: repeated barrier answer changed`);

  assert.equal(Object.hasOwn(ir, '_canReachBlock'), false,
    `${label}: the reachability closure must not be stored on the Semantic IR`);
  assert.equal(typeof ir._canReachBlock, 'undefined',
    `${label}: _canReachBlock must not be readable from the Semantic IR`);
  assert.deepEqual(functionValuedOwnKeys(ir), [],
    `${label}: a query must not attach a function-valued cache to the Semantic IR`);

  // `_unknownStoreBarriers` (an array) keeps its existing derived-key contract;
  // nothing else may appear, and no function-valued property may appear at all.
  const added = Reflect.ownKeys(ir).map(String).filter((key) => !keysBefore.includes(key));
  assert.deepEqual(added, ['_unknownStoreBarriers'],
    `${label}: a query may only add the pre-existing derived barrier index`);

  const clone = structuredClone(ir);
  assert.equal(clone.blocks.length, 3, `${label}: the IR must stay structured-cloneable after a query`);
  assert.equal(clone.instructions.length, 3, `${label}: the cloned IR must keep its instructions`);
}

// ── explored answers are reused instead of re-walking the CFG ────────────────
{
  const { ir, concreteStore, load } = irWithUnknownStore();
  let blockReads = 0;
  ir.blocks = new Proxy(ir.blocks, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) blockReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true);
  const readsAfterFirstQuery = blockReads;
  assert.ok(readsAfterFirstQuery > 0, 'the first reachability query must walk the CFG');

  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true);
  assert.equal(blockReads, readsAfterFirstQuery,
    'a repeated query must reuse the runtime memo instead of re-exploring the CFG');
}

// ── the memo is keyed per IR: no reachability facts leak across IRs ──────────
{
  const reachable = irWithUnknownStore();
  const unreachable = irWithUnknownStore();
  // Same instructions, but the unknown store sits in a block the entry cannot reach.
  unreachable.ir.blocks = [{ succ: [2] }, { succ: [] }, { succ: [] }];

  assert.equal(hasUnknownStoreBarrier(reachable.ir, reachable.concreteStore, reachable.load), true);
  assert.equal(hasUnknownStoreBarrier(unreachable.ir, unreachable.concreteStore, unreachable.load), false,
    'reachability must be computed per IR, never shared between IRs');
  assert.equal(hasUnknownStoreBarrier(reachable.ir, reachable.concreteStore, reachable.load), true,
    'an interleaved query must not inherit another IR\'s answers');
}

// ── the same ownership holds for a production buildIR product ────────────────
{
  const { model, rowOfAddress } = modelOf([
    'mov w8, #5',
    'str w8, [x19, #0x20]',
    'str w9, [x19, x3, lsl #2]',
    'ldr w10, [x19, #0x20]',
    'ret',
  ]);
  const ir = buildIR(model, { rowOfAddress });
  assert.ok(ir, 'the ARM64 fixture must build a Semantic IR');

  const concreteStore = ir.instructions.find((inst) => inst.op === OP.STORE && inst.loc && inst.loc.kind !== MK.UNKNOWN);
  const unknownStore = ir.instructions.find((inst) => inst.op === OP.STORE && (!inst.loc || inst.loc.kind === MK.UNKNOWN));
  const load = ir.instructions.find((inst) => inst.op === OP.LOAD);
  assert.ok(concreteStore && unknownStore && load, 'the fixture must contain a concrete store, an unknown store and a load');

  // The unknown store must still harden the stale reaching-store proof.
  assert.deepEqual(ir.memorySafety, { unknownStores: 1, blockedLoads: 1 });
  assert.equal(load.reachingStore, undefined, 'the unknown store must invalidate the stale reaching store');
  assert.equal(load.memUse?.kind, 'clobber');
  assert.equal(load.memUse?.unknownAlias, true);
  assert.equal(load.unknownAliasBarrier, unknownStore, 'the blocked proof must name the unknown store barrier');

  const keysBefore = Reflect.ownKeys(ir).map(String).sort();
  const functionKeysBefore = functionValuedOwnKeys(ir).map(String);
  assert.deepEqual(functionKeysBefore, [],
    'a production Semantic IR must own no function-valued property: the build-time defUse/newValue closures were removed');
  assert.equal(defUseFor(ir), ir.values,
    'the def-use index is the published value table, read through the canonical accessor');
  assert.equal(typeof ir.defUse, 'undefined',
    'the IR must not expose a defUse runtime method');

  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true,
    'the unknown store must remain a barrier on a production IR');

  assert.deepEqual(Reflect.ownKeys(ir).map(String).sort(), keysBefore,
    'querying a production IR must not change its own property shape');
  assert.deepEqual(functionValuedOwnKeys(ir).map(String), functionKeysBefore,
    'no query may append a function-valued cache to a production IR');
  assert.equal(Object.hasOwn(ir, '_canReachBlock'), false);
  assert.doesNotThrow(() => structuredClone(ir),
    'a production Semantic IR must stay a serializable value');
}

console.log('semantic-v2 Semantic IR reachability cache ownership: PASS');
