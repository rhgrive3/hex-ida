import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { validateWasmFunctionTypes } from '../../../js/managed/wasm/validator.js';

// #8945: one `br_table` hid an attacker-controlled `count + 1` target vector
// outside the parser-wide resource budget and the VMEffect value budget. A
// structurally valid ~1 MiB module could terminate a 128 MiB analysis worker
// even when `maxOperations` / `maxValues` were configured far below the target
// count, because the parser, validator, and lifter all walked/materialized the
// inner vector without admission.

function uleb(v) {
  const out = [];
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
function section(id, payload) {
  return [...uleb(id), ...uleb(payload.length), ...payload];
}

// (func) with body `i32.const 0; br_table <count targets>; end`
function brTableModule(count, fill = 0x00) {
  const type = [0x60, 0x00, 0x00];
  const expr = [0x41, 0x00, 0x0e, ...uleb(count), ...new Array(count).fill(fill), 0x00, 0x0b];
  const body = [0x00, ...expr];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, ...type]),
    ...section(3, [1, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

// 1. Parser: a low operation budget rejects the oversized target vector while
//    walking it, before the full immediate scan completes.
assert.throws(
  () => parseWasm(brTableModule(1000000), { resourceBudget: { maxOperations: 100, deadlineMs: 30000 } }),
  (error) => error instanceof TypeError && error.message === 'wasm-resource-limit-operations',
);

// 2. Default parser budgets still admit the vector (work is charged, not
//    bypassed), and the shared VMEffect authority then fails closed at both
//    the validator and — when validation is given room — before switch record
//    materialization: the 1 MiB fixture terminates with a deterministic
//    resource-limit error rather than a V8 heap abort.
{
  const mod = parseWasm(brTableModule(1000000));
  assert.throws(
    () => liftWasmFunction(0, mod, { budget: { maxOperations: 4, maxValues: 2, maxExceptionRegions: 0 } }),
    (error) => error instanceof TypeError && /^vm-effect-resource-limit-(values|operations)$/.test(error.message),
  );
  assert.throws(
    () => liftWasmFunction(0, mod),
    (error) => error instanceof TypeError && error.message === 'vm-effect-resource-limit-values',
    'default value budget must reject 1,000,001 branch edges before the switch vectors materialize',
  );
}

// 3. Cancellation stays observable with bounded latency inside the large
//    immediate vector (the shared checkpoint now covers the inner loop).
assert.throws(
  () => parseWasm(brTableModule(200000), { signal: AbortSignal.abort() }),
  (error) => error.message === 'wasm-resource-limit-cancelled',
);

// 4. Small br_table keeps exact per-case/default semantics: mixed block /
//    loop / function-exit targets resolve to the same indexed records the
//    pre-#8945 dynamic `__case_<i>` dictionary produced.
{
  // (func (param i32) loop (block local.get 0 br_table 0 1 default 2))
  // case 0 -> inner block (holder resolved at its `end`), case 1 -> loop
  // (immediate body offset), default 2 -> function exit.
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0x01, 0x7f, 0x00]),
    ...section(3, [1, 0]),
    ...section(10, [1, ...uleb(15), 0x00, 0x03, 0x40, 0x02, 0x40, 0x20, 0x00, 0x0e, 0x02, 0x00, 0x01, 0x02, 0x0b, 0x0b, 0x0b]),
  ]);
  const fn = liftWasmFunction(0, parseWasm(bytes));
  const effect = fn.bundles.flatMap((b) => b.controlEffects).find((c) => c.kind === 'switch');
  assert.ok(effect, 'switch effect present');
  assert.deepEqual(effect.labelDepths, [0, 1], 'case label depths preserved in order');
  assert.equal(effect.defaultLabelDepth, 2);
  assert.deepEqual(effect.caseKinds, ['offset', 'offset'], 'block and loop case targets keep offset kinds');
  assert.equal(effect.defaultKind, 'function-exit', 'function-exit default kind preserved');
  assert.equal(effect.targetOffsets.length, 2);
  assert.ok(effect.targetOffsets.every((t) => Number.isSafeInteger(t) && t >= 0), 'block/loop case targets resolved to offsets');
  assert.equal(effect.targetOffsets[0], 12, 'block case target resolves to the block continuation offset');
  assert.equal(effect.targetOffsets[1], 2, 'loop case target is the loop body offset');
  assert.equal(effect.defaultTargetOffset, null, 'function-exit default has no bytecode offset');
}

// 5. Invalid branch depths still fail closed in the validator.
assert.throws(
  () => validateWasmFunctionTypes(0, parseWasm(brTableModule(1, 9))),
  (error) => error instanceof TypeError && error.message === 'wasm-invalid-branch-depth',
);

console.log('[phase11] issue #8945 wasm br_table target-vector admission regression passed');
