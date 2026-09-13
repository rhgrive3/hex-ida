import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { lowerVMEffectsToSemanticIr as lowerCore } from '../../../js/managed/shared/bridge-lowering-v2.js';
import { overlayWasmNarrowLoadExtensions } from '../../../js/managed/shared/bridge-wasm-narrow-load-overlay-v2.js';

const loadCount = 5000;
const bytecode = new Uint8Array(loadCount * 6 + 1);
for (let index = 0; index < loadCount; index++) {
  bytecode.set([0x41, 0x00, 0x2c, 0x00, 0x00, 0x1a], index * 6);
}
bytecode[bytecode.length - 1] = 0x0b;
const effects = liftWasmFunction(0, {
  moduleId: 'wasm:issue-4877:work', imageId: 'image:issue-4877:work',
  formatVersion: '1', vmSpecEdition: 'core-3.0',
  imports: [], types: [{ params: [], results: [] }], functions: [0],
  tables: [], globals: [], exports: [],
  memories: [{ min: 1, max: null, shared: false, flags: 0, addressType: 'i32', indexType: 'i32' }],
  codeBodies: [{ bodyOffset: 0, locals: [], bytecode }],
});
assert.ok(effects.bundles.length < 16384, 'fixture fits the default VM-effect operation budget');
const lowered = lowerCore(effects);
const nodeCount = lowered.semanticIr.nodes.length;

function observedNodes(maximum = 16 * (nodeCount + loadCount)) {
  let reads = 0;
  const nodes = lowered.semanticIr.nodes.map((node) => ({
    ...node,
    get kind() {
      reads++;
      assert.ok(reads <= maximum, 'overlay must stay within a linear node-probe bound');
      return node.kind;
    },
  }));
  return {
    lowered: { ...lowered, semanticIr: { ...lowered.semanticIr, nodes } },
    get reads() { return reads; },
  };
}

{
  const observed = observedNodes();
  const out = overlayWasmNarrowLoadExtensions(effects, observed.lowered, {
    budget: { maxWorkItems: 32 * (nodeCount + lowered.semanticIr.values.length + loadCount) },
  });
  const extensions = new Map(out.semanticIr.nodes.filter((node) => node.kind === 'sext').map((node) => [node.inputs[0], node]));
  assert.equal(extensions.size, loadCount);
  const byId = new Map(out.semanticIr.nodes.map((node) => [node.id, node]));
  let adjacent = 0;
  for (const block of out.semanticIr.blocks) {
    for (let index = 0; index < block.nodeIds.length; index++) {
      const node = byId.get(block.nodeIds[index]);
      if (node.kind !== 'load') continue;
      assert.equal(block.nodeIds[index + 1], extensions.get(node.outputs[0]).id);
      adjacent++;
    }
  }
  assert.equal(adjacent, loadCount, 'every extension immediately follows its load in block order');
}

{
  const observed = observedNodes();
  assert.throws(() => overlayWasmNarrowLoadExtensions(effects, observed.lowered, {
    budget: { maxWorkItems: effects.bundles.length + 2 },
  }), /managed-wasm-narrow-load-budget-exceeded-maxWorkItems/);
  assert.ok(observed.reads <= 2, 'tight work budget stops indexing before scanning the function');
}

{
  const observed = observedNodes();
  assert.throws(() => overlayWasmNarrowLoadExtensions(effects, observed.lowered, {
    signal: { get aborted() { return observed.reads >= 3; } },
  }), (error) => error.name === 'AbortError');
  assert.equal(observed.reads, 3, 'cancellation is checked during matching, before canonical rebuilding');
}

{
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => overlayWasmNarrowLoadExtensions({
    frontendId: 'wasm',
    get bundles() { assert.fail('cancelled work must not enumerate bundles'); },
  }, lowered, { signal: controller.signal }), (error) => error.name === 'AbortError');
  for (const maxWorkItems of [0, -1, '100', NaN, Infinity]) {
    assert.throws(() => overlayWasmNarrowLoadExtensions(effects, lowered, {
      budget: { maxWorkItems },
    }), /managed-wasm-narrow-load-invalid-budget-maxWorkItems/);
  }
}

{
  const load = lowered.semanticIr.nodes.find((node) => node.kind === 'load');
  const duplicate = { ...load, id: `${load.id}:duplicate` };
  assert.throws(() => overlayWasmNarrowLoadExtensions(effects, {
    ...lowered, semanticIr: { ...lowered.semanticIr, nodes: [...lowered.semanticIr.nodes, duplicate] },
  }), /managed-wasm-narrow-load-semantic-node-mismatch/);
  assert.throws(() => overlayWasmNarrowLoadExtensions(effects, {
    ...lowered, semanticIr: { ...lowered.semanticIr, nodes: lowered.semanticIr.nodes.filter((node) => node !== load) },
  }), /managed-wasm-narrow-load-semantic-node-mismatch/);
}

console.log('[phase11] WASM narrow-load linear work, budget, cancellation and matching regressions passed (5000 loads).');
