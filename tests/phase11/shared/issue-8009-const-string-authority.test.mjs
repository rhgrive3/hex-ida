import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8009: the DEX frontend resolves the encoded string index to the real
// literal and publishes it as `producedValues[].stringRef` with the managed
// heap reference type — but the shared bridge dropped every produced-value
// payload except numeric `constant`. Two valid methods differing only in the
// literal collapsed to the same complete Semantic IR and decompiled as `= 0`.

function make(literal) {
  const method = {
    classType: 'LTest;',
    name: 'm',
    returnType: 'Ljava/lang/String;',
    params: [],
    flags: 9,
    registers: 1,
    words: [0x001a, 0, 0x0011], // const-string v0, string@idx; return-object v0
  };

  const seed = buildDex({ strings: [literal], methods: [method] });
  const idx = seed.layout.stringsList.indexOf(literal);
  if (idx < 0) throw new Error('literal index missing');

  return buildDex({
    strings: [literal],
    methods: [{ ...method, words: [0x001a, idx, 0x0011] }],
  }).bytes;
}

async function run(literal) {
  const frontend = new DexFrontend();
  const image = await frontend.open(make(literal), { binaryId: 'same' });
  const methods = [];
  for await (const m of frontend.enumerateMethods(image)) methods.push(m);

  const decoded = await frontend.decodeMethod(
    methods.find((m) => m.name === 'm'),
    { image },
  );
  const validation = await frontend.validateMethod(decoded, { image });
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'const-string');
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const node = lowered.semanticIr.nodes.find(
    (n) => n.metadata?.mnemonic === 'const-string',
  );
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));

  return {
    bundleStringRef: bundle.producedValues[0].stringRef,
    validationSemanticEffect: validation.completeness.semanticEffect,
    functionCompleteness: lowered.semanticIr.completeness,
    unknowns: lowered.semanticIr.unknowns,
    nodeKind: node.kind,
    nodeInputs: node.inputs,
    nodeCompleteness: node.completeness,
    valueMetadata: value.metadata ?? null,
    valueMachineType: value.machineType,
    pseudocode: decompileManagedMethod(lowered).pseudocode,
  };
}

test('#8009 a DEX const-string preserves the resolved literal through the bridge', async () => {
  const a = await run('A');
  const b = await run('B');

  assert.equal(a.bundleStringRef, 'A');
  assert.equal(b.bundleStringRef, 'B');

  // The literal must survive the canonical Semantic IR boundary.
  assert.equal(a.valueMetadata?.stringRef, 'A');
  assert.equal(b.valueMetadata?.stringRef, 'B');

  // Distinct programs must not collapse to identical complete IR.
  assert.notDeepEqual(
    { ...a, pseudocode: undefined },
    { ...b, pseudocode: undefined },
    'the resolved string identity must reach the published projection',
  );

  // The heap reference type is retained; semantics stay complete.
  assert.equal(a.valueMachineType?.addressSpace, 'managed-heap');
  assert.equal(a.functionCompleteness, 'complete');
  assert.deepEqual(a.unknowns, []);
  assert.equal(a.nodeKind, 'const');
  assert.deepEqual(a.nodeInputs, []);
});

test('#8009 the decompiler renders the real string literal, never integer 0', async () => {
  const a = await run('A');
  assert.ok(a.pseudocode.includes('"A"'), `pseudocode must contain the literal: ${a.pseudocode}`);
  assert.ok(!/=\s*0;/.test(a.pseudocode), `the literal must not degrade to 0: ${a.pseudocode}`);
});
