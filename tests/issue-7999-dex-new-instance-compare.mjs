// Regression for #7999: DEX `new-instance` (opcode 0x22) must never be
// lowered into a complete `compare` node by incidental mnemonic substring
// matching ("new-instance".includes("ne")). The bridge classification must
// use exact operation identity: an allocation keeps its produced managed-heap
// reference and is represented by an explicit fail-closed node, never a
// fabricated complete compare that decompiles to `0 != 0`.
import assert from 'node:assert/strict';

import { buildDex } from './phase11/fixtures/medium-dex.mjs';
import { DexFrontend } from '../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../js/managed/shared/bridge-v2.js';

console.log('[phase11] running dex new-instance compare-lowering regression #7999...');

function fixture(words) {
  return buildDex({
    fields: [],
    classNames: ['LTest;', 'LFoo;'],
    methods: [{
      classType: 'LTest;', name: 'alloc', returnType: 'V', params: [],
      flags: 9, registers: 4, ins: 0, outs: 0, words,
    }],
  });
}

const built = fixture([0x0022, 0, 0x000e]);
const typeIdx = built.layout.typesList.indexOf('LFoo;');
assert.ok(typeIdx >= 0, 'LFoo; type index resolvable');

const frontend = new DexFrontend();
const image = await frontend.open(fixture([0x0022, typeIdx, 0x000e]).bytes, { binaryId: 'dex-7999-new-instance' });
const methods = [];
for await (const method of frontend.enumerateMethods(image)) methods.push(method);
const method = methods.find((m) => m.name === 'alloc');
assert.ok(method, 'alloc method present');

const decoded = await frontend.decodeMethod(method, { image });
const validated = await frontend.validateMethod(decoded);
const lifted = await frontend.liftMethod(decoded, validated);

const bundle = lifted.bundles.find((b) => b.mnemonic === 'new-instance');
assert.ok(bundle, 'new-instance bundle present');
assert.equal(bundle.opcode, 0x22);
assert.equal(bundle.completeness, 'exact');
assert.equal(bundle.producedValues?.[0]?.classType, 'LFoo;');
assert.equal(bundle.memoryEffects?.length, 0);
assert.equal(bundle.callEffects?.length, 0);
assert.equal(bundle.controlEffects?.length, 0);

const lowered = lowerVMEffectsToSemanticIr(lifted);
const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'new-instance');
assert.ok(node, 'new-instance node present in lowered IR');
assert.notEqual(node.kind, 'compare', 'new-instance must not lower to a compare node');
assert.ok(['unary', 'intrinsic', 'barrier'].includes(node.kind), `new-instance lowers to explicit fail-closed node kind, got: ${node.kind}`);

const decompiled = decompileManagedMethod(lifted);
const compareLines = decompiled.lines.filter((line) => line.includes('!='));
assert.deepEqual(compareLines, [], `new-instance must not decompile to a fabricated compare, got: ${JSON.stringify(compareLines)}`);

console.log('[phase11] dex new-instance compare-lowering regression #7999 passed');
