import assert from 'node:assert/strict';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running WASM call_indirect runtime-trap semantics regression for #7931...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];

function definedTableFixture(targetType = 0, { tableMin = 1, element = true } = {}) {
  const types = section(1, [
    0x02,
    0x60, 0x00, 0x00,       // type 0: () -> ()
    0x60, 0x00, 0x01, 0x7f, // type 1: () -> i32
  ]);
  const functions = section(3, [0x02, targetType, 0x00]);
  const table = section(4, [0x01, 0x70, 0x00, tableMin]);
  const exports = section(7, [0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01]);
  const elements = element
    ? section(9, [0x01, 0x00, 0x41, 0x00, 0x0b, 0x01, 0x00])
    : [];
  const targetBody = targetType === 0
    ? [0x00, 0x0b]
    : [0x00, 0x41, 0x07, 0x0b];
  const runBody = [0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x0b];
  const code = section(10, [
    0x02,
    targetBody.length, ...targetBody,
    runBody.length, ...runBody,
  ]);
  return Uint8Array.from([
    ...HEADER,
    ...types,
    ...functions,
    ...table,
    ...exports,
    ...elements,
    ...code,
  ]);
}

function importedTableFixture() {
  const types = section(1, [0x01, 0x60, 0x00, 0x00]);
  const imports = section(2, [
    0x01,
    0x03, 0x65, 0x6e, 0x76, // "env"
    0x01, 0x74,             // "t"
    0x01,                   // table import
    0x70, 0x00, 0x01,       // funcref, min=1
  ]);
  const functions = section(3, [0x01, 0x00]);
  const exports = section(7, [0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00]);
  const runBody = [0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x0b];
  const code = section(10, [0x01, runBody.length, ...runBody]);
  return Uint8Array.from([...HEADER, ...types, ...imports, ...functions, ...exports, ...code]);
}

async function decodeRun(bytes, binaryId) {
  assert.equal(WebAssembly.validate(bytes), true, `${binaryId}: fixture must be valid WebAssembly`);
  const frontend = new WasmFrontend();
  const image = await frontend.open(bytes, { binaryId });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((candidate) => candidate.name === 'run');
  assert.ok(method, `${binaryId}: exported run method must be enumerable`);
  const decoded = await frontend.decodeMethod(method, { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const bundle = decoded.bundles.find((candidate) => candidate.mnemonic === 'call_indirect');
  assert.ok(bundle, `${binaryId}: call_indirect bundle must be present`);
  return { decoded, validation, bundle };
}

function assertIntrinsicTrapAuthority(bundle, label) {
  assert.deepEqual(
    bundle.possibleExceptions.map((entry) => entry.kind),
    [
      'indirect-call-table-oob',
      'indirect-call-null-target',
      'indirect-call-type-mismatch',
    ],
    `${label}: call_indirect must preserve the ordered spec-defined runtime checks`,
  );
  const byKind = new Map(bundle.possibleExceptions.map((entry) => [entry.kind, entry]));
  assert.deepEqual(
    byKind.get('indirect-call-table-oob'),
    { kind: 'indirect-call-table-oob', tableIndex: 0, condition: 'u32(selector)>=tableSize' },
  );
  assert.deepEqual(
    byKind.get('indirect-call-null-target'),
    { kind: 'indirect-call-null-target', tableIndex: 0, condition: 'selectedElement==null' },
  );
  assert.deepEqual(
    byKind.get('indirect-call-type-mismatch'),
    {
      kind: 'indirect-call-type-mismatch',
      tableIndex: 0,
      typeIndex: 0,
      condition: 'selectedFunctionType!=declaredType',
    },
  );
  assert.equal(bundle.callEffects.length, 1, `${label}: normal indirect-call effect must remain represented`);
  assert.equal(bundle.callEffects[0].dispatchKind, 'indirect');
  assert.equal(bundle.callEffects[0].unresolved, true);
  assert.equal(
    bundle.controlEffects.some((effect) => effect.kind === 'trap'),
    false,
    `${label}: conditional call_indirect traps must not be fabricated as unconditional trap control`,
  );
}

const matching = definedTableFixture(0);
assert.doesNotThrow(
  () => new WebAssembly.Instance(new WebAssembly.Module(matching)).exports.run(),
  'initialized table + matching dynamic function type must retain the normal call path',
);
const matchingDecoded = await decodeRun(matching, 'call-indirect-matching');
assertIntrinsicTrapAuthority(matchingDecoded.bundle, 'matching table');
assert.equal(matchingDecoded.bundle.completeness, 'exact');
assert.equal(matchingDecoded.decoded.aggregateCompleteness, 'exact');
assert.equal(matchingDecoded.validation.completeness.semanticEffect, 'complete');

for (const [name, bytes] of [
  ['null-target', definedTableFixture(0, { element: false })],
  ['table-oob', definedTableFixture(0, { tableMin: 0, element: false })],
  ['type-mismatch', definedTableFixture(1)],
]) {
  assert.throws(
    () => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.run(),
    WebAssembly.RuntimeError,
    `${name}: native runtime oracle must exercise a call_indirect trap`,
  );
  const result = await decodeRun(bytes, `call-indirect-${name}`);
  assertIntrinsicTrapAuthority(result.bundle, name);
}

const imported = await decodeRun(importedTableFixture(), 'call-indirect-imported-table');
assertIntrinsicTrapAuthority(imported.bundle, 'imported table');


const nonzeroProvenance = liftWasmFunction(0, {
  moduleId: 'wasm:issue-7931-nonzero',
  imageId: 'image:issue-7931-nonzero',
  formatVersion: 1,
  vmSpecEdition: 'core-3.0',
  imports: [],
  types: [
    { params: [], results: [] },
    { params: [], results: [0x7f] },
  ],
  functions: [0],
  tables: [{ elemType: 0x70 }, { elemType: 0x70 }],
  globals: [],
  codeBodies: [{
    bodyOffset: 0,
    locals: [],
    bytecode: Uint8Array.from([0x41, 0x00, 0x11, 0x01, 0x01, 0x1a, 0x0b]),
  }],
  exports: [],
});
const nonzeroBundle = nonzeroProvenance.bundles.find((candidate) => candidate.mnemonic === 'call_indirect');
assert.ok(nonzeroBundle, 'nonzero table/type indices must still produce call_indirect');
assert.equal(nonzeroBundle.callEffects[0].tableIndex, 1);
assert.equal(nonzeroBundle.callEffects[0].typeIndex, 1);
assert.ok(nonzeroBundle.possibleExceptions.every((entry) => entry.tableIndex === 1));
assert.equal(
  nonzeroBundle.possibleExceptions.find((entry) => entry.kind === 'indirect-call-type-mismatch')?.typeIndex,
  1,
  'trap provenance must carry the declared type index rather than assuming table/type zero',
);

const lowered = lowerVMEffectsToSemanticIr(matchingDecoded.decoded);
const callNode = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'call_indirect');
assert.ok(callNode, 'shared Semantic IR must retain the call_indirect node');
assert.deepEqual(
  callNode.metadata.possibleExceptions,
  matchingDecoded.bundle.possibleExceptions,
  'shared bridge must preserve specific call_indirect trap provenance instead of replacing it with generic call uncertainty',
);
assert.equal(callNode.kind, 'call');
assert.equal(callNode.completeness, 'partial', 'unresolved indirect callee effects remain conservatively partial');

console.log('  ok WASM call_indirect runtime-trap semantics regression #7931 passed');
