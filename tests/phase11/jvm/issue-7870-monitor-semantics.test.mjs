import assert from 'node:assert/strict';
import test from 'node:test';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #7870: explicit `monitorenter`/`monitorexit` carried no acquire/release
// semantics yet published `completeness:'exact'`, and the shared bridge's
// mnemonic substring classifier matched the "or" inside "monitor*" and lowered
// both to complete `binary` nodes. Until a monitor/lock schema exists, the
// bundles must fail closed to partial with an explicit unrepresented-reason,
// the objectref dataflow edge must stay, and the bridge must not classify
// monitor operations as binary.

function buildMonitorFixture(code) {
  const cp = [];
  const u1 = (v) => cp.push(v & 0xff);
  const u2b = (v) => { cp.push((v >> 8) & 0xff, v & 0xff); };
  const u4b = (v) => { cp.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const utf8 = (text) => { u1(1); u2b(text.length); for (const c of new TextEncoder().encode(text)) u1(c); };
  utf8('MonitorFixture');        // 1
  u1(7); u2b(1);                 // 2: Class -> 1
  utf8('f');                     // 3
  utf8('(Ljava/lang/Object;)V'); // 4
  utf8('Code');                  // 5
  const cpCount = 6;
  const classBytes = [];
  const u2 = (v) => { classBytes.push((v >> 8) & 0xff, v & 0xff); };
  const u4 = (v) => { classBytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const push = (...b) => { for (const x of b) classBytes.push(x & 0xff); };
  u4(0xcafebabe); u2(0); u2(61);
  u2(cpCount);
  for (const b of cp) classBytes.push(b);
  u2(0x0021); u2(2); u2(0); u2(0);
  u2(0); // fields
  u2(1); // methods_count
  u2(0x0009); u2(3); u2(4); // public static f(Ljava/lang/Object;)V
  u2(1); u2(5); // one attribute "Code"
  u4(12 + code.length);
  u2(2); u2(1); // maxStack 2, maxLocals 1
  u4(code.length);
  push(...code);
  u2(0); u2(0); // no exception table, no attrs
  u2(0); // class attributes_count
  return new Uint8Array(classBytes);
}

async function decodeFixture(code) {
  const bytes = buildMonitorFixture(code);
  const frontend = new JvmFrontend();
  const image = await frontend.open(bytes, { binaryId: 'monitor-regression-7870' });
  const methods = [];
  for await (const m of frontend.enumerateMethods(image)) methods.push(m);
  const method = methods.find((m) => m.name === 'f');
  const decoded = await frontend.decodeMethod(method, { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  return { decoded, validation, lowered };
}

test('#7870 monitor bundles fail closed to partial with distinct acquire/release reasons', async () => {
  const { decoded } = await decodeFixture([0x2a, 0xc2, 0x2a, 0xc3, 0xb1]);
  const enter = decoded.bundles.find((b) => b.mnemonic === 'monitorenter');
  const exit = decoded.bundles.find((b) => b.mnemonic === 'monitorexit');
  assert.equal(enter.completeness, 'partial');
  assert.equal(exit.completeness, 'partial');
  assert.deepEqual(
    enter.unknownEffects.map((u) => u.reason),
    ['jvm-monitor-acquire-semantics-unrepresented'],
  );
  assert.deepEqual(
    exit.unknownEffects.map((u) => u.reason),
    ['jvm-monitor-release-semantics-unrepresented'],
  );
  // The consumed objectref stays the monitor-identity dataflow edge.
  assert.equal(enter.consumedValues.length, 1);
  assert.equal(exit.consumedValues.length, 1);
});

test('#7870 the function no longer advertises exact/complete monitor semantics', async () => {
  const { decoded, validation } = await decodeFixture([0x2a, 0xc2, 0x2a, 0xc3, 0xb1]);
  assert.equal(decoded.aggregateCompleteness, 'partial');
  assert.equal(validation.completeness.semanticEffect, 'partial');
});

test('#7870 the bridge does not classify monitor operations as binary', async () => {
  const { lowered } = await decodeFixture([0x2a, 0xc2, 0x2a, 0xc3, 0xb1]);
  const monitorNodes = lowered.semanticIr.nodes.filter((n) => n.metadata?.mnemonic?.startsWith('monitor'));
  assert.equal(monitorNodes.length, 2);
  for (const node of monitorNodes) {
    assert.equal(node.kind, 'barrier');
    assert.equal(node.completeness, 'partial');
    // Monitor object identity stays on the node inputs (the objectref).
    assert.equal(node.inputs.length, 1);
  }
  assert.equal(lowered.semanticIr.completeness, 'partial');
});

test('#7870 methods without monitor operations keep exact semantics', async () => {
  const { decoded, validation, lowered } = await decodeFixture([0xb1]); // return
  assert.equal(decoded.aggregateCompleteness, 'exact');
  assert.equal(validation.completeness.semanticEffect, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});
