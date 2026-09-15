import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { liftWasmFunction as liftWasmFunctionCore } from '../../../js/managed/wasm/lifter-core.js';

console.log('[phase11] running issue #8711 Wasm call-argument pre-admission tests...');

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d;

function uleb(value) {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
}
function section(id, payload) { return [id, ...uleb(payload.length), ...payload]; }

// The issue's shape: one multi-parameter callee, one () -> () caller whose call
// sits in stack-polymorphic unreachable code, so no real operands are required.
function hugeCalleeModule(params, { indirect = false } = {}) {
  const type0 = [0x60, ...uleb(params), ...new Array(params).fill(I32), 0x00];
  const body = [0x00, 0x00];
  if (indirect) body.push(0x41, 0x00, 0x11, 0x00, 0x00);
  else body.push(0x10, 0x00);
  body.push(0x0b);
  const parts = [
    section(1, [0x02, ...type0, 0x60, 0x00, 0x00]),
    section(2, [0x01, ...uleb(1), 0x61, ...uleb(1), 0x66, 0x00, 0x00]),
    section(3, [...uleb(1), 0x01]),
  ];
  if (indirect) parts.push(section(4, [0x01, 0x70, 0x00, 0x01]));
  parts.push(section(10, [...uleb(1), ...uleb(body.length), ...body]));
  return Uint8Array.from([...MAGIC, ...parts.flat()]);
}

// 1. Gigantic signatures are refused at parse admission, before materializing
//    or letting any downstream consumer traverse them.
assert.throws(
  () => parseWasm(hugeCalleeModule(70000)),
  /wasm-resource-limit-signature-arity/,
  'a 70,000-parameter signature must exceed the default signature arity budget',
);
assert.throws(
  () => parseWasm(hugeCalleeModule(2000), { resourceBudget: { maxSignatureArity: 512 } }),
  /wasm-resource-limit-signature-arity/,
  'the signature arity budget must be injectable',
);
assert.doesNotThrow(() => parseWasm(hugeCalleeModule(2000)), 'signatures below the cap stay admissible');

// 2/3. Value admission for `call` and `call_indirect` must precede per-argument
//    object materialization: a wide-but-admissible callee fails closed while the
//    retained heap stays essentially flat.
for (const indirect of [false, true]) {
  const label = indirect ? 'call_indirect' : 'call';
  const module = parseWasm(hugeCalleeModule(40000, { indirect }));
  const before = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  assert.throws(
    () => liftWasmFunctionCore(1, module, { budget: { maxValues: 100 } }),
    /vm-effect-resource-limit-values/,
    `${label} must fail the value budget before materializing argument records`,
  );
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(Date.now() - startedAt < 2000, `${label} admission must be immediate`);
  assert.ok(growth < 4 * 1024 * 1024, `${label} must not materialize 40,000 effect objects before failing (grew ${growth} bytes)`);
}

// 4/5/6. Within budget, unreachable stack-polymorphic calls stay valid and exact,
//        and the deterministic value boundary equals the materialized value count.
function smallCallModule() {
  const callerBody = [
    0x00,       // no locals
    0x00,       // unreachable -> stack-polymorphic operands
    0x10, 0x00, // call 0
    0x1a,       // drop the f32 result
    0x0b,
  ];
  return Uint8Array.from([
    ...MAGIC,
    ...section(1, [0x02, 0x60, 0x02, I32, I64, 0x01, F32, 0x60, 0x00, 0x00]),
    ...section(2, [0x01, ...uleb(1), 0x61, ...uleb(1), 0x66, 0x00, 0x00]),
    ...section(3, [...uleb(1), 0x01]),
    ...section(10, [
      ...uleb(1),
      ...uleb(callerBody.length), ...callerBody,
    ]),
  ]);
}
{
  const module = parseWasm(smallCallModule());
  const lifted = liftWasmFunction(1, module);
  const callBundle = lifted.bundles.find((b) => b.mnemonic === 'call');
  assert.ok(callBundle, 'unreachable code must still lift the call');
  assert.deepEqual(callBundle.consumedValues.map((v) => [v.id, v.bits, v.type]), [
    ['arg_1', 64, I64], ['arg_0', 32, I32],
  ]);
  assert.deepEqual(callBundle.producedValues.map((v) => [v.id, v.bits, v.type]), [['result_0', 32, F32]]);
  assert.equal(lifted.metadata.wasmSpecValidation, 'valid', 'stack-polymorphic unreachable calls must validate');

  const totalValues = lifted.bundles.reduce((sum, b) => sum + b.consumedValues.length + b.producedValues.length, 0);
  assert.ok(totalValues > 0);
  assert.doesNotThrow(() => liftWasmFunctionCore(1, parseWasm(smallCallModule()), { budget: { maxValues: totalValues } }));
  assert.throws(
    () => liftWasmFunctionCore(1, parseWasm(smallCallModule()), { budget: { maxValues: totalValues - 1 } }),
    /vm-effect-resource-limit-values/,
    'the deterministic boundary must match the materialized value count',
  );
}

// 7. The issue's ~3 MiB adversarial module must terminate boundedly under a
//    256 MiB heap instead of aborting the process.
{
  const parserUrl = new URL('../../../js/managed/wasm/parser.js', import.meta.url).href;
  const lifterUrl = new URL('../../../js/managed/wasm/lifter.js', import.meta.url).href;
  const source = `
import { parseWasm } from ${JSON.stringify(parserUrl)};
import { liftWasmFunction } from ${JSON.stringify(lifterUrl)};
function uleb(v){const o=[];let n=v>>>0;do{let b=n&0x7f;n=Math.floor(n/128);if(n)b|=0x80;o.push(b);}while(n);return o;}
function sec(id,p){return [id,...uleb(p.length),...p];}
const P=3000000;
const body=[0x00,0x00,0x10,0x00,0x0b];
const bytes=Uint8Array.from([0,0x61,0x73,0x6d,1,0,0,0,
  ...sec(1,[2,0x60,...uleb(P),...new Array(P).fill(0x7f),0x00,0x60,0x00,0x00]),
  ...sec(2,[1,1,0x61,1,0x66,0x00,0x00]),
  ...sec(3,[1,1]),
  ...sec(10,[1,...uleb(body.length),...body])]);
try {
  liftWasmFunction(1, parseWasm(bytes));
  console.log('UNBOUNDED');
  process.exitCode = 3;
} catch (e) {
  console.log('BOUNDED:' + e.message);
}
`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, `adversarial module must not crash the process (status ${result.status}, stderr ${String(result.stderr).slice(0, 200)})`);
  assert.match(result.stdout, /BOUNDED:(wasm-resource-limit-signature-arity|vm-effect-resource-limit-values)/);
}

console.log('[phase11] issue #8711 Wasm call-argument pre-admission tests passed');
