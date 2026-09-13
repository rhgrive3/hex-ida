import assert from 'node:assert/strict';
import test from 'node:test';

import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

const ACC_NATIVE = 0x0100;
const ACC_ABSTRACT = 0x0400;

test('#4676 a referenced-only method_id is never lifted as exact abstract_method', () => {
  const image = parseDex(buildDex({
    methods: [
      { classType: 'LTest;', name: 'external', returnType: 'V', defined: false },
      { classType: 'LTest;', name: 'local', returnType: 'V', words: [0x000e], flags: 9 },
    ],
  }).bytes);
  const lifted = liftDexMethod(0, image);
  const mnemonics = lifted.bundles.map((b) => b.mnemonic);
  assert.ok(!mnemonics.includes('abstract_method'), 'external reference must not become abstract_method');
  assert.notEqual(lifted.aggregateCompleteness, 'exact');
});

test('#4676 enumerateMethods yields only class_data-defined methods', async () => {
  const image = parseDex(buildDex({
    methods: [
      { classType: 'LTest;', name: 'external', returnType: 'V', defined: false },
      { classType: 'LTest;', name: 'local', returnType: 'V', words: [0x000e], flags: 9 },
    ],
  }).bytes);
  const listed = [];
  for await (const method of new DexFrontend().enumerateMethods(image)) listed.push(method.methodIdx);
  assert.deepEqual(listed, [1]);
});

test('#4676 a real ACC_ABSTRACT definition keeps abstract/exact semantics', () => {
  const image = parseDex(buildDex({
    methods: [{ classType: 'LTest;', name: 'abs', returnType: 'V', defined: true, words: null, flags: ACC_ABSTRACT }],
  }).bytes);
  const lifted = liftDexMethod(0, image);
  assert.ok(lifted.bundles.some((b) => b.mnemonic === 'abstract_method'));
  assert.equal(lifted.aggregateCompleteness, 'exact');
});

test('#4676 a real ACC_NATIVE definition keeps the JNI boundary', () => {
  const image = parseDex(buildDex({
    methods: [{ classType: 'LTest;', name: 'nat', returnType: 'V', defined: true, words: null, flags: ACC_NATIVE }],
  }).bytes);
  const lifted = liftDexMethod(0, image);
  assert.ok(lifted.bundles.some((b) => b.mnemonic === 'jni_native_method'));
  assert.equal(lifted.aggregateCompleteness, 'exact');
});

console.log('[phase11] issue #4676 dex external-method classification regression passed');
