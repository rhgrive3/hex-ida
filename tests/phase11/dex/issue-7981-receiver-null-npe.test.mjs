import assert from 'node:assert/strict';
import test from 'node:test';

import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { dexFieldEffects } from '../../../js/managed/dex/field-effects.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';

// #7981: `iget*`/`iput*` modeled every instance field access as an
// exception-free exact memory operation even though a null receiver is a
// defined `java/lang/NullPointerException` path in ART. The bundle now carries
// the receiver-null exception authority (`possibleExceptions` +
// `receiverNullException` on the memory effect), the shared bridge maps it to
// a `null-reference` fault on the Semantic IR memory access, and the validator
// refuses to advertise `semanticEffect:'complete'` for an instance-field
// access that lacks the authority. Static `sget*`/`sput*` have no receiver and
// must not inherit the condition.

const INSTANCE_VARIANTS = [
  [0x52, 'I', 'iget'], [0x53, 'J', 'iget-wide'], [0x54, 'Ljava/lang/String;', 'iget-object'],
  [0x55, 'Z', 'iget-boolean'], [0x56, 'B', 'iget-byte'], [0x57, 'C', 'iget-char'],
  [0x58, 'S', 'iget-short'],
  [0x59, 'I', 'iput'], [0x5a, 'J', 'iput-wide'], [0x5b, 'Ljava/lang/String;', 'iput-object'],
  [0x5c, 'Z', 'iput-boolean'], [0x5d, 'B', 'iput-byte'], [0x5e, 'C', 'iput-char'],
  [0x5f, 'S', 'iput-short'],
];

const NPE = 'java/lang/NullPointerException';

function variantImage(opcode, fieldType) {
  return dexMethod([0x1200, (opcode & 0xff) | 0x0100, 0x0000, 0x010f, 0x000e], {
    registers: 2,
    fields: [{ classType: 'LTest;', type: fieldType, name: 'x' }],
  });
}

test('#7981 every iget*/iput* variant carries the receiver-null NPE authority', () => {
  for (const [opcode, fieldType, mnemonic] of INSTANCE_VARIANTS) {
    const image = variantImage(opcode, fieldType);
    const effects = dexFieldEffects({
      opcode, formatByte: 0x01, fieldIndex: 0, image,
    });
    assert.equal(effects.mnemonic, mnemonic, mnemonic);
    assert.deepEqual(effects.possibleExceptions, [NPE], mnemonic);
    const effect = effects.memoryEffects[0];
    assert.equal(effect.space, 'field', mnemonic);
    assert.equal(effect.receiverNullException, true, mnemonic);
  }
});

test('#7981 static sget*/sput* do not inherit the receiver-null condition', () => {
  for (const [opcode, fieldType, mnemonic] of [[0x60, 'I', 'sget'], [0x66, 'S', 'sget-short'], [0x67, 'I', 'sput'], [0x6d, 'S', 'sput-short']]) {
    const image = variantImage(opcode, fieldType);
    const effects = dexFieldEffects({
      opcode, formatByte: 0x00, fieldIndex: 0, image,
    });
    assert.equal(effects.mnemonic, mnemonic, mnemonic);
    assert.deepEqual(effects.possibleExceptions, [], mnemonic);
    assert.equal(effects.memoryEffects[0].receiverNullException, undefined, mnemonic);
    assert.equal(effects.memoryEffects[0].space, 'static-field', mnemonic);
  }
});

async function runPipeline(words, overrides = {}) {
  const { bytes } = buildDex({
    fields: [{ classType: 'LTest;', type: 'I', name: 'x', static: false, flags: 1 }],
    methods: [{
      classType: 'LTest;', name: 'touch', returnType: overrides.returnType ?? 'I', params: [],
      flags: 9, registers: 2, ins: 0, outs: 0, words, ...overrides,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'dex-npe-regression-7981' });
  const methods = [];
  for await (const m of frontend.enumerateMethods(image)) methods.push(m);
  const method = methods.find((m) => m.name === 'touch');
  const decoded = await frontend.decodeMethod(method, { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  return { decoded, validation, lowered };
}

test('#7981 the iget load carries the null-reference fault on its memory access', async () => {
  const { decoded, lowered } = await runPipeline([
    0x0012, // const/4 v0, #0
    0x0152, 0x0000, // iget v1, v0, field@0
    0x010f, // return v1
  ]);
  const iget = decoded.bundles.find((b) => b.mnemonic === 'iget');
  assert.equal(iget.completeness, 'exact');
  assert.deepEqual(iget.possibleExceptions, [NPE]);
  assert.equal(iget.memoryEffects[0].receiverNullException, true);
  assert.equal(decoded.aggregateCompleteness, 'exact');

  const igetNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'iget');
  assert.deepEqual(igetNode.metadata.possibleExceptions, [NPE]);
  const [fault] = igetNode.memory.faults;
  assert.equal(fault.kind, 'null-reference');
  // The fault condition references the receiver — the DEX overlay's canonical
  // field-address node takes the same receiver read as its input, so the
  // condition and the dereference stay one dataflow edge apart and the
  // condition remains symbolic for downstream resolution.
  const addressNode = lowered.semanticIr.nodes.find((n) => n.id === `${igetNode.id}:field-address`);
  assert.ok(addressNode, 'the overlay must mint the canonical field-address node');
  assert.deepEqual(fault.condition.valueId, addressNode.inputs[0]);
  assert.equal(fault.detail.exceptionType, NPE);
  assert.equal(fault.detail.receiver, true);
});

test('#7981 iput keeps the same fault authority on the store', async () => {
  const { decoded, lowered } = await runPipeline([
    0x0012, // const/4 v0, #0
    0x5212, // const/4 v2, #5
    0x0259, 0x0000, // iput v2, v0, field@0
    0x000e, // return-void
  ], { registers: 3, returnType: 'V' });
  const iput = decoded.bundles.find((b) => b.mnemonic === 'iput');
  assert.equal(iput.completeness, 'exact');
  assert.deepEqual(iput.possibleExceptions, [NPE]);
  const storeNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'iput');
  assert.equal(storeNode.memory.faults[0].kind, 'null-reference');
  assert.equal(storeNode.memory.faults[0].detail.exceptionType, NPE);
});

test('#7981 the validator refuses complete semanticEffect without the authority', async () => {
  const words = [0x0012, 0x0152, 0x0000, 0x010f];
  const { decoded, validation } = await runPipeline(words);
  assert.equal(validation.completeness.semanticEffect, 'complete');

  // Forged bundle with the receiver-null authority stripped must downgrade.
  const frontend = new DexFrontend();
  const forged = structuredClone(decoded);
  for (const b of forged.bundles) {
    for (const m of b.memoryEffects ?? []) delete m.receiverNullException;
  }
  const stripped = await frontend.validateMethod(forged, {});
  assert.equal(stripped.completeness.semanticEffect, 'partial');
});

test('#7981 an iget inside a try region keeps the NPE fault and the handler edge', async () => {
  const image = dexMethod(
    [0x0012, 0x0152, 0x0000, 0x000e, 0x000e],
    { registers: 2, tries: [{ start: 0, count: 3, handlerOff: 1 }], handlers: [1, 1, 0, 4] },
  );
  const { liftDexMethod } = await import('../../../js/managed/dex/lifter.js');
  const effects = liftDexMethod(0, image);
  const region = effects.exceptionRegions[0];
  assert.ok(region, 'try region must decode');
  const lowered = lowerVMEffectsToSemanticIr(effects);
  const igetNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'iget');
  assert.equal(igetNode.memory.faults[0].detail.exceptionType, NPE);
  const igetBlock = lowered.cfg.blocks.find((b) => b.id === igetNode.blockId);
  assert.ok(
    igetBlock.successors.some((e) => e.kind === 'exception' && e.to === `bb_0x${region.handlerOffset.toString(16)}`),
    'the handler must stay reachable through the shared exception edge',
  );
});
