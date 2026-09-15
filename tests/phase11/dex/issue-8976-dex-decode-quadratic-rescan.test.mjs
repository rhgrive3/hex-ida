import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { deepFreeze } from '../../../js/core/identity/index.js';
import { dexMethodDefinitions } from '../../../js/managed/dex/method-definitions.js';
import { captureDexValidationMetadata } from '../../../js/managed/dex/validation.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';

// #8976: whole-module DEX decode used to rebuild the module method-definition authority
// and linearly re-scan every class' direct/virtual method arrays on EACH method decode
// (lifter -> liftBase scan -> validation methodEntry scan), making ordinary valid decode
// O(N^2). `parseDex` returns a deep-frozen image, so the derived authority is now memoized
// out-of-band (WeakMap keyed on the frozen image) and reused by every consumer.

// codeOff = 0 keeps captureDexValidationMetadata on the entry-resolution fast path while
// still forcing one dexMethodDefinitions(image) call per decode via methodEntry().
const syntheticImage = (n) => deepFreeze({
  moduleId: 'managed-mod:synthetic-dex', vmSpecEdition: 'dalvik-dex-039',
  strings: [], types: ['LTest;'], fields: [],
  methods: Array.from({ length: n }, (_, i) => ({ name: `m${i}`, classType: 'LTest;', proto: { params: [], returnType: 'V' } })),
  classes: [{ classType: 'LTest;', staticFields: [], instanceFields: [],
    directMethods: Array.from({ length: n }, (_, i) => ({ methodIdx: i, codeOff: 0, accessFlags: 0x0008 })),
    virtualMethods: [] }],
});

test('#8976: the definition authority is built once per frozen image and reused (O(N), not O(N^2))', () => {
  const image = syntheticImage(500);
  assert.ok(Object.isFrozen(image));
  const first = dexMethodDefinitions(image);
  assert.equal(first.size, 500);
  assert.equal(dexMethodDefinitions(image), first, 'frozen-image authority must be memoized (same Map instance)');
});

test('#8976: a full per-method validation pass never rebuilds the authority', () => {
  const image = syntheticImage(400);
  const before = dexMethodDefinitions(image); // builds + caches once
  for (let i = 0; i < 400; i++) {
    const meta = captureDexValidationMetadata(i, image); // internally methodEntry -> dexMethodDefinitions
    assert.equal(meta.methodIdx, i);
    assert.ok(!meta.structuralErrors.some((e) => e.code === 'dex-method-definition-missing'), `method ${i} resolves its class_data entry`);
  }
  // Identity after the whole pass proves every per-decode scan reused the single cached
  // authority; a rebuild/rescan-per-method would have replaced the cached instance.
  assert.equal(dexMethodDefinitions(image), before, 'whole-module decode pass must not rebuild the authority per method');
});

test('#8976: real parseDex image still decodes and reuses the authority across the frontend', async () => {
  const image = parseDex(buildDex().bytes); // default single concrete method
  const before = dexMethodDefinitions(image);
  const frontend = new DexFrontend();
  const ids = [];
  for await (const m of frontend.enumerateMethods(image)) ids.push(m.methodIdx);
  assert.deepEqual(ids, [0]);
  const decoded = await frontend.decodeMethod({ methodIdx: 0 }, { image });
  assert.ok(decoded.metadata.dexValidation, 'validation metadata captured via shared index');
  assert.equal(decoded.aggregateCompleteness ?? 'exact', 'exact');
  const fx = liftDexMethod(0, image);
  assert.equal(fx.aggregateCompleteness, 'exact');
  assert.equal(dexMethodDefinitions(image), before, 'real-image decode must reuse the memoized authority');
});

test('#8976: a non-frozen (mutable caller-owned) image is NEVER memoized', () => {
  const image = dexMethod([0x000e]); // plain, unfrozen synthetic image
  assert.equal(Object.isFrozen(image), false);
  const a = dexMethodDefinitions(image);
  const b = dexMethodDefinitions(image);
  assert.notEqual(a, b, 'a mutable image must not return a cached (possibly-stale/poisoned) index');
  assert.deepEqual([...a.keys()], [...b.keys()]);
});

test('#8976: class_data validation is preserved through the memoized path', () => {
  assert.throws(() => dexMethodDefinitions({
    methods: [{ classType: 'LTest;' }],
    classes: [{ classType: 'LTest;', directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }, { methodIdx: 0, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }],
  }), /dex-duplicate-method-definition/);
  assert.throws(() => dexMethodDefinitions({
    methods: [{ classType: 'LTest;' }],
    classes: [{ classType: 'LOther;', directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }],
  }), /dex-method-definition-owner-mismatch/);
  assert.throws(() => dexMethodDefinitions({
    methods: [],
    classes: [{ classType: 'LTest;', directMethods: [{ methodIdx: 3, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }],
  }), /dex-invalid-class-data-method-index/);
  // a bad image must never be cached
  const bad = deepFreeze({ methods: [{ classType: 'LTest;' }],
    classes: [{ classType: 'LOther;', directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }] });
  assert.throws(() => dexMethodDefinitions(bad), /dex-method-definition-owner-mismatch/);
  assert.throws(() => dexMethodDefinitions(bad), /dex-method-definition-owner-mismatch/);
});

test('#8976: a class_data-less (external) method stays a soft structural error, not a crash', () => {
  // method 1 is declared in methods[] but granted no class_data definition authority,
  // so the shared index must simply omit it -> methodEntry() -> null (not a throw).
  const image = deepFreeze({
    moduleId: 'managed-mod:synthetic-external', vmSpecEdition: 'dalvik-dex-039',
    strings: [], types: ['LTest;'], fields: [],
    methods: [{ name: 'internal', classType: 'LTest;', proto: { params: [], returnType: 'V' } },
      { name: 'external', classType: 'LTest;', proto: { params: [], returnType: 'V' } }],
    classes: [{ classType: 'LTest;', staticFields: [], instanceFields: [],
      directMethods: [{ methodIdx: 0, codeOff: 0, accessFlags: 0x0008 }], virtualMethods: [] }],
  });
  const meta = captureDexValidationMetadata(1, image);
  assert.equal(meta.methodIdx, 1);
  assert.ok((meta.structuralErrors ?? []).some((e) => e.code === 'dex-method-definition-missing'),
    'absent definition must remain a structural error, not a hard throw');
  assert.equal(dexMethodDefinitions(image).has(1), false, 'index must omit a class_data-less method');
  assert.equal(dexMethodDefinitions(image).has(0), true, 'index must contain the defined method');
});

test('#8976: a shallow-frozen image with mutable nested class_data is NEVER memoized', () => {
  const image = {
    methods: [{ classType: 'LTest;' }, { classType: 'LTest;' }],
    classes: [{ classType: 'LTest;', directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }], virtualMethods: [] }],
  };
  Object.freeze(image);
  const first = dexMethodDefinitions(image);
  image.classes[0].directMethods.push({ methodIdx: 1, codeOff: 4, accessFlags: 9 });
  const second = dexMethodDefinitions(image);
  assert.notEqual(second, first, 'shallow-frozen caller images must not reuse a stale derived index');
  assert.deepEqual([...second.keys()], [0, 1]);
});
