import assert from 'node:assert/strict';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { overlayJvmControlLowering } from '../../../js/managed/shared/bridge-jvm-control-overlay-v2.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const origin = (id) => ({ instructionIds: [`issue-8724:${id}`] });
const functionId = 'function_issue_8724';

function buildLowered() {
  const values = [];
  const nodes = [];
  const nodeIds = [];
  for (let i = 1; i <= 10; i += 1) {
    const nodeId = `node_${i}`;
    nodeIds.push(nodeId);
    if (i === 10) {
      nodes.push({
        id: nodeId,
        kind: 'conditional-branch',
        blockId: 'entry',
        inputs: ['value_9'],
        outputs: [],
        targets: ['taken', 'fallthrough'],
        sourceEffectIds: ['effect-branch'],
        origin: origin(nodeId),
      });
      continue;
    }
    const valueId = `value_${i}`;
    values.push({
      id: valueId,
      kind: 'definition',
      machineType: { kind: 'bitvector', widthBits: 32 },
      definitionNodeId: nodeId,
      origin: origin(valueId),
    });
    nodes.push({
      id: nodeId,
      kind: 'const',
      blockId: 'entry',
      inputs: [],
      outputs: [valueId],
      attributes: { value: i, widthBits: 32 },
      origin: origin(nodeId),
    });
  }

  const semanticIr = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [
      { id: 'entry', nodeIds, origin: origin('entry') },
      { id: 'taken', nodeIds: [], origin: origin('taken') },
      { id: 'fallthrough', nodeIds: [], origin: origin('fallthrough') },
    ],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [
      {
        id: 'entry',
        successors: [
          { to: 'taken', kind: 'conditional-true' },
          { to: 'fallthrough', kind: 'conditional-false' },
        ],
      },
      { id: 'taken', successors: [] },
      { id: 'fallthrough', successors: [] },
    ],
  });
  return {
    semanticIr,
    cfg,
    ssa: null,
  };
}

const lowered = buildLowered();
const fn = {
  frontendId: 'jvm',
  bundles: [{
    operationId: 'effect-branch',
    controlEffects: [{
      kind: 'conditional-branch',
      condition: {
        kind: 'integer-comparison',
        predicate: 'eq',
        signed: true,
        widthBits: 32,
        arity: 1,
        compareToZero: true,
      },
    }],
  }],
};

const result = overlayJvmControlLowering(fn, lowered);
const entry = result.semanticIr.blocks.find((block) => block.id === 'entry');
assert.deepEqual(entry.nodeIds, [
  'node_1', 'node_2', 'node_3', 'node_4', 'node_5',
  'node_6', 'node_7', 'node_8', 'node_9',
  'node_10:jvm-zero', 'node_10:jvm-condition', 'node_10',
]);

const compare = result.semanticIr.nodes.find((node) => node.id === 'node_10:jvm-condition');
assert.deepEqual(compare.inputs, ['value_9', 'node_10:jvm-zero:value']);
assert.equal(result.semanticIr.nodes.find((node) => node.id === 'node_10').inputs[0], 'node_10:jvm-condition:value');

// The old implementation rebuilt block order from globally sorted node IDs.
// Crossing node_9 -> node_10 then put the definition after its use. The
// current snapshot's validator predates the stricter ordering check, so assert
// the exact bad order directly as the pre-fix witness.
const globallyReordered = result.semanticIr.nodes
  .filter((node) => node.blockId === 'entry')
  .map((node) => node.id);
assert.deepEqual(globallyReordered.slice(0, 4), [
  'node_1', 'node_10', 'node_10:jvm-condition', 'node_10:jvm-zero',
]);
assert.ok(globallyReordered.indexOf('node_10') < globallyReordered.indexOf('node_9'));
assert.ok(entry.nodeIds.indexOf('node_9') < entry.nodeIds.indexOf('node_10:jvm-condition'));

function buildJvmBranchClass(pairCount) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  bytes.set([0xca, 0xfe, 0xba, 0xbe]);
  view.setUint16(4, 0, false);
  view.setUint16(6, 61, false);
  view.setUint16(8, 8, false);
  let offset = 10;
  const addUtf8 = (text) => {
    const encoded = new TextEncoder().encode(text);
    bytes[offset++] = 1;
    view.setUint16(offset, encoded.length, false);
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  };
  addUtf8('TestClass');
  bytes[offset++] = 7;
  view.setUint16(offset, 1, false);
  offset += 2;
  addUtf8('testMethod');
  addUtf8('()V');
  addUtf8('Code');
  // #8759 sync: `super_class = 0` is reserved for java/lang/Object itself; the
  // current JVM parser fails closed with jvm-invalid-zero-super-class. Give the
  // fixture a real superclass entry so the control-overlay ordering contract
  // under test is actually exercised.
  addUtf8('java/lang/Object');   // cp #6
  bytes[offset++] = 7;           // cp #7: Class -> #6
  view.setUint16(offset, 6, false);
  offset += 2;
  view.setUint16(offset, 1, false); offset += 2;
  view.setUint16(offset, 2, false); offset += 2;
  view.setUint16(offset, 7, false); offset += 2;
  view.setUint16(offset, 0, false); offset += 2;
  view.setUint16(offset, 0, false); offset += 2;
  view.setUint16(offset, 1, false); offset += 2;
  view.setUint16(offset, 0x0009, false); offset += 2;
  view.setUint16(offset, 3, false); offset += 2;
  view.setUint16(offset, 4, false); offset += 2;
  view.setUint16(offset, 1, false); offset += 2;
  const code = Uint8Array.from([
    // #8759 sync: each `ifge` must branch to a distinct reachable instruction
    // start (a taken target equal to the fall-through is rejected as
    // semantic-ir-control-target-cardinality). Each five-byte pair loads,
    // branches forward to the next pair's `iload_0`, and falls through a nop.
    ...Array.from({ length: pairCount }, () => [0x03, 0x99, 0x00, 0x04, 0x00]).flat(),
    0xb1,
  ]);
  view.setUint16(offset, 5, false); offset += 2;
  view.setUint32(offset, 12 + code.length, false); offset += 4;
  view.setUint16(offset, 1, false); offset += 2;
  view.setUint16(offset, 0, false); offset += 2;
  view.setUint32(offset, code.length, false); offset += 4;
  bytes.set(code, offset); offset += code.length;
  view.setUint16(offset, 0, false); offset += 2;
  view.setUint16(offset, 0, false); offset += 2;
  view.setUint16(offset, 0, false); offset += 2;
  return bytes.subarray(0, offset);
}

for (const pairCount of [4, 5]) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(buildJvmBranchClass(pairCount), {
    binaryId: `issue-8724-${pairCount}`,
  });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  assert.notEqual(validation.status, 'invalid');
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const branches = lowered.semanticIr.nodes.filter((node) => node.kind === 'conditional-branch');
  assert.equal(branches.length, pairCount);
  for (const branch of branches) {
    const block = lowered.semanticIr.blocks.find((candidate) => candidate.id === branch.blockId);
    const branchIndex = block.nodeIds.indexOf(branch.id);
    const compareIndex = block.nodeIds.indexOf(`${branch.id}:jvm-condition`);
    assert.ok(compareIndex >= 0 && compareIndex < branchIndex);
  }
}

console.log('ok issue-8724 JVM overlay preserves intra-block execution order on direct and production paths');