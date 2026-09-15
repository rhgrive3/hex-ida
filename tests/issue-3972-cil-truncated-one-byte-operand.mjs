// Regression for #3972: one-byte operands must be read through the checked
// decoder boundary. A truncated `ldc.i4.s`/`ldarg.s`/`ldloc.s`/`stloc.s`/
// short branch/`leave.s` must fail closed with the typed
// `cil-truncated-operand` error instead of laundering `bytecode[pc++] ===
// undefined` into an exact-looking effect.
import assert from 'node:assert/strict';

import { parseCil } from '../js/managed/cil/parser.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

console.log('[phase11] running cil truncated one-byte operand regression #3972...');

const RET = 0x2a;

function fixture(body) {
  return buildCil({
    methods: [{ name: 'TruncatedOperand', body, flags: 0x0006, signature: [0x20, 0x00, 0x01] }],
  }).bytes;
}

function liftTruncated(body) {
  assert.throws(
    () => liftCilMethod(0, parseCil(fixture(body))),
    (error) => error instanceof TypeError && error.message === 'cil-truncated-operand',
    `truncated operand must fail closed: 0x${body[0].toString(16)}`,
  );
}

liftTruncated([0x1f]);                       // ldc.i4.s, immediate missing
liftTruncated([0x0e]);                       // ldarg.s, index missing
liftTruncated([0x11]);                       // ldloc.s, index missing
liftTruncated([0x13]);                       // stloc.s, index missing
liftTruncated([0x2d]);                       // brtrue.s, displacement missing
liftTruncated([0x2c]);                       // brfalse.s, displacement missing
liftTruncated([0xde]);                       // leave.s, displacement missing
liftTruncated([RET, 0x1f]);                  // missing operand after a valid op

// Valid one-byte operands keep publishing their exact effects (#3972 AC 6).
{
  const effects = liftCilMethod(0, parseCil(fixture([0x1f, 0x2a, RET])));
  const bundle = effects.bundles.find((b) => b.mnemonic === 'ldc.i4.s');
  assert.ok(bundle, 'ldc.i4.s bundle present');
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [{ bits: 32, constant: 42 }]);
}
{
  const effects = liftCilMethod(0, parseCil(fixture([0x2b, 0x01, RET, RET])));
  const bundle = effects.bundles.find((b) => b.mnemonic === 'br.s');
  assert.ok(bundle, 'br.s bundle present');
  assert.equal(bundle.completeness, 'exact');
  const last = bundle.origin.byteRanges[bundle.origin.byteRanges.length - 1];
  assert.equal(last.end - last.start, 2, 'origin covers opcode + operand only');
}

console.log('[phase11] cil truncated one-byte operand regression #3972 passed');
