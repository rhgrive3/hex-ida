// Regression for #7987: CIL `ldfld` (0x7B) / `stfld` (0x7D) carry receiver-null
// exceptional control-flow authority — ECMA-335 Partition III: both throw
// System.NullReferenceException when `obj` is null. The receiver operand is
// published with the stable consumed-value id `obj` for both operand orders,
// so the condition is encodable losslessly via possibleExceptions (wasm #1134
// vocabulary): the bundle must publish it instead of claiming exception-free
// exact/complete semantics. `ldsfld`/`stsfld` address no receiver and must
// stay exception-free.
import assert from 'node:assert/strict';

import { parseCil } from '../js/managed/cil/parser.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { CilFrontend } from '../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

console.log('[phase11] running cil ldfld/stfld null-receiver exception authority regression #7987...');

const FIELD_TOKEN = 0x04000001;
const TOKEN_BYTES = [0x01, 0x00, 0x00, 0x04];
const NRE = { kind: 'null-reference', condition: 'obj==null' };
const RET = 0x2a;

function fixture(body) {
  const image = buildCil({
    methods: [{
      name: 'FieldAccess',
      body,
      flags: 0x0006,
      signature: [0x20, 0x00, 0x01],
    }],
  });
  return image.bytes;
}

function lifterBundle(mnemonic, body) {
  const effects = liftCilMethod(0, parseCil(fixture(body)));
  const bundle = effects.bundles.find((b) => b.mnemonic === mnemonic);
  assert.ok(bundle, `${mnemonic} bundle present`);
  return { effects, bundle };
}

// ldfld with a symbolic receiver publishes the receiver-null NRE condition and
// keeps exact semantics: the schema encodes the condition losslessly.
{
  const { bundle } = lifterBundle('ldfld', [0x02, 0x7b, ...TOKEN_BYTES, 0x26]);
  assert.deepEqual(bundle.possibleExceptions, [NRE]);
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.memoryEffects, [{ space: 'field', token: FIELD_TOKEN, isWrite: false }]);
}

// stfld keeps its store operand order (val pushed after obj, consumed first)
// and publishes the same receiver-null condition over the stable `obj` id.
{
  const { bundle } = lifterBundle('stfld', [0x02, 0x17, 0x7d, ...TOKEN_BYTES]);
  assert.deepEqual(bundle.consumedValues.map((v) => v.id), ['val', 'obj']);
  assert.deepEqual(bundle.possibleExceptions, [NRE]);
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.memoryEffects, [{ space: 'field', token: FIELD_TOKEN, isWrite: true }]);
}

// ldsfld/stsfld address no receiver: the exception-free contract is unchanged.
{
  const { bundle: ldsfld } = lifterBundle('ldsfld', [0x7e, ...TOKEN_BYTES, 0x26]);
  assert.deepEqual(ldsfld.possibleExceptions, []);
  assert.equal(ldsfld.completeness, 'exact');
  assert.deepEqual(ldsfld.memoryEffects, [{ space: 'static-field', token: FIELD_TOKEN, isWrite: false }]);
}
{
  const { bundle: stsfld } = lifterBundle('stsfld', [0x17, 0x80, ...TOKEN_BYTES]);
  assert.deepEqual(stsfld.possibleExceptions, []);
  assert.equal(stsfld.completeness, 'exact');
  assert.deepEqual(stsfld.memoryEffects, [{ space: 'static-field', token: FIELD_TOKEN, isWrite: true }]);
}

// Concrete-null receiver: the condition remains published and evaluates true
// for the operand — the exceptional authority is not silently dropped.
{
  const { bundle } = lifterBundle('ldfld', [0x14, 0x7b, ...TOKEN_BYTES, 0x26]);
  assert.deepEqual(bundle.possibleExceptions, [NRE]);
  assert.equal(bundle.completeness, 'exact');
}

// Proven-non-null receiver (constructed object): the published condition is a
// true statement over the operand, so it stays — no receiver provenance case
// may lose the exception authority.
{
  const { bundle } = lifterBundle('ldfld', [0x73, 0x01, 0x00, 0x00, 0x0a, 0x7b, ...TOKEN_BYTES, 0x26]);
  assert.deepEqual(bundle.possibleExceptions, [NRE]);
  assert.equal(bundle.completeness, 'exact');
}

// Frontend path: a valid instance method keeps validation 'valid' with
// complete semantic effects now that the exceptional authority is encoded.
async function frontendCase(body) {
  const { bytes } = buildCil({
    methods: [{ name: 'FieldAccess', body, flags: 0x0006, signature: [0x20, 0x00, 0x01] }],
  });
  const frontend = new CilFrontend();
  const image = await frontend.open(bytes, { binaryId: 'issue-7987' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  return { decoded, validation, lowered };
}

{
  const { decoded, validation, lowered } = await frontendCase([0x02, 0x7b, ...TOKEN_BYTES, 0x26, RET]);
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldfld');
  assert.deepEqual(bundle.possibleExceptions, [NRE]);
  assert.equal(validation.status, 'valid');
  assert.equal(validation.completeness.semanticEffect, 'complete');
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'ldfld');
  assert.ok(node, 'ldfld node present in lowered IR');
  assert.deepEqual(node.metadata.possibleExceptions, [NRE]);
}

// try { ldarg.0; ldfld <field> } catch { pop; ret }: the published NRE
// authority must propagate through VMEffects into the Semantic IR, and the
// try block carrying ldfld must gain the exception edge to the catch handler.
{
  const { bytes, layout } = buildCil({
    methods: [{ name: 'FieldTryCatch', body: [0x02, 0x7b, ...TOKEN_BYTES, 0x26, RET], flags: 0x0006, signature: [0x20, 0x00, 0x01] }],
  });
  const method = layout.bodyOffsets[0];
  const view = new DataView(bytes.buffer);
  view.setUint16(method, 0x300b, true);
  view.setUint16(method + 2, 8, true);
  view.setUint32(method + 4, 8, true);
  view.setUint32(method + 8, 0, true);
  bytes.set([0x02, 0x7b, ...TOKEN_BYTES, 0x26, RET], method + 12);
  const clause = method + 12 + 8;
  bytes[clause] = 0x41;
  bytes[clause + 1] = 28;
  bytes[clause + 2] = 0;
  bytes[clause + 3] = 0;
  view.setUint32(clause + 4, 0, true);
  view.setUint32(clause + 8, 0, true);
  view.setUint32(clause + 12, 6, true);
  view.setUint32(clause + 16, 6, true);
  view.setUint32(clause + 20, 2, true);
  view.setUint32(clause + 24, 0x02000001, true);

  const effects = liftCilMethod(0, parseCil(bytes));
  assert.deepEqual(
    effects.exceptionRegions.map((r) => [r.startOffset, r.endOffset, r.handlerOffset, r.handlerKind]),
    [[0, 6, 6, 'catch']],
  );
  const ldfldBundle = effects.bundles.find((b) => b.mnemonic === 'ldfld');
  assert.deepEqual(ldfldBundle.possibleExceptions, [NRE]);

  const lowered = lowerVMEffectsToSemanticIr(effects);
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'ldfld');
  assert.ok(node, 'ldfld node present in lowered IR');
  assert.deepEqual(node.metadata.possibleExceptions, [NRE]);
  const tryBlock = lowered.cfg.blocks.find((b) => b.id === node.blockId);
  assert.equal(node.blockId, 'bb_0x0');
  const exceptionEdge = tryBlock.successors.find((e) => e.kind === 'exception');
  assert.ok(exceptionEdge, 'try block carrying ldfld must gain the exception edge');
  assert.equal(exceptionEdge.to, 'bb_0x6', 'exception edge must target the catch handler block');
}

console.log('[phase11] cil ldfld/stfld null-receiver exception authority regression #7987 passed');
