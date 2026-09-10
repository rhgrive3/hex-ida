import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import {
  lowerVMEffectsToSemanticIr,
  decompileManagedMethod,
} from '../../../js/managed/shared/bridge-v2.js';

const MANAGED_STRING_TYPE = {
  kind: 'address',
  widthBits: 32,
  addressSpace: 'managed-heap',
};

function dexWithString(literal) {
  const method = {
    classType: 'LTest;',
    name: 'm',
    returnType: 'Ljava/lang/String;',
    params: [],
    flags: 0x0009,
    registers: 1,
    ins: 0,
    words: [0x001a, 0, 0x0011],
  };
  const seed = buildDex({ strings: [literal], methods: [method] });
  const stringIndex = seed.layout.stringsList.indexOf(literal);
  assert.ok(stringIndex >= 0, 'fixture literal must have a DEX string index');
  return {
    stringIndex,
    bytes: buildDex({
      strings: [literal],
      methods: [{ ...method, words: [0x001a, stringIndex, 0x0011] }],
    }).bytes,
  };
}

async function analyze(literal) {
  const { bytes, stringIndex } = dexWithString(literal);
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'issue-8009-same-layout' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((candidate) => candidate.name === 'm');
  assert.ok(method, 'fixture method must enumerate');
  const decoded = await frontend.decodeMethod(method, { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const bundle = decoded.bundles.find((candidate) => candidate.mnemonic === 'const-string');
  assert.ok(bundle, 'const-string bundle must exist');
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const node = lowered.semanticIr.nodes.find((candidate) => candidate.metadata?.mnemonic === 'const-string');
  assert.ok(node, 'const-string Semantic IR node must exist');
  const value = lowered.semanticIr.values.find((candidate) => node.outputs.includes(candidate.id));
  assert.ok(value, 'const-string SemanticValue must exist');
  return {
    stringIndex,
    decoded,
    validation,
    bundle,
    lowered,
    value,
    pseudocode: decompileManagedMethod(lowered).pseudocode,
    directPseudocode: decompileManagedMethod(decoded).pseudocode,
  };
}

function assertStringAuthority(result, literal) {
  assert.equal(result.bundle.completeness, 'exact');
  assert.deepEqual(result.bundle.producedValues[0].type, MANAGED_STRING_TYPE);
  assert.equal(result.bundle.producedValues[0].stringRef, literal);
  assert.equal(result.bundle.producedValues[0].stringIndex, result.stringIndex);
  assert.equal(result.validation.completeness.semanticEffect, 'complete');
  assert.equal(result.lowered.semanticIr.completeness, 'complete');
  assert.deepEqual(result.lowered.semanticIr.unknowns, []);
  assert.deepEqual(result.value.machineType, MANAGED_STRING_TYPE);
  assert.equal(result.value.metadata?.stringRef, literal);
  assert.equal(result.value.metadata?.stringIndex, result.stringIndex);
  const rendered = JSON.stringify(literal);
  for (const text of [result.pseudocode, result.directPseudocode]) {
    assert.ok(text.includes(rendered), `decompiler must render ${rendered}`);
    assert.ok(!text.includes(' = 0;'), 'string literal must not be fabricated as numeric zero');
  }
}

test('#8009: valid DEX const-string preserves literal/index/type through public lowering and decompilation', async () => {
  for (const literal of ['A', '', '猫', 'A"\\\nB']) {
    assertStringAuthority(await analyze(literal), literal);
  }
});

test('#8009: otherwise-identical A/B string constants remain distinguishable in complete canonical IR', async () => {
  const a = await analyze('A');
  const b = await analyze('B');
  assert.equal(a.stringIndex, b.stringIndex, 'counterexample must keep the encoded string index identical');
  assert.notDeepEqual(a.value.metadata, b.value.metadata);
  assert.notEqual(a.pseudocode, b.pseudocode);
});

test('#8009: malformed string authority fails closed without caller-controlled coercion', async () => {
  const good = await analyze('A');
  let coercions = 0;
  const spoof = { toString() { coercions += 1; return 'A'; } };
  const replaceProduced = (replacement) => ({
    ...good.decoded,
    bundles: good.decoded.bundles.map((bundle) => bundle.mnemonic === 'const-string'
      ? { ...bundle, producedValues: [{ ...bundle.producedValues[0], ...replacement }] }
      : bundle),
  });

  const badRef = replaceProduced({ stringRef: spoof });
  assert.throws(() => lowerVMEffectsToSemanticIr(badRef), /managed-bridge-invalid-string-ref/);
  assert.equal(coercions, 0, 'string identity validation must not invoke user-controlled toString');

  const badIndex = replaceProduced({ stringIndex: -1 });
  assert.throws(() => lowerVMEffectsToSemanticIr(badIndex), /managed-bridge-invalid-string-index/);

  const targetId = good.value.id;
  const malformedLowered = {
    ...good.lowered,
    semanticIr: {
      ...good.lowered.semanticIr,
      values: good.lowered.semanticIr.values.map((value) => value.id === targetId
        ? { ...value, metadata: { stringRef: spoof, stringIndex: good.stringIndex } }
        : value),
    },
  };
  assert.throws(() => decompileManagedMethod(malformedLowered), /managed-decompiler-invalid-string-ref/);
  assert.equal(coercions, 0, 'decompiler must also reject rather than coerce malformed string authority');
});
