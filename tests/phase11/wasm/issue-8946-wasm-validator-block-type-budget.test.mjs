import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser-core.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { validateWasmFunctionTypes } from '../../../js/managed/wasm/validator.js';

// #8946: the #8711 fix bounded signature arity in the parser and pre-charged
// the lifter, but the public lift path runs the VALIDATOR first, and the
// validator cloned every referenced block signature into a fresh control frame
// with no value/work budget. A valid ~67 KiB module reusing one 65,536-param
// type from 500 nested typed blocks OOMed a 128 MiB worker before the
// authoritative budget could reject it.

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

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

// One i32-only `paramCount`-parameter function type (index 0) plus an empty
// type (index 1); function 0 uses the empty type and its body re-enters the
// shared wide type through `blockCount` nested `block (type 0)` instructions,
// made type-valid by the leading stack-polymorphic `unreachable`.
function typedBlockModule(paramCount, blockCount) {
  const wideType = [0x60, ...uleb(paramCount), ...new Array(paramCount).fill(0x7f), 0x00];
  const emptyType = [0x60, 0x00, 0x00];
  const expr = [0x00];
  for (let i = 0; i < blockCount; i++) expr.push(0x02, 0x00);
  expr.push(0x00);
  for (let i = 0; i < blockCount; i++) expr.push(0x0b);
  expr.push(0x0b);
  const body = [0x00, ...expr];
  return Uint8Array.from([
    ...HEADER,
    ...section(1, [2, ...wideType, ...emptyType]),
    ...section(3, [1, 1]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

// 1. The adversarial 65,536-param / 500-block public lift terminates normally
//    with the deterministic resource-limit error instead of a V8 OOM.
{
  const mod = parseWasm(typedBlockModule(65536, 500));
  assert.throws(
    () => liftWasmFunction(0, mod),
    (error) => error instanceof TypeError && /^vm-effect-resource-limit-(values|operations)$/.test(error.message),
    'typed-block amplification must fail closed at the shared VMEffect budget',
  );
}

// 2. A low value budget rejects at the validator boundary itself, before the
//    first large block signature is traversed.
{
  const mod = parseWasm(typedBlockModule(100, 1));
  assert.throws(
    () => validateWasmFunctionTypes(0, mod, { budget: { maxValues: 10, maxOperations: 100000, maxExceptionRegions: 1000 } }),
    (error) => error instanceof TypeError && error.message === 'vm-effect-resource-limit-values',
  );
}

// 3. Reusing one shared block type many times keeps only canonical references:
//    retained validator memory stays flat in the number of references, not
//    O(references x signatureWidth) cloned vectors.
{
  const P = 8192;
  const N = 2000;
  const mod = parseWasm(typedBlockModule(P, N));
  const options = { budget: { maxValues: P * N + 1000, maxOperations: 16 * N + 1000, maxExceptionRegions: 100000 } };
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const validation = validateWasmFunctionTypes(0, mod, options);
  const retained = process.memoryUsage().heapUsed - before;
  assert.equal(validation.complete, true, 'bounded reuse must still validate exactly');
  // Cloning would retain >= N x P x 8 bytes (~128 MiB here); canonical shared
  // references must keep validator retention far below that floor.
  assert.ok(retained < 32 * 1024 * 1024, `validator retained ${(retained / 1024 / 1024).toFixed(1)} MiB for ${N} x ${P} shared block type`);
}

// 4. Exact typed-block checking is preserved rather than degraded to partial:
//    a block parameter vector against an empty stack still fails closed.
{
  const mod = Uint8Array.from([
    ...HEADER,
    ...section(1, [1, 0x60, 0x01, 0x7e, 0x00]),
    ...section(3, [1, 0]),
    ...section(10, [1, ...uleb(5), 0x00, 0x02, 0x00, 0x0b, 0x0b]),
  ]);
  assert.throws(
    () => validateWasmFunctionTypes(0, parseWasm(mod)),
    (error) => error instanceof TypeError && error.message === 'wasm-stack-underflow-block-params',
    'an i64-parameter block with an empty stack keeps exact underflow authority',
  );
}

// 5. Small shared-type reuse and stack-polymorphic `unreachable` frame closing
//    remain fully exact (acceptance 6/7): #1's module at a bounded size
//    validates as complete rather than silently degrading.
{
  const mod = parseWasm(typedBlockModule(2, 3));
  assert.equal(validateWasmFunctionTypes(0, mod).complete, true);
}

console.log('[phase11] issue #8946 wasm validator block-type budget regression passed');
