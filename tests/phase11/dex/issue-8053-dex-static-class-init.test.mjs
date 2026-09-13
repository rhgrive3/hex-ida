// Regression for #8053: DEX `sget*`/`sput*` must preserve the declaring
// class's initialization authority (ART runs a class-initialization check on
// every static-field access; a declared `<clinit>` may execute arbitrary code
// and fail before the field operation completes). One-time initialization
// state is not provable per-instruction, so an access that may trigger a
// declared `<clinit>` fails closed to partial with an explicit unknown
// initialization effect instead of publishing an unconditional pure
// load/store. An access from inside the declaring class's own `<clinit>` is
// already on the initializing thread and must not invent recursive
// initialization. Instance-field opcodes are untouched (#7981 is a separate
// owner).
import assert from 'node:assert/strict';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr, buildManagedMethodSummary } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running dex static class-initialization authority regression #8053...');

const FAILING_CLINIT = [
  0x1012,             // const/4 v0, #1
  0x0112,             // const/4 v1, #0
  0x0093, 0x0100,     // div-int v0, v0, v1 -> ArithmeticException
  0x000e,             // return-void
];

function fixture(methods) {
  return buildDex({
    classNames: ['LT;', 'LU;'],
    fields: [{ classType: 'LT;', type: 'I', name: 'x', static: true, flags: 0x8 }],
    methods,
  }).bytes;
}

async function lift(bytes, name) {
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: `dex-static-init-${name}` });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods.find((m) => m.name === 'access'), { image });
  const validation = await frontend.validateMethod(decoded, { image });
  return { image, decoded, validation, lowered: lowerVMEffectsToSemanticIr(decoded) };
}

const ACCESSOR = (words, type = 'I') => ({
  classType: 'LU;', name: 'access', returnType: type, params: [],
  flags: 0x9, registers: 2, words,
});
const CLINIT = (words) => ({ classType: 'LT;', name: '<clinit>', returnType: 'V', params: [], flags: 0x10008, registers: 2, words });

// 1+2+3. sget/sput from a foreign class whose declaring class declares a
// `<clinit>`: partial with explicit initialization authority (content of the
// initializer does not change the authority).
for (const [label, words] of [
  ['sget', [0x0060, 0x0000, 0x000f]],
  ['sput', [0x2012, 0x0067, 0x0000, 0x000e]],
]) {
  const { decoded, validation, lowered } = await lift(
    fixture([CLINIT(FAILING_CLINIT), ACCESSOR(words)]),
    `foreign-${label}`,
  );
  const bundle = decoded.bundles.find((b) => b.mnemonic === label);
  assert.ok(bundle, `${label} bundle present`);
  assert.equal(bundle.completeness, 'partial', `${label} must fail closed`);
  assert.deepEqual(bundle.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-unverified' },
  ]);
  const init = bundle.memoryEffects[0].classInitialization;
  assert.deepEqual(init, {
    declaringClass: 'LT;',
    clinitPresent: true,
    initializationRequired: true,
    initializationProven: false,
  });
  assert.equal(validation.completeness.semanticEffect, 'partial',
    `${label} must not launder initialization authority as complete`);
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === label);
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown.reason, 'dex-class-initialization-unverified');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'dex-class-initialization-unverified'));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  const summary = buildManagedMethodSummary(lowered);
  assert.equal(summary.completeness, 'partial',
    `${label} summary must not claim complete over an unmodeled <clinit>`);
}

// 4. Same authority for a trivial `<clinit>`: presence, not content, selects
// the fail-closed contract.
{
  const { decoded } = await lift(
    fixture([CLINIT([0x1012, 0x000e]), ACCESSOR([0x0060, 0x0000, 0x000f])]),
    'trivial-clinit',
  );
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'sget');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.memoryEffects[0].classInitialization.clinitPresent, true);
}

// 5. Access from inside the declaring class's own `<clinit>` discharges the
// trigger (no recursive initialization invented).
{
  const frontend = new DexFrontend();
  const image = await frontend.open(fixture([
    { classType: 'LT;', name: '<clinit>', returnType: 'V', params: [], flags: 0x10008, registers: 2, words: [0x0060, 0x0000, 0x000e] },
  ]), { binaryId: 'dex-static-init-self-clinit' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods.find((m) => m.name === '<clinit>'), { image });
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'sget');
  assert.ok(bundle, 'self sget bundle present');
  assert.equal(bundle.completeness, 'exact', 'self-access must not invent recursion');
  assert.deepEqual(bundle.unknownEffects, []);
  assert.deepEqual(bundle.memoryEffects[0].classInitialization, {
    declaringClass: 'LT;',
    clinitPresent: true,
    initializationRequired: false,
    initializationProven: false,
    discharged: 'declaring-class-initializer',
  });
}

// 6. Modern DEX without canonical superinterface/default-method authority
// cannot use the absence of a declaring-class `<clinit>` as proof that class
// initialization has no executable trigger. Keep the access fail-closed; the
// pre-037 exact control lives in the focused superclass/interface regression.
{
  const { image, decoded } = await lift(fixture([ACCESSOR([0x0060, 0x0000, 0x000f])]), 'no-clinit');
  assert.equal(image.formatVersion, 'dex-039');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'sget');
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.unknownEffects, [
    { category: 'calls', reason: 'dex-class-initialization-superinterface-authority-unavailable' },
  ]);
  assert.deepEqual(bundle.memoryEffects[0].classInitialization, {
    declaringClass: 'LT;',
    clinitPresent: false,
    initializationRequired: true,
    initializationProven: false,
    superinterfaceAuthority: 'unavailable',
  });
}

// 7. Narrow/wide/object/write variants ride the same authority.
for (const [mnemonic, op, fieldType, ret] of [
  ['sget-wide', 0x61, 'J', 0x0010],
  ['sget-object', 0x62, 'LT;', 0x0011],
  ['sget-short', 0x66, 'S', 0x000f],
  ['sput-object', 0x69, 'LT;', null],
  ['sput-short', 0x6d, 'S', null],
]) {
  const words = ret == null
    ? [0x0012, op, 0x0000, 0x000e]  // const/4 v0,#0; <op> v0, field@0; return-void
    : [op, 0x0000, ret];
  const bytes = buildDex({
    classNames: ['LT;', 'LU;'],
    fields: [{ classType: 'LT;', type: fieldType, name: 'x', static: true, flags: 0x8 }],
    methods: [CLINIT(FAILING_CLINIT), ACCESSOR(words, ret == null ? 'V' : fieldType)],
  }).bytes;
  const { decoded } = await lift(bytes, `variant-${mnemonic}`);
  const bundle = decoded.bundles.find((b) => b.mnemonic === mnemonic);
  assert.ok(bundle, `${mnemonic} bundle present`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic} must fail closed`);
  assert.equal(bundle.memoryEffects[0].classInitialization.initializationRequired, true);
}

// 8. Instance-field opcodes keep their existing contract (no class-init
// authority, #7981 separate owner).
{
  const bytes = buildDex({
    classNames: ['LT;'],
    fields: [{ classType: 'LT;', type: 'I', name: 'y', static: false, flags: 0x1 }],
    methods: [{ classType: 'LT;', name: 'access', returnType: 'I', params: [], flags: 0x1, registers: 2, ins: 1, words: [0x1052, 0x0000, 0x000f] }],
  }).bytes;
  const { decoded } = await lift(bytes, 'instance-untouched');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'iget');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.memoryEffects[0].classInitialization, undefined);
}

console.log('  ok dex static class-initialization authority regression #8053 passed');
