// Regression for #4891: the WASM lifter collapsed i32 comparison opcodes
// 0x46-0x4d onto one generic `i32.cmp` VMEffect with no predicate and no
// signedness, while still claiming `exact`; the shared bridge then produced a
// `compare` node whose only operator evidence was the raw frontend opcode.
// `0xffffffff <s 0` is true and `0xffffffff <u 0` is false, so a projection
// that cannot tell lt_s from lt_u must not be published as complete semantics.
// The predicate/signedness must be carried as a semantic VMEffect field and
// promoted to the canonical Semantic IR compare operator, and anything that
// cannot be canonicalized must fail closed instead of claiming completeness.
import assert from 'node:assert/strict';

import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { createVMEffectBundle, createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';
import { bitvector, evaluateBinary, evaluateUnary } from '../../../js/decompiler/phase8/bitvector.js';

console.log('[phase11] running WASM i32 compare predicate/signedness regression #4891...');

const I32 = 0x7f;

const COMPARE_GROUP = [
  { opcode: 0x45, mnemonic: 'i32.eqz', predicate: 'eq', signedness: null, operator: 'is-zero', arity: 1 },
  { opcode: 0x46, mnemonic: 'i32.eq', predicate: 'eq', signedness: null, operator: 'eq', arity: 2 },
  { opcode: 0x47, mnemonic: 'i32.ne', predicate: 'ne', signedness: null, operator: 'ne', arity: 2 },
  { opcode: 0x48, mnemonic: 'i32.lt_s', predicate: 'lt', signedness: 'signed', operator: 'slt', arity: 2 },
  { opcode: 0x49, mnemonic: 'i32.lt_u', predicate: 'lt', signedness: 'unsigned', operator: 'ult', arity: 2 },
  { opcode: 0x4a, mnemonic: 'i32.gt_s', predicate: 'gt', signedness: 'signed', operator: 'sgt', arity: 2 },
  { opcode: 0x4b, mnemonic: 'i32.gt_u', predicate: 'gt', signedness: 'unsigned', operator: 'ugt', arity: 2 },
  { opcode: 0x4c, mnemonic: 'i32.le_s', predicate: 'le', signedness: 'signed', operator: 'sle', arity: 2 },
  { opcode: 0x4d, mnemonic: 'i32.le_u', predicate: 'le', signedness: 'unsigned', operator: 'ule', arity: 2 },
];

const CONST_MINUS_ONE = [0x41, 0x7f];
const CONST_ZERO = [0x41, 0x00];
const CONST_ONE = [0x41, 0x01];

function syntheticModule(bytecode, types) {
  return {
    moduleId: 'wasm:issue-4891',
    imageId: 'image:issue-4891',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: [],
    types: types ?? [{ params: [I32, I32], results: [I32] }],
    functions: [0],
    tables: [],
    globals: [],
    codeBodies: [{ bodyOffset: 0, locals: [], bytecode: Uint8Array.from(bytecode) }],
    exports: [],
  };
}

function bundleFor(opcode, arity) {
  const bytecode = arity === 1
    ? [0x20, 0x00, opcode, 0x0b]
    : [0x20, 0x00, 0x20, 0x01, opcode, 0x0b];
  const types = arity === 1 ? [{ params: [I32], results: [I32] }] : undefined;
  const lifted = liftWasmFunction(0, syntheticModule(bytecode, types));
  const bundle = lifted.bundles.find((item) => item.opcode === opcode);
  assert.ok(bundle, `opcode 0x${opcode.toString(16)} must be lifted`);
  return bundle;
}
function label(opcode) {
  return `0x${opcode.toString(16)}`;
}

function wasmBytes(body) {
  const codeContent = [0x01, body.length + 1, 0x00, ...body];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x0a, codeContent.length, ...codeContent,
  ]);
}

async function lowerBytes(body) {
  const frontend = new WasmFrontend();
  const image = await frontend.open(wasmBytes(body));
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  await frontend.validateMethod(decoded, { image });
  return lowerVMEffectsToSemanticIr(decoded);
}

function handBundle(input) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    frontendSemanticVersion: '1.0.0',
    methodId: 'wasm:issue-4891:hand',
    ...input,
  });
}

function handFunction(bundles) {
  return createVMEffectFunction({
    frontendId: 'wasm',
    methodId: 'wasm:issue-4891:hand',
    bundles,
  });
}

// The raw frontend opcode is stripped so that the only operator evidence left is
// what the canonical Semantic IR compare node itself publishes.
function irContext(lowered) {
  const nodes = JSON.parse(JSON.stringify(lowered.semanticIr.nodes)).map((node) => {
    if (node.metadata) delete node.metadata.opcode;
    return node;
  });
  return { nodes, values: lowered.semanticIr.values };
}

function constantOperand(node, context, index) {
  const valueId = (node.inputs ?? [])[index];
  const value = context.values.find((item) => item.id === valueId);
  const producer = value == null ? null : context.nodes.find((item) => item.id === value.definitionNodeId);
  if (!producer || producer.kind !== 'const') return null;
  const text = producer.outputs
    .map((id) => context.values.find((item) => item.id === id))
    .map((item) => item?.metadata?.constant)
    .find((item) => item != null);
  if (text == null) return null;
  const width = value.machineType?.widthBits;
  assert.ok(Number.isSafeInteger(width) && width > 0, 'compare operand width must be published');
  return bitvector(BigInt(text), width);
}

function foldCompare(node, context) {
  assert.ok(node.operator, `compare node must publish a canonical operator, got ${JSON.stringify(node)}`);
  if ((node.inputs ?? []).length === 1) {
    return evaluateUnary(node.operator, constantOperand(node, context, 0));
  }
  const left = constantOperand(node, context, 0);
  const right = constantOperand(node, context, 1);
  assert.ok(left && right, 'binary compare operands must be published constants');
  return evaluateBinary(node.operator, left, right);
}

function compareNodes(lowered, arity) {
  const context = irContext(lowered);
  return context.nodes
    .filter((node) => node.kind === 'compare' && (node.inputs ?? []).length === arity)
    .map((node) => ({ node, context }));
}

// 1. The VMEffect keeps predicate, signedness and operand/result widths losslessly.
{
  const signatures = new Set();
  for (const entry of COMPARE_GROUP) {
    const bundle = bundleFor(entry.opcode, entry.arity);
    assert.notEqual(bundle.mnemonic, 'i32.cmp', `${label(entry.opcode)} must not collapse onto a generic cmp mnemonic`);
    assert.equal(bundle.mnemonic, entry.mnemonic, `${label(entry.opcode)} must publish its own mnemonic`);
    assert.deepEqual(
      bundle.compare,
      { predicate: entry.predicate, signedness: entry.signedness, operandBits: 32, arity: entry.arity },
      `${label(entry.opcode)} must keep predicate/signedness/operand width/arity as a semantic field`,
    );
    assert.equal(bundle.completeness, 'exact', `${label(entry.opcode)} may claim exact only because the operator is preserved`);
    assert.equal(bundle.consumedValues.length, entry.arity);
    assert.equal(bundle.producedValues.length, 1);
    assert.equal(bundle.producedValues[0].bits, 32);
    signatures.add(`${entry.predicate}/${entry.signedness}/${entry.arity}`);
  }
  assert.equal(signatures.size, COMPARE_GROUP.length, 'no two comparison opcodes may share one semantic projection');
}

// 2. lt_s and lt_u disagree on the minimal counterexample, decided by the
//    canonical Semantic IR operator alone with the raw opcode removed.
{
  const cases = [
    [0x48, 1n],
    [0x49, 0n],
    [0x4a, 0n],
    [0x4b, 1n],
    [0x4c, 1n],
    [0x4d, 0n],
    [0x46, 0n],
    [0x47, 1n],
  ];
  const operators = new Set();
  for (const [opcode, expected] of cases) {
    const entry = COMPARE_GROUP.find((item) => item.opcode === opcode);
    const lowered = await lowerBytes([...CONST_MINUS_ONE, ...CONST_ZERO, opcode, 0x0b]);
    const found = compareNodes(lowered, 2);
    assert.equal(found.length, 1, `${label(opcode)} must lower exactly one binary compare node`);
    assert.equal(found[0].node.operator, entry.operator, `${label(opcode)} must lower to operator ${entry.operator}`);
    assert.equal(found[0].node.completeness, 'complete', `${label(opcode)} preserves its operator, so complete is honest`);
    const folded = foldCompare(found[0].node, found[0].context);
    assert.equal(folded?.value, expected, `${label(opcode)} folded from the canonical operator alone`);
    assert.equal(lowered.semanticIr.completeness, 'complete');
    operators.add(found[0].node.operator);
  }
  assert.equal(operators.size, cases.length, 'every comparison opcode must reach a distinct canonical operator');
}

// 3. eq / ne on equal operands stay distinguishable.
for (const [opcode, expected] of [[0x46, 1n], [0x47, 0n]]) {
  const lowered = await lowerBytes([...CONST_ONE, ...CONST_ONE, opcode, 0x0b]);
  const found = compareNodes(lowered, 2);
  assert.equal(found.length, 1, `${label(opcode)} on equal operands`);
  assert.equal(foldCompare(found[0].node, found[0].context)?.value, expected,
    `${label(opcode)} folded from the canonical operator alone`);
}

// 4. i32.eqz keeps its unary compare semantics and stays evaluable.
for (const [constant, expected] of [[CONST_MINUS_ONE, 0n], [CONST_ZERO, 1n]]) {
  const lowered = await lowerBytes([...constant, 0x45, 0x0b]);
  const found = compareNodes(lowered, 1);
  assert.equal(found.length, 1, 'i32.eqz must stay a unary compare node');
  assert.equal(found[0].node.operator, 'is-zero');
  assert.equal(found[0].node.completeness, 'complete');
  assert.equal(foldCompare(found[0].node, found[0].context)?.value, expected);
  assert.equal(lowered.semanticIr.completeness, 'complete');
}

// 5. A malformed compare descriptor fails closed at the VMEffect boundary.
for (const [reason, compare] of [
  ['ordered-predicate-without-signedness', { predicate: 'lt', operandBits: 32, arity: 2 }],
  ['unknown-predicate', { predicate: 'near', signedness: 'signed', operandBits: 32, arity: 2 }],
  ['unknown-signedness', { predicate: 'lt', signedness: 'magnitude', operandBits: 32, arity: 2 }],
  ['arity-mismatch', { predicate: 'eq', operandBits: 32, arity: 1 }],
  ['invalid-operand-bits', { predicate: 'eq', operandBits: 0, arity: 2 }],
  ['unknown-descriptor-field', { predicate: 'eq', operandBits: 32, arity: 2, raw: 'opcode' }],
]) {
  assert.throws(
    () => handBundle({
      operationId: `op:${reason}`,
      bytecodeOffset: 0,
      opcode: 0x48,
      mnemonic: 'i32.lt_s',
      consumedValues: [{ id: 'arg_0', bits: 32 }, { id: 'arg_1', bits: 32 }],
      producedValues: [{ bits: 32 }],
      completeness: 'exact',
      compare,
    }),
    /vm-effect-/,
    `${reason} must be rejected instead of published as exact`,
  );
}

// 6. A well-formed compare whose operator the bridge cannot canonicalize must
//    not be published as complete semantics.
{
  const lowered = lowerVMEffectsToSemanticIr(handFunction([
    handBundle({
      operationId: 'op:seed',
      bytecodeOffset: 0,
      opcode: 0x41,
      mnemonic: 'i32.const',
      producedValues: [{ bits: 32, constant: -1 }],
      completeness: 'exact',
    }),
    handBundle({
      operationId: 'op:unrepresentable',
      bytecodeOffset: 1,
      opcode: 0x48,
      mnemonic: 'i32.lt_s',
      consumedValues: [{ id: 'arg_0', bits: 32 }],
      producedValues: [{ bits: 32 }],
      completeness: 'exact',
      compare: { predicate: 'lt', signedness: 'signed', operandBits: 32, arity: 1 },
    }),
  ]));
  const found = lowered.semanticIr.nodes.filter((node) => node.kind === 'compare');
  assert.equal(found.length, 1);
  assert.equal(found[0].operator, null, 'an uncanonicalizable compare must not invent an operator');
  assert.equal(found[0].completeness, 'partial');
  assert.equal(found[0].unknown?.reason, 'managed-compare-operator-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((item) => item.reason === 'managed-compare-operator-unresolved'));
}

console.log('  ok WASM i32 compare predicate/signedness regression passed');
