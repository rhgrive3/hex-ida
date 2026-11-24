import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { scopeAllowsTool, scopeForIntent, ScopeController } from '../js/ai/control/scope.js';
import { claimedAddresses, addressString as runtimeAddressString, stableStringify } from '../js/ai/control/runtime-support.js';
import { normalizeResponse, addressString as renderAddressString, statusText, actionLabel } from '../js/ai/render/normalize.js';
import { buildNoreturnContinuationProposal } from '../js/analysis/discovery/noreturn-refinement.js';
import { evalUnary } from '../js/decompiler/truth/integer.js';
import { validateSemanticSsa } from '../js/semantics/ssa/validate.js';
import { classifySysVAMD64Arguments, classifySysVAMD64FunctionReturn } from '../js/targets/abi/sysv-amd64.js';
import { liftArm64FpEffects } from '../js/targets/architecture/arm64/effects/fp.js';
import { arm64DecodedEncodingWord } from '../js/targets/architecture/arm64/encoding-word.js';
import { canonicalX86ConditionCode } from '../js/targets/architecture/x86_64/effects/flags.js';
import { liftX86ImplicitSignExtensionEffects } from '../js/targets/architecture/x86_64/effects/implicit-sign-extension.js';
import { parseDebuggerArgument, functionAnalysisUiRoute } from '../js/tools.js';
import { TypeStore, structToC, recoverStruct } from '../js/types-legacy.js';
import { compatiblePublishedArtifact } from '../js/core/artifacts/storage/integrity.js';

test('P2-S08-001 & P1-S08-012 & P1-S08-013: AI scope hardening', () => {
  const snap = { currentFunction: { start: 0x1000n, end: 0x1040n } };
  assert.equal(scopeAllowsTool(snap, '__proto__', 'get_disassembly'), false);
  assert.equal(scopeAllowsTool(snap, 'toString', 'get_disassembly'), false);
  assert.equal(scopeAllowsTool(snap, 'binary', 'project_search'), false);
  assert.equal(scopeAllowsTool(snap, 'project', 'project_search'), true);
  assert.equal(scopeForIntent('explain-selection', { selection: { start: 0x1000n } }), 'function');
  assert.equal(scopeForIntent('explain-selection', { selection: { start: 0x1000n, end: 0x1010n } }), 'selection');
  const cyclic = { currentFunction: { start: 0x1000n } };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => new ScopeController(cyclic, 'function'));
});

test('P2-S08-010: stableStringify survives cyclic graphs without stack overflow', () => {
  const a = { addr: '0x1000' };
  a.self = a;
  assert.doesNotThrow(() => stableStringify(a));
});

test('P1-S08-004 & P2-S08-009: AI address normalization and strict parsing', () => {
  const claimed = claimedAddresses('Look at 0x00001000 and 0x00002000');
  assert.ok(claimed.has('0x1000'));
  assert.ok(claimed.has('0x2000'));
  assert.equal(runtimeAddressString(''), null);
  assert.equal(runtimeAddressString('   '), null);
  assert.equal(runtimeAddressString(true), null);
  assert.equal(runtimeAddressString(-1), null);
  assert.equal(runtimeAddressString('0x001000'), '0x1000');
});

test('P1-S03-037 & P2-S03-019: AI render normalize rejects bad addresses and prototype keys', () => {
  assert.equal(renderAddressString(-1), null);
  assert.equal(renderAddressString(true), null);
  assert.equal(renderAddressString(''), null);
  assert.equal(renderAddressString('0x400'), '0x400');
  assert.equal(typeof statusText('constructor'), 'string');
  assert.equal(typeof actionLabel('toString'), 'string');
  const model = normalizeResponse({
    status: 'constructor',
    evidence: [{ address: -1, kind: 'code' }, { address: '0x400', kind: 'code' }],
    actions: [{ kind: 'toString' }],
  });
  assert.equal(model.evidence[0].address, null);
  assert.equal(model.evidence[1].address, '0x400');
});

test('P1-S13-035 & P2-S13-027: noreturn-refinement validates limits strictly', () => {
  const validBinding = { binaryId: 'b', sliceId: 's', architecture: 'arm64' };
  const noopAuth = {
    functionStartAt: () => null, isLocalFunctionStart: () => false, declaredEndOf: () => null,
    callInstructionEnd: () => null, summaryOf: () => null, predecessorProof: () => null,
    isExecutable: () => false, isInstructionBoundary: () => false,
  };
  assert.equal(buildNoreturnContinuationProposal({ binding: validBinding, calls: [], authority: noopAuth, limits: null }).status.stopReason, 'invalid-input');
  assert.equal(buildNoreturnContinuationProposal({ binding: validBinding, calls: [], authority: noopAuth, limits: { maxCandidates: 0 } }).status.stopReason, 'invalid-input');
  assert.equal(buildNoreturnContinuationProposal({ binding: validBinding, calls: [], authority: noopAuth, limits: { maxCandidates: -5 } }).status.stopReason, 'invalid-input');
});

test('P1-S11-013 & P2-S11-009: integrity compatiblePublishedArtifact handles null and optionsHash', () => {
  const recA = { artifactId: 'a', schemaVersion: 1, producerVersion: '1', optionsHash: 'h1' };
  const recB = { artifactId: 'a', schemaVersion: 1, producerVersion: '1', optionsHash: 'h2' };
  assert.equal(compatiblePublishedArtifact(recA, recB, new Uint8Array([1]), new Uint8Array([1])), false);
  assert.equal(compatiblePublishedArtifact(recA, recA, null, null), true);
  assert.equal(compatiblePublishedArtifact(recA, recA, new Uint8Array([1]), null), false);
});

test('P1-S15-020: decompiler truth integer masks value before bool/lnot', () => {
  assert.equal(evalUnary('bool', 0x100n, 8), 0n);
  assert.equal(evalUnary('lnot', 0x100n, 8), 1n);
  assert.equal(evalUnary('bool', 0x101n, 8), 1n);
  assert.equal(evalUnary('lnot', 0x101n, 8), 0n);
});

test('P1-S12-043: validateSemanticSsa guards nullish ssaInput', () => {
  assert.throws(() => validateSemanticSsa(null, {}), TypeError);
});

test('P1-S15-005 & P1-S15-006 & P1-S15-024: SysV AMD64 ABI fixes', () => {
  const argRes = classifySysVAMD64Arguments({
    callPrototype: {
      args: [{
        aggregate: true,
        bits: 96,
        bytes: 12,
        eightbyteClasses: ['INTEGER', 'INTEGER'],
      }],
    },
  });
  assert.equal(argRes.arguments[0].location, 'registers');
  assert.deepEqual(argRes.arguments[0].regs, ['rdi', 'rsi']);

  const retRes = classifySysVAMD64FunctionReturn({
    returnType: 'struct Foo',
    pointer: true,
  });
  assert.equal(retRes.reg, 'rax');
  assert.equal(retRes.indirect, undefined);
});

test('P1-S01-013 & P2-S01-037 & P2-S01-019: ARM64/x86_64 target fixes', () => {
  assert.equal(liftArm64FpEffects({
    mnemonic: 'fadd',
    ops: [{ k: 'reg', cls: 'vec', arr: '4s', num: 0, bits: 128 }],
  }), null);

  assert.equal(arm64DecodedEncodingWord({ bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5, 0x00]) }), null);
  assert.equal(arm64DecodedEncodingWord({ bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]) }), 0xd503201f);

  assert.equal(canonicalX86ConditionCode('constructor'), null);
  assert.equal(canonicalX86ConditionCode('toString'), null);
  assert.equal(liftX86ImplicitSignExtensionEffects({ instructionFamily: 'constructor' }), null);
});

test('P2-S08-013 & P2-S08-008: tools.js parseDebuggerArgument and unsupported route', () => {
  const negHex = parseDebuggerArgument('-0x10');
  assert.equal(negHex.ok, true);
  assert.equal(negHex.value, -16n);
  const route = functionAnalysisUiRoute({ store: { get: () => 'wasm' } });
  assert.equal(route.route, 'unsupported');
});

test('P1-S08-020 & P2-S08-018: types-legacy TypeStore.toC, overlapping cursor, negative offsets', () => {
  const store = new TypeStore();
  assert.equal(store.toC('nonexistent'), '');

  const c = structToC({
    name: 'Overlap',
    members: [
      { offset: 0, size: 16, type: 'uint8[16]', name: 'buf' },
      { offset: 4, size: 4, type: 'uint32', name: 'inner' },
      { offset: 20, size: 4, type: 'uint32', name: 'tail' },
    ],
  });
  assert.ok(c.includes('uint8 pad_10[4];'), `expected pad_10[4] in:\n${c}`);

  const rec = recoverStruct({
    instructions: [
      { row: 0, mnemonic: 'ldr', memory: { base: 'x0', disp: -16, size: 8, kind: 'load' } },
    ],
  }, 'x0');
  assert.equal(rec.members[0].name, 'field_neg_10');
});

test('P1-S08-022: words.js PRFM not classified as LOAD and CMN negates immediate', () => {
  const ctx = { globalThis: {} };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../js/words.js', import.meta.url), 'utf8'), ctx);
  const { Words } = ctx;
  const prfm = 0xf9800000;
  const mem = Words.memoryAccess(prfm);
  assert.equal(mem.prefetch, true);
  assert.equal(mem.load, false);
  assert.equal(mem.store, false);
  assert.equal(Words.classifyWord(prfm), Words.KIND.OTHER);

  assert.equal(Words.compareImmediate(0xf100041f), 1n);
  assert.equal(Words.compareImmediate(0xb100041f), -1n);
});
