// Regression for #8048: CIL `ldsfld`/`stsfld` must preserve the declaring
// type's initializer authority (ECMA-335 I.8.9.5: a non-`beforefieldinit`
// type triggers its `.cctor` at first static-field access; a
// `beforefieldinit` type may run it at any point up to the first access, and
// a failing initializer is observable as System.TypeInitializationException).
// The one-time initialization state is not provable per-instruction, so an
// access that may trigger a declared `.cctor` fails closed to partial with an
// explicit unknown initialization effect instead of publishing an
// unconditional pure load/store. An access from inside the declaring type's
// own `.cctor` is already on the initializing path and must not invent a
// recursive trigger. A type with no `.cctor` runs no declaring-type
// initializer code (base-type chain authority is a separate slice).
import assert from 'node:assert/strict';

import { buildCil, collect } from '../fixtures/medium-cil.mjs';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr, buildManagedMethodSummary } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running cil type-initialization authority regression #8048...');

const FIELD = [0x01, 0x00, 0x00, 0x04]; // FieldDef 0x04000001

const CCTOR = { name: '.cctor', flags: 0x1811, signature: [0, 0, 1], body: [0x17, 0x16, 0x5b, 0x26, 0x2a] };
const READ = { name: 'Read', flags: 0x16, signature: [0, 0, 8], body: [0x7e, ...FIELD, 0x2a] };
const WRITE = { name: 'Write', flags: 0x16, signature: [0, 0, 1], body: [0x17, 0x80, ...FIELD, 0x2a] };

function fixture({ typeFlags = 0x00000001, methods = [CCTOR, READ, WRITE] } = {}) {
  return buildCil({
    types: [
      { name: 'T', namespace: 'Audit', flags: typeFlags, fieldList: 1, methodList: 1 },
      { name: 'U', namespace: 'Audit', flags: 0x00100001, fieldList: 2, methodList: 2 },
    ],
    fields: [{ name: 'X', flags: 0x16 }],
    methods,
  }).bytes;
}

async function lift(bytes, name) {
  const frontend = new CilFrontend();
  const image = await frontend.open(bytes, { binaryId: `cil-static-init-${name}` });
  const methods = await collect(frontend.enumerateMethods(image));
  const decoded = await frontend.decodeMethod(methods.find((m) => m.name === name), { image });
  const validation = await frontend.validateMethod(decoded, { image });
  return { image, decoded, validation, lowered: lowerVMEffectsToSemanticIr(decoded) };
}

// 1+2. ldsfld/stsfld of a non-BeforeFieldInit type with a declared `.cctor`:
// the access is a required trigger whose one-time state cannot be proven —
// fail closed to partial with explicit initialization authority.
for (const [name, mnemonic] of [['Read', 'ldsfld'], ['Write', 'stsfld']]) {
  const { decoded, validation, lowered } = await lift(fixture(), name);
  const bundle = decoded.bundles.find((b) => b.mnemonic === mnemonic);
  assert.ok(bundle, `${mnemonic} bundle present`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic} must fail closed`);
  assert.deepEqual(bundle.unknownEffects, [
    { category: 'calls', reason: 'cil-type-initialization-unverified' },
  ]);
  assert.deepEqual(bundle.memoryEffects[0].typeInitialization, {
    declaringTypeToken: '0x02000001',
    declaringType: 'Audit.T',
    initializerPresent: true,
    beforeFieldInit: false,
    initializationRequired: true,
    initializationProven: false,
    triggerTiming: 'required-at-access',
  });
  assert.equal(decoded.aggregateCompleteness, 'partial');
  assert.equal(validation.completeness.semanticEffect, 'partial',
    `${mnemonic} must not launder initialization authority as complete`);
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mnemonic);
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown.reason, 'cil-type-initialization-unverified');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'cil-type-initialization-unverified'));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  const summary = buildManagedMethodSummary(lowered);
  assert.equal(summary.completeness, 'partial',
    `${mnemonic} summary must not claim complete over an unmodeled .cctor`);
}

// 3. BeforeFieldInit target: the initializer may run any time up to the first
// access, so the access still cannot claim an unconditional pure effect —
// but the timing authority differs and must be preserved.
{
  const { decoded } = await lift(fixture({ typeFlags: 0x00100001 }), 'Read');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.memoryEffects[0].typeInitialization.triggerTiming, 'allowed-before-access');
  assert.equal(bundle.memoryEffects[0].typeInitialization.beforeFieldInit, true);
}

// 4. Access from inside the declaring type's own `.cctor` discharges the
// trigger (no recursive initialization invented).
{
  const SELF_CCTOR = { name: '.cctor', flags: 0x1811, signature: [0, 0, 1], body: [0x7e, ...FIELD, 0x26, 0x2a] };
  const { decoded } = await lift(fixture({ methods: [SELF_CCTOR, READ, WRITE] }), '.cctor');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.ok(bundle, 'self ldsfld bundle present');
  assert.equal(bundle.completeness, 'exact', 'self-access must not invent recursion');
  assert.deepEqual(bundle.unknownEffects, []);
  assert.deepEqual(bundle.memoryEffects[0].typeInitialization, {
    declaringTypeToken: '0x02000001',
    declaringType: 'Audit.T',
    initializerPresent: true,
    beforeFieldInit: false,
    initializationRequired: false,
    initializationProven: false,
    discharged: 'declaring-type-initializer',
  });
}

// 5. Non-BeforeFieldInit target with no `.cctor`: no declaring-type
// initializer code runs; the access stays exact with explicit
// initializerPresent:false provenance.
{
  const { decoded } = await lift(fixture({ methods: [READ, WRITE] }), 'Read');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.unknownEffects, []);
  assert.deepEqual(bundle.memoryEffects[0].typeInitialization, {
    declaringTypeToken: '0x02000001',
    declaringType: 'Audit.T',
    initializerPresent: false,
    beforeFieldInit: false,
    initializationRequired: false,
    initializationProven: false,
  });
}

// 6. External (MemberRef) static field: the declaring type lives outside the
// image, so initialization state cannot be resolved — fail closed.
{
  const EXTERNAL_READ = { name: 'Read', flags: 0x16, signature: [0, 0, 8], body: [0x7e, 0x01, 0x00, 0x00, 0x0a, 0x2a] };
  const { decoded } = await lift(fixture({ methods: [CCTOR, EXTERNAL_READ, WRITE] }), 'Read');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.unknownEffects, [
    { category: 'calls', reason: 'cil-static-field-owner-external' },
  ]);
  assert.deepEqual(bundle.memoryEffects[0].typeInitialization, { declaringTypeResolved: false });
}

// 7. Unresolvable token table: fail closed, no fabricated authority.
{
  const BOGUS_READ = { name: 'Read', flags: 0x16, signature: [0, 0, 8], body: [0x7e, 0x01, 0x00, 0x00, 0x2b, 0x2a] };
  const { decoded } = await lift(fixture({ methods: [CCTOR, BOGUS_READ, WRITE] }), 'Read');
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.unknownEffects, [
    { category: 'calls', reason: 'cil-static-field-token-unresolved' },
  ]);
}

console.log('  ok cil type-initialization authority regression #8048 passed');
