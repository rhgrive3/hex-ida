/*
 * The Semantic IR must own no runtime def-use closure.
 *
 * Regression: both Semantic IR producers published the def-use index as an own
 * function property:
 *
 *     ir.defUse = () => ir.values;                        // legacy ARM64 core
 *     projected.defUse = () => projected.values;          // v2 -> v1 projection
 *
 * A function-valued own property made the IR an unserializable carrier of
 * runtime state — `structuredClone(ir)` threw DataCloneError — and consumers
 * began probing `typeof ir.defUse === 'function'` as a compatibility contract.
 * The legacy core additionally published the dead `ir.newValue` builder
 * closure, which had the same effect.
 *
 * These contracts pin the replacement architecture: the def-use index stays
 * semantic data (the published `values` table, each value carrying its `uses`)
 * and is read through the canonical `defUseFor(ir)` accessor. Nothing is
 * attached to the IR, so the IR is a detached, serializable semantic value, and
 * a canonical v2 -> v1 projection is recognised by its semantic shape rather
 * than by a runtime method.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, irFor, OP, MK, hasUnknownStoreBarrier, defUseFor } from '../../js/ir.js';

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

// A concrete store, an unknown indexed store and a load of the concrete field,
// laid out so the unknown store sits between the store and the load.
const UNKNOWN_STORE_LINES = [
  'cmp w0, #0',
  `b.eq #${BASE + 20n}`,
  'str w1, [x19, #0x20]',
  'str w2, [x19, x3, lsl #2]',
  'ldr w8, [x19, #0x20]',
  'ret',
];

function functionValuedOwnKeys(value) {
  return Reflect.ownKeys(value).filter((key) => typeof Object.getOwnPropertyDescriptor(value, key).value === 'function');
}

function builtIR(mode) {
  const { model, rowOfAddress } = modelOf(UNKNOWN_STORE_LINES);
  const ir = buildIR(model, mode ? { rowOfAddress, semanticMigrationMode: mode } : { rowOfAddress });
  assert.ok(ir, `the fixture must build a Semantic IR (mode=${mode ?? 'default'})`);
  return ir;
}

test('a built Semantic IR owns no function-valued property and stays serializable', () => {
  const ir = builtIR();
  assert.deepEqual(Object.getOwnPropertyNames(ir).filter((key) => typeof ir[key] === 'function'), [],
    'the default (v2 compatibility) producer must not attach a runtime function to the IR');
  assert.equal(Object.hasOwn(ir, 'defUse'), false, 'defUse must not be an own property of the IR');
  assert.equal(typeof ir.defUse, 'undefined', 'the IR must not expose a defUse runtime method');
  assert.doesNotThrow(() => structuredClone(ir),
    'a Semantic IR must be a detached, serializable value');
});

test('the legacy ARM64 producer also attaches no runtime closure', () => {
  const ir = builtIR('legacy-v1');
  assert.deepEqual(Object.getOwnPropertyNames(ir).filter((key) => typeof ir[key] === 'function'), [],
    'the legacy-1 producer must not attach a runtime function to the IR');
  assert.equal(Object.hasOwn(ir, 'newValue'), false, 'the dead builder closure must not be published on the IR');
  assert.doesNotThrow(() => structuredClone(ir),
    'the legacy-built Semantic IR must be serializable too');
});

test('the def-use index is the published value table, read through the canonical accessor', () => {
  const ir = builtIR();
  assert.equal(defUseFor(ir), ir.values,
    'defUseFor must return the IR value table that used to be closed over by ir.defUse');
  assert.equal(defUseFor(null), null, 'defUseFor is total on non-IR values');
  assert.equal(defUseFor({}), null, 'an object without an SSA index yields no def-use index');
});

test('the def-use relation itself is unchanged: values still carry their instruction uses', () => {
  const ir = builtIR();
  const values = defUseFor(ir);
  assert.ok(values.length > 0, 'the fixture must produce SSA values');

  // Every argument of every instruction must be recorded as a use of the value
  // it reads. This is exactly what `ir.defUse()` used to expose.
  let observed = 0;
  for (const inst of ir.instructions) {
    for (const arg of inst.args ?? []) {
      const value = arg?.value;
      if (!value) continue;
      assert.ok(value.uses.includes(inst),
        `value ${value.id} must record instruction ${inst.id} as a use`);
      observed += 1;
    }
  }
  assert.ok(observed > 0, 'the fixture must exercise at least one def-use edge');
  assert.ok(values.some((value) => value.uses.length > 0),
    'at least one value must have a real def-use edge');
});

test('barrier semantics are untouched by the ownership change', () => {
  const ir = builtIR();
  const concreteStore = ir.instructions.find((inst) => inst.op === OP.STORE && inst.loc && inst.loc.kind !== MK.UNKNOWN);
  const load = ir.instructions.find((inst) => inst.op === OP.LOAD);
  assert.ok(concreteStore && load, 'the fixture must contain a concrete store and a load');

  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true,
    'the unknown store must still be reported as a barrier');
  const keysBefore = Reflect.ownKeys(ir).map(String).sort();
  assert.deepEqual(Reflect.ownKeys(ir).map(String).sort(), keysBefore,
    'the barrier query must not change the IR own property shape');
  assert.deepEqual(functionValuedOwnKeys(ir), [],
    'the barrier query must not attach a function-valued cache');
});

test('a canonical v2 -> v1 projection is recognised by semantic shape, not by a runtime method', () => {
  const projected = builtIR();
  assert.equal(projected.compat?.projection, 'semantic-ir-v2-to-v1',
    'the default producer must publish the canonical compatibility projection');
  assert.ok(Array.isArray(projected.values), 'the projection must publish its SSA value index');

  // The historical contract probe was `typeof model.defUse === 'function'`.
  // It must now rest on the published semantic data, or every projection would
  // look like a raw legacy model and be re-lifted by the legacy ARM64 decoder.
  assert.equal(irFor(projected, {}), projected,
    'a canonical compatibility projection must not be re-lifted');
});
