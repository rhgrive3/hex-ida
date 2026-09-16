import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #8924 — the CIL frontend resolves `float32`/`float64` field signatures into
// VMEffect values that already state their IEEE-754 authority
// (`stackType:'float'` + `primitive:'r4'/'r8'`), but the lifter dropped that
// authority at the VMEffect→Semantic-IR boundary: a float load and any
// `add`/`sub`/`mul`/`div`/`neg` over it were published as a bare width
// bitvector with `complete` integer semantics, so a normal .NET float
// computation became authoritatively wrong with no partial/unknown signal.
// The fix carries the proven machine type at the first projection (the same
// remedy #7971/#8955 apply to the JVM/field float family). A width/kind the
// source cannot prove still fails closed, and integer/shift operations are
// untouched.

const R4 = [0x06, 0x0c];
const R8 = [0x06, 0x0d];
const I4 = [0x06, 0x08];
const RET4 = [0x00, 0x00, 0x0c];
const FLOAT32 = { kind: 'float', widthBits: 32, format: 'binary32' };
const FLOAT64 = { kind: 'float', widthBits: 64, format: 'binary64' };
const BIT32 = { kind: 'bitvector', widthBits: 32 };
const BIT64 = { kind: 'bitvector', widthBits: 64 };

// Field table token (0x04) for the Nth (1-based) Field row.
const fieldToken = (rid) => [rid & 0xff, (rid >>> 8) & 0xff, (rid >>> 16) & 0xff, 0x04];
const ldsfld = (rid) => [0x7e, ...fieldToken(rid)];

function project(fields, body) {
  const built = buildCil({
    types: [{ name: 'T', namespace: 'N', methodList: 1, fieldList: 1 }],
    fields,
    methods: [{ name: 'M', body, signature: RET4, flags: 0x0016 }],
  });
  const lifted = liftCilMethod(0, parseCil(built.bytes));
  const lowered = lowerVMEffectsToSemanticIr(lifted);
  return { lifted, lowered };
}

const bundleAt = (lifted, mnemonic) => lifted.bundles.find((b) => b.mnemonic === mnemonic);
const resultMachineType = (lowered, kind) => {
  const node = lowered.semanticIr.nodes.find((n) => n.kind === kind);
  assert.ok(node, `expected a ${kind} node`);
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));
  assert.ok(value, `expected an output value for the ${kind} node`);
  return value.machineType;
};

test('#8924 a float field load carries canonical IEEE-754 machine type through the bridge', () => {
  const { lifted, lowered } = project([{ name: 'a', flags: 0x0016, signature: R4 }], [...ldsfld(1), 0x2a]);
  assert.deepEqual(bundleAt(lifted, 'ldsfld').producedValues[0].type, FLOAT32);
  assert.deepEqual(resultMachineType(lowered, 'load'), FLOAT32);
});

test('#8924 r4 + r4 keeps float32 authority instead of collapsing to integer', () => {
  const { lifted, lowered } = project(
    [{ name: 'a', flags: 0x0016, signature: R4 }, { name: 'b', flags: 0x0016, signature: R4 }],
    [...ldsfld(1), ...ldsfld(2), 0x58, 0x2a],
  );
  assert.deepEqual(bundleAt(lifted, 'add').producedValues[0].type, FLOAT32);
  assert.deepEqual(resultMachineType(lowered, 'binary'), FLOAT32);
});

test('#8924 r8 - r8 and r8 * r8 keep float64 authority', () => {
  for (const [opcode, name] of [[0x59, 'sub'], [0x5a, 'mul']]) {
    const { lifted, lowered } = project(
      [{ name: 'a', flags: 0x0016, signature: R8 }, { name: 'b', flags: 0x0016, signature: R8 }],
      [...ldsfld(1), ...ldsfld(2), opcode, 0x2a],
    );
    assert.equal(bundleAt(lifted, name).mnemonic, name);
    assert.deepEqual(bundleAt(lifted, name).producedValues[0].type, FLOAT64);
    assert.deepEqual(resultMachineType(lowered, 'binary'), FLOAT64);
  }
});

test('#8924 neg of an r8 value keeps float64 authority', () => {
  const { lifted, lowered } = project(
    [{ name: 'a', flags: 0x0016, signature: R8 }],
    [...ldsfld(1), 0x65, 0x2a],
  );
  assert.deepEqual(bundleAt(lifted, 'neg').producedValues[0].type, FLOAT64);
  assert.deepEqual(resultMachineType(lowered, 'unary'), FLOAT64);
});

test('#8924 integer arithmetic is unchanged (still a width bitvector)', () => {
  const { lifted, lowered } = project(
    [{ name: 'a', flags: 0x0016, signature: I4 }, { name: 'b', flags: 0x0016, signature: I4 }],
    [...ldsfld(1), ...ldsfld(2), 0x58, 0x2a],
  );
  assert.equal(bundleAt(lifted, 'add').producedValues[0].type, undefined);
  assert.deepEqual(resultMachineType(lowered, 'binary'), BIT32);
});

test('#8924 `not` and shifts are integer-only: a float operand never becomes float arithmetic', () => {
  // shl is not a floating operation; the result must not claim float authority.
  const { lifted } = project(
    [{ name: 'a', flags: 0x0016, signature: R4 }, { name: 'b', flags: 0x0016, signature: I4 }],
    [...ldsfld(1), ...ldsfld(2), 0x62, 0x2a],
  );
  assert.equal(bundleAt(lifted, 'shl').producedValues[0].type, undefined);
  // `not` on an r4 value is not a floating operation either.
  const neg = project([{ name: 'a', flags: 0x0016, signature: R4 }], [...ldsfld(1), 0x66, 0x2a]);
  assert.equal(bundleAt(neg.lifted, 'not').producedValues[0].type, undefined);
});

test('#8924 mismatched float widths never mint a float result (fail closed)', () => {
  const { lifted } = project(
    [{ name: 'a', flags: 0x0016, signature: R4 }, { name: 'b', flags: 0x0016, signature: R8 }],
    [...ldsfld(1), ...ldsfld(2), 0x58, 0x2a],
  );
  const add = bundleAt(lifted, 'add');
  assert.equal(add.completeness, 'partial');
  assert.equal(add.producedValues[0].type, undefined);
  assert.ok(add.unknownEffects.some((e) => e.reason === 'cil-arithmetic-operand-width-unresolved'));
});

test('#8924 a float value whose authority is stripped still fails closed (no silent bitvector)', () => {
  const { lifted } = project([{ name: 'a', flags: 0x0016, signature: R4 }], [...ldsfld(1), 0x2a]);
  const bundles = lifted.bundles.map((b) => (b.mnemonic === 'ldsfld'
    ? { ...b, producedValues: b.producedValues.map(({ type, ...rest }) => rest) }
    : b));
  const lowered = lowerVMEffectsToSemanticIr({ ...lifted, bundles });
  const load = lowered.semanticIr.nodes.find((n) => n.kind === 'load');
  const value = lowered.semanticIr.values.find((v) => load.outputs.includes(v.id));
  // Without the canonical type the width fallback yields a bitvector, and the
  // function is not published as a complete float computation.
  assert.equal(value.machineType.kind, 'bitvector');
});
