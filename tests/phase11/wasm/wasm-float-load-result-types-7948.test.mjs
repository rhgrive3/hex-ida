import assert from 'node:assert/strict';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running WASM full-width load result-type regression for #7948...');

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, payload) => [id, payload.length, ...payload];

function loadFixture(opcode, align) {
  const type = section(1, [0x01, 0x60, 0x00, 0x00]);
  const func = section(3, [0x01, 0x00]);
  const memory = section(5, [0x01, 0x00, 0x01]);
  const body = [0x00, 0x41, 0x00, opcode, align, 0x00, 0x1a, 0x0b];
  const code = section(10, [0x01, body.length, ...body]);
  return Uint8Array.from([...HEADER, ...type, ...func, ...memory, ...code]);
}

async function decodeLoad({ opcode, align, mnemonic }) {
  const bytes = loadFixture(opcode, align);
  assert.equal(WebAssembly.validate(bytes), true, `${mnemonic}: fixture must be valid WebAssembly`);

  const frontend = new WasmFrontend();
  const image = await frontend.open(bytes, { binaryId: `issue-7948-${mnemonic}` });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  assert.equal(methods.length, 1, `${mnemonic}: exactly one production method must be enumerable`);

  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const bundle = decoded.bundles.find((candidate) => candidate.mnemonic === mnemonic);
  assert.ok(bundle, `${mnemonic}: production frontend must emit the load bundle`);

  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === mnemonic);
  assert.ok(node, `${mnemonic}: shared Semantic IR must retain the load node`);
  const output = lowered.semanticIr.values.find((value) => node.outputs.includes(value.id));
  assert.ok(output, `${mnemonic}: load output must have a canonical Semantic IR value`);

  return { decoded, validation, bundle, lowered, node, output };
}

const cases = [
  { opcode: 0x28, align: 2, mnemonic: 'i32.load', byteWidth: 4, machineType: { kind: 'bitvector', widthBits: 32 } },
  { opcode: 0x29, align: 3, mnemonic: 'i64.load', byteWidth: 8, machineType: { kind: 'bitvector', widthBits: 64 } },
  { opcode: 0x2a, align: 2, mnemonic: 'f32.load', byteWidth: 4, machineType: { kind: 'float', widthBits: 32, format: 'binary32' } },
  { opcode: 0x2b, align: 3, mnemonic: 'f64.load', byteWidth: 8, machineType: { kind: 'float', widthBits: 64, format: 'binary64' } },
];

const results = new Map();
for (const entry of cases) {
  const result = await decodeLoad(entry);
  results.set(entry.mnemonic, result);

  assert.equal(result.bundle.completeness, 'exact');
  assert.equal(result.decoded.aggregateCompleteness, 'exact');
  assert.equal(result.validation.completeness.semanticEffect, 'complete');
  assert.deepEqual(result.output.machineType, entry.machineType, `${entry.mnemonic}: canonical result type must preserve Wasm value kind and width`);
  assert.equal(result.bundle.consumedValues[0]?.bits, 32, `${entry.mnemonic}: memory32 address width must remain 32-bit`);
  assert.deepEqual(result.bundle.memoryEffects[0], {
    space: 'linear-memory', memoryIndex: 0, byteWidth: entry.byteWidth, offset: 0, align: entry.align, isWrite: false,
  }, `${entry.mnemonic}: existing memory width/alignment provenance must remain exact`);
  assert.deepEqual(result.bundle.possibleExceptions, [{
    kind: 'linear-memory-oob', memoryIndex: 0, condition: `effectiveAddress+${entry.byteWidth}>memorySize`,
  }], `${entry.mnemonic}: OOB trap authority must be preserved`);
  assert.equal(result.node.memory.widthBits, entry.byteWidth * 8);
  assert.deepEqual(result.node.metadata.possibleExceptions, result.bundle.possibleExceptions);
  assert.equal(result.lowered.semanticIr.completeness, 'complete');
  assert.deepEqual(result.lowered.semanticIr.unknowns, []);
}

assert.notDeepEqual(
  results.get('i32.load').output.machineType,
  results.get('f32.load').output.machineType,
  'same-width integer and floating loads must remain semantically distinguishable without opcode re-decoding',
);
assert.notDeepEqual(
  results.get('i64.load').output.machineType,
  results.get('f64.load').output.machineType,
  '64-bit integer and floating loads must remain semantically distinguishable without opcode re-decoding',
);

assert.equal(results.get('i32.load').bundle.producedValues[0]?.type, undefined,
  'integer loads must not gain a new producer type contract as a side effect of the float fix');
assert.equal(results.get('i64.load').bundle.producedValues[0]?.type, undefined,
  '64-bit integer loads must retain their existing producer shape');

assert.deepEqual(results.get('f32.load').bundle.producedValues[0]?.type, {
  kind: 'float', widthBits: 32, format: 'binary32',
}, 'f32.load must publish float authority at the VMEffect producer boundary');
assert.deepEqual(results.get('f64.load').bundle.producedValues[0]?.type, {
  kind: 'float', widthBits: 64, format: 'binary64',
}, 'f64.load must publish float authority at the VMEffect producer boundary');

console.log('  ok WASM full-width load result-type regression #7948 passed');
