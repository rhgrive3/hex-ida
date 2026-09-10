// Regression for #7890: the WASM lifter publishes correct {bits, type} pairs
// where `type` is the raw Wasm value-type byte (0x7c f64, 0x7d f32, 0x7e i64,
// 0x7f i32). The shared bridge used to treat the truthy numeric byte as a
// machine-type OBJECT, lose `kind`/`widthBits`, and silently fabricate
// {kind:'bitvector', widthBits:32} — even for i64 — while publishing complete
// IR. The bridge boundary must decode frontend value-type bytes explicitly and
// fail closed (partial + unknown) for unrepresentable ones.
import assert from 'node:assert/strict';

import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running wasm bridge machine-type regression #7890...');

// (func (param i64) (result i64) local.get 0)
const I64_MODULE = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7e, 0x01, 0x7e,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b,
]);

async function lower(bytes) {
  const frontend = new WasmFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  await frontend.validateMethod(decoded, { image });
  return lowerVMEffectsToSemanticIr(decoded);
}

{
  const lowered = await lower(I64_MODULE);
  const reads = lowered.semanticIr.nodes.filter((n) => n.kind === 'state-read');
  assert.ok(reads.length > 0);
  for (const node of reads) {
    for (const outputId of node.outputs) {
      const value = lowered.semanticIr.values.find((v) => v.id === outputId);
      assert.ok(value, 'state-read output value exists');
      assert.equal(value.machineType.kind, 'bitvector');
      assert.equal(value.machineType.widthBits, 64, `i64 local.get must stay 64-bit, got ${JSON.stringify(value.machineType)}`);
    }
  }
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.equal(lowered.semanticIr.unknowns.length, 0);
}

// f64 must keep its floating-point kind, not collapse to a 32-bit bitvector.
{
  // (func (param f64) (result f64) local.get 0)
  const F64_MODULE = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x06, 0x01, 0x60, 0x01, 0x7c, 0x01, 0x7c,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b,
  ]);
  const lowered = await lower(F64_MODULE);
  const definitions = lowered.semanticIr.values.filter((v) => v.kind === 'definition');
  assert.ok(definitions.length > 0);
  const f64 = definitions.find((v) => v.machineType.kind === 'float' && v.machineType.widthBits === 64);
  assert.ok(f64, `f64 local.get must produce a float64 machine type, got ${JSON.stringify(definitions.map((v) => v.machineType))}`);
  assert.equal(lowered.semanticIr.completeness, 'complete');
}

// An unrepresentable numeric type byte must fail closed (partial + unknown)
// instead of silently publishing a fabricated 32-bit complete value.
{
  // (func (param v128) (result v128) local.get 0) — v128 (0x7b) has no
  // canonical machine-type mapping in the shared bridge.
  const V128_MODULE = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x06, 0x01, 0x60, 0x01, 0x7b, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b,
  ]);
  const lowered = await lower(V128_MODULE);
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'machine-type-unrepresentable'));
}

console.log('[phase11] wasm bridge machine-type regression #7890 passed');
