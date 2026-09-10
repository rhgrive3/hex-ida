// Regression for #7896: ACC_SYNCHRONIZED on DEX methods is execution authority.
// ART's Generic JNI trampoline MonitorEnter()s the synchronization object
// before entering JNI and releases it on normal and abrupt completion. Until
// the shared VMEffect schema can encode implicit method monitors losslessly,
// synchronized methods must fail closed rather than publish plain-method-
// equivalent exact/complete semantics (JVM #7854 precedent).
import assert from 'node:assert/strict';

import { parseDex } from '../../../js/managed/dex/parser.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter-base.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running dex synchronized native monitor regression #7896...');

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_NATIVE = 0x0100;
const ACC_DECLARED_SYNCHRONIZED = 0x0020000;

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

// class_data_item: static=0, instance=0, direct=1, virtual=0;
// encoded_method: idx_diff=0, access_flags=flags, code_off=codeOff.
function fixture(flags, codeOff = 0) {
  const b = buildMinimalDex();
  b.fill(0, 0x120, 0x140);
  b.set([0, 0, 1, 0, 0, ...uleb(flags), ...uleb(codeOff)], 0x120);
  return b;
}

function lift(flags, codeOff = 0) {
  return liftDexMethod(0, parseDex(fixture(flags, codeOff)));
}

const REASON = 'dex-synchronized-method-monitor-unrepresented';

{
  const plain = lift(ACC_PUBLIC | ACC_STATIC | ACC_NATIVE);
  assert.equal(plain.aggregateCompleteness, 'exact');
  assert.equal(plain.bundles[0].mnemonic, 'jni_native_method');
  assert.equal(plain.bundles[0].completeness, 'exact');
  assert.ok(!plain.metadata?.synchronization);
}

{
  const sync = lift(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED | ACC_NATIVE);
  assert.equal(sync.bundles[0].mnemonic, 'jni_native_method');
  assert.notEqual(sync.aggregateCompleteness, 'exact');
  assert.equal(sync.aggregateCompleteness, 'partial');
  assert.equal(sync.bundles[0].completeness, 'partial');
  assert.ok(sync.bundles[0].unknownEffects.some((e) => e.reason === REASON));
  assert.equal(sync.metadata.synchronization.kind, 'implicit-dex-monitor');
  assert.equal(sync.metadata.synchronization.monitor, 'declaring-class'); // static
  assert.equal(sync.metadata.synchronization.acquire, 'method-entry');
  assert.equal(sync.metadata.synchronization.release, 'normal-or-abrupt-exit');
  assert.equal(sync.metadata.synchronization.completeness, 'unrepresented');
}

{
  const syncInstance = lift(ACC_PUBLIC | ACC_SYNCHRONIZED | ACC_NATIVE);
  assert.equal(syncInstance.metadata.synchronization.monitor, 'receiver');
  assert.equal(syncInstance.aggregateCompleteness, 'partial');
}

{
  const declared = lift(ACC_PUBLIC | ACC_STATIC | ACC_DECLARED_SYNCHRONIZED | ACC_NATIVE);
  assert.equal(declared.aggregateCompleteness, 'partial');
  assert.ok(declared.bundles[0].unknownEffects.some((e) => e.reason === REASON));
}

// Synchronized methods with bytecode fail closed too: the interpreter/JIT
// acquires the monitor on entry regardless of the body's opcodes.
{
  const withCode = lift(ACC_PUBLIC | ACC_SYNCHRONIZED, 0x140);
  assert.equal(withCode.bundles.length > 0, true);
  assert.equal(withCode.aggregateCompleteness, 'partial');
  assert.ok(withCode.bundles[0].unknownEffects.some((e) => e.reason === REASON));
  assert.equal(withCode.metadata.synchronization.kind, 'implicit-dex-monitor');
}

{
  const plainWithCode = lift(ACC_PUBLIC, 0x140);
  assert.equal(plainWithCode.aggregateCompleteness, 'exact');
  assert.ok(!plainWithCode.metadata?.synchronization);
}

// Frontend validation must not report semanticEffect:'complete' for a
// synchronized method whose monitor semantics are unrepresented.
{
  const frontend = new DexFrontend();
  const image = parseDex(fixture(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED | ACC_NATIVE));
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  assert.equal(validation.status, 'partial');
  assert.equal(validation.completeness.semanticEffect, 'partial');
  assert.equal(validation.completeness.specValidation, 'partial');
}

// End-to-end: the shared bridge must not publish complete Semantic IR for a
// synchronized native method; the monitor loss must surface as an unknown.
{
  const lowered = lowerVMEffectsToSemanticIr(lift(ACC_PUBLIC | ACC_STATIC | ACC_SYNCHRONIZED | ACC_NATIVE));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === REASON));
}

console.log('[phase11] dex synchronized native monitor regression #7896 passed');
