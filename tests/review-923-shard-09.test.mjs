import test from 'node:test';
import assert from 'node:assert/strict';

import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
const rewriteExpression = (n) => new RewriteEngine(DEFAULT_RULES).rewrite(n);
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression, exprIsPointerTyped } from '../js/decompiler/pretty/c.js';
import { evaluateExpression, verifyRewrite, verifyWithFunctionSandbox } from '../js/decompiler/verify/equivalence.js';
import { ARM64_ARCHITECTURE } from '../js/targets/architecture/index.js';
import { riscv64RegisterDescriptor } from '../js/targets/architecture/riscv64/registers.js';
import { classifyAAPCS64FunctionReturn } from '../js/targets/abi/aapcs64-core.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor-base.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { assertWireBudget } from '../js/ai/budget/wire.js';
import { stableDigest, stableDigestBytes } from '../js/core/identity/index.js';
import { encodeWireValue, decodeWireValue } from '../js/debug/remote-protocol.js';
import { BinaryImage } from '../js/binary/model.js';
import { retainElfLoaderEntryExtents } from '../js/binary/elf-loader-entry-extent.js';
import { demangleCxx, shortName } from '../js/rtti.js';
import { explain } from '../js/evidence.js';
import { bytesHex, bytesAscii, sizeText } from '../js/format.js';
import { canonicalThresholdComparison, semanticFacts } from '../js/semantic.js';
import { mergeGlobals } from '../js/ui/tools/globals.js';
import { awaitCancellableProducer } from '../js/cache/artifact-orchestration.js';

test('rules.js: redundant-trunc/zext/sext fail closed on unknown width and compare-self-eq-ne requires integer domain', () => {
  const xUnknown = { kind: 'var', name: 'x', bits: null };
  const truncNull = { kind: 'unary', op: 'trunc', arg: xUnknown, bits: null };
  const outTrunc = rewriteExpression(truncNull);
  assert.equal(outTrunc.root.kind, 'unary', 'null-width trunc must not be stripped');

  const x64 = expr.variable('x', 64);
  const cmpUnknown = { kind: 'compare', op: 'eq', left: x64, right: x64, bits: 1 };
  const outCmp = rewriteExpression(cmpUnknown);
  assert.equal(outCmp.root.kind, 'compare', 'unknown comparisonDomain must not fold x == x');

  const cmpInt = { kind: 'compare', op: 'eq', left: x64, right: x64, bits: 1, comparisonDomain: 'integer' };
  const outCmpInt = rewriteExpression(cmpInt);
  assert.equal(outCmpInt.root.kind, 'const');
  assert.equal(outCmpInt.root.value, 1n);
});

test('pretty/c.js: msub emits args[2] - args[0] * args[1] and exprIsPointerTyped handles deep shared DAG', () => {
  const node = expr.intrinsic('msub', [expr.variable('xn', 64), expr.variable('xm', 64), expr.variable('xa', 64)], 64);
  const printed = printExpression(node, 0, {});
  assert.equal(printed, 'xa - xn * xm');

  // Build depth-40 diamond DAG (2^40 paths without memoization)
  let cur = expr.variable('v', 64);
  for (let i = 0; i < 40; i++) {
    cur = { kind: 'select', condition: expr.variable('c', 1), whenTrue: cur, whenFalse: cur, bits: 64 };
  }
  const t0 = Date.now();
  assert.equal(exprIsPointerTyped(cur, []), false);
  assert.ok(Date.now() - t0 < 500, 'diamond DAG must complete quickly with memoization');
});

test('equivalence.js: prototype keys, huge bit_extract shift, undefined bits min/max, BigInt sandbox output', async () => {
  const protoVar = expr.variable('toString', 64);
  assert.equal(evaluateExpression(protoVar, {}), null);

  const hugeShift = expr.intrinsic('bit_extract', [expr.constant(0xffn, 64), expr.constant(0xffffffffffffffffn, 64), expr.constant(8n, 64)], 64);
  assert.equal(evaluateExpression(hugeShift, {}), null);

  const minNoBits = { kind: 'intrinsic', name: 'min', args: [expr.constant(10n, 64), expr.constant(5n, 64)], signed: true };
  assert.equal(evaluateExpression(minNoBits, {}), 5n);

  const a = expr.compare('lt', expr.variable('x', 64), expr.variable('y', 64), true);
  const b = expr.compare('le', expr.variable('x', 64), expr.variable('y', 64), true);
  const res = verifyRewrite(a, b);
  assert.equal(res.equivalent, false, 'x < y vs x <= y must catch x === y counterexample');

  const sb = await verifyWithFunctionSandbox({ execute: async (fn) => ({ v: fn }) }, 1n, 1n, [{}]);
  assert.equal(sb.equivalent, true);
});

test('targets/architecture: PAC fail-closed on pacEnabled==null, HINT NOPs, bc.al/bc.nv, callTarget, cyclic riscv64', () => {
  const paciasp = { instructionId: 'i1', mnemonic: 'paciasp', mode: 'a64', ops: [] };
  const unresolved = ARM64_ARCHITECTURE.liftExact(paciasp, { pacRequested: true, pacEnabled: null });
  assert.equal(unresolved.completeness, 'partial');

  const xpaclri = { mnemonic: 'xpaclri', mode: 'a64', ops: [] };
  const nopBundle = ARM64_ARCHITECTURE.liftExact(xpaclri, { pacEnabled: false });
  assert.equal(nopBundle.completeness, 'exact');
  assert.ok(nopBundle.origin.instructionIds[0] !== undefined);

  assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'bc.al' }), 'branch');
  assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic: 'bc.nv' }), 'branch');
  assert.equal(ARM64_ARCHITECTURE.directControlTarget({ mnemonic: 'bl', callTarget: 0x1000n }), 0x1000n);

  const cyc = {};
  cyc.id = cyc;
  assert.equal(riscv64RegisterDescriptor(cyc), null);
});

test('aapcs64-core: normalized variant_pcs and >16-byte padded aggregate indirect return', () => {
  const variant = classifyAAPCS64FunctionReturn({ callingConvention: '__AARCH64_VARIANT_PCS' });
  assert.equal(variant.unsupported, true);

  const padded24 = {
    returnType: 'struct Padded24',
    aggregate: true,
    returnBits: 72,
    layout: {
      bits: 72,
      bytes: 24,
      members: [{ bits: 64, bytes: 8, byteOffset: 0 }, { bits: 8, bytes: 1, byteOffset: 8 }],
      padding: [{ byteOffset: 9, bytes: 15 }],
    },
  };
  const ret = classifyAAPCS64FunctionReturn({ functionPrototype: padded24 });
  assert.equal(ret.indirect, true);
});

test('AI catalog/executor/settings/wire: function runtimePlatform fail-closed, address validation, identity value eq, wire budget', async () => {
  const catalog = createCapabilityCatalog();
  const list = catalog.list({ runtimePlatform: () => null });
  const memRead = list.find((e) => e.id === 'runtime.memory-read');
  assert.equal(memRead.available.ok, false);

  const executor = new CapabilityExecutor({ catalog });
  await assert.rejects(
    () => executor.execute('annotation.comment', { address: '   ', value: 'hi' }),
    (err) => err?.type === 'invalid_tool_call',
  );

  let emits = 0;
  const settings = new DevAgentUiSettings();
  settings.on(() => { emits++; });
  settings.profiles();
  settings.profiles();
  assert.equal(emits, 0, 'profiles() must not spuriously emit when identity is unchanged');

  assert.throws(
    () => assertWireBudget({ messages: [] }, { contextTokens: 1000, maxOutputTokens: 1000, maxRequestBytes: 65536 }),
    (err) => err?.type === 'context_too_large',
  );
});

test('core/identity, debug/remote-protocol, cache/artifact-orchestration', async () => {
  assert.throws(() => stableDigestBytes(new Uint8Array([1, 2, 3]), NaN, 2));
  assert.throws(() => stableDigestBytes(new Uint8Array([1, 2, 3]), 0, NaN));

  assert.throws(
    () => decodeWireValue({ ...encodeWireValue(1n), value: '9'.repeat(300) }),
    /invalid bigint wire value/,
  );

  const ac = new AbortController();
  ac.abort(new Error('pre-aborted'));
  const rejectingOp = Promise.reject(new Error('late-failure'));
  await assert.rejects(() => awaitCancellableProducer(rejectingOp, ac.signal));
});

test('binary/model, elf-loader-entry-extent, rtti, evidence, format, semantic, globals', () => {
  const img = new BinaryImage(new Uint8Array(16), { format: 'elf', arch: 'arm64', endian: 'little' });
  img.bytes = null;
  img.symbols.push({ name: 'a', address: 0x2000n }, { name: 'tls', address: null }, { name: 'b', address: 0x1000n });
  img.finalize();
  assert.deepEqual(img.symbols.map((s) => s.name), ['b', 'a', 'tls']);

  // Cyclic metadata in toJSON must not throw RangeError
  const cyc = {};
  cyc.self = cyc;
  img.metadata.cyc = cyc;
  assert.equal(img.toJSON().metadata.cyc.self, '[Circular]');

  // retainElfLoaderEntryExtents with null bytes must not throw TypeError
  assert.equal(retainElfLoaderEntryExtents(img), img);

  // rtti: substitution bomb bounded & operator< preserved in shortName
  const bomb = '_Z1fI1A' + 'S0_'.repeat(40) + 'Ev';
  assert.doesNotThrow(() => demangleCxx(bomb));
  assert.equal(shortName('_ZN3Foo10operatortrEv'), 'Foo::operatortr');
  assert.equal(shortName('_ZN3FoolsEi'), 'Foo::operator<<');

  // evidence & format boundaries
  assert.deepEqual(explain({}), []);
  assert.equal(bytesHex(new Uint8Array([0xaa, 0xbb]), 1, 5), 'BB');
  assert.equal(bytesAscii(new Uint8Array([0x41, 0x42]), 1, 5), 'B');
  assert.ok(!sizeText(NaN).includes('undefined'));

  // semantic.js prototype safety & cache isolation
  assert.equal(canonicalThresholdComparison({ value: { id: 1 }, other: { const: 5n }, cond: 'toString' }), null);
  const ir = { instructions: [], values: [], blocks: [] };
  const f1 = semanticFacts(ir);
  f1.push({ synthetic: true });
  const f2 = semanticFacts(ir);
  assert.equal(f2.length, 0);

  // mergeGlobals dedupe & BigInt normalization
  const merged = mergeGlobals([{ addr: 0x1000, name: 'g1' }, { addr: 0x1000n, name: 'g1_dup' }], null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].addr, 0x1000n);
});
