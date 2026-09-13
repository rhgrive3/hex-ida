import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
} from '../../../js/managed/index.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import {
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/shared/bridge-v2.js';

function jvmLocalStore() {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'LocalStore',
    constantPool: [null],
    fields: [],
    methods: [{
      accessFlags: 0x0008,
      name: 'f',
      descriptor: '()I',
      code: {
        maxStack: 1,
        maxLocals: 1,
        bytecode: Uint8Array.from([0x04, 0x3b, 0x1a, 0xac]), // iconst_1; istore_0; iload_0; ireturn
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  };
}

function dexRegisterFlow({ branch = false } = {}) {
  const methodId = createManagedMethodId(`issue-8065-dex-${branch ? 'branch' : 'straight'}`, 0, 'f');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'dex',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  const bundles = branch
    ? [
        bundle(0, { mnemonic: 'goto', controlEffects: [{ kind: 'branch', targetOffset: 4 }] }),
        bundle(2, { mnemonic: 'const/4', locationWrites: [{ kind: 'register', index: 0, bits: 32 }], producedValues: [{ bits: 32, constant: 9 }] }),
        bundle(4, { mnemonic: 'const/4', locationWrites: [{ kind: 'register', index: 0, bits: 32 }], producedValues: [{ bits: 32, constant: 7 }] }),
        bundle(6, { mnemonic: 'return', locationReads: [{ kind: 'register', index: 0, bits: 32 }], controlEffects: [{ kind: 'return' }] }),
      ]
    : [
        bundle(0, { mnemonic: 'const/4', locationWrites: [{ kind: 'register', index: 0, bits: 32 }], producedValues: [{ bits: 32, constant: 7 }] }),
        bundle(2, { mnemonic: 'return', locationReads: [{ kind: 'register', index: 0, bits: 32 }], controlEffects: [{ kind: 'return' }] }),
      ];
  return createVMEffectFunction({
    methodId,
    frontendId: 'dex',
    bundles,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
}

function wasmLocalFlow() {
  const methodId = createManagedMethodId('issue-8065-wasm', 0, 'f');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  return createVMEffectFunction({
    methodId,
    frontendId: 'wasm',
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, { mnemonic: 'i32.const', locationWrites: [{ kind: 'local', index: 0, bits: 32 }], producedValues: [{ bits: 32, constant: 5 }] }),
      bundle(1, { mnemonic: 'return', locationReads: [{ kind: 'local', index: 0, bits: 32 }], controlEffects: [{ kind: 'return' }] }),
    ],
  });
}

function cilLocalFlow() {
  const methodId = createManagedMethodId('issue-8065-cil', 0, 'f');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'cil',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  return createVMEffectFunction({
    methodId,
    frontendId: 'cil',
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, { mnemonic: 'ldc.i4.7', producedValues: [{ bits: 32, constant: 7 }] }),
      bundle(1, { mnemonic: 'stloc.0', consumedValues: [{ id: 'value', bits: 32 }], locationWrites: [{ kind: 'local', index: 0, bits: 32 }] }),
      bundle(2, { mnemonic: 'ldloc.0', locationReads: [{ kind: 'local', index: 0, bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(3, { mnemonic: 'ret', consumedValues: [{ id: 'value', bits: 32 }], controlEffects: [{ kind: 'return' }] }),
    ],
  });
}

test('#8065 JVM local state-write/state-read/copy survives into pseudocode', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftJvmMethod(0, jvmLocalStore()));
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'state-write' && node.variable?.physicalIdentity === 'local:0'));
  assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'state-read' && node.variable?.physicalIdentity === 'local:0'));
  assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'copy'));

  const out = decompileManagedMethod(lowered).pseudocode;
  assert.match(out, /local_0 = 1;/, 'the canonical local assignment must not disappear');
  assert.match(out, /return local_0;/, 'copy(state-read(local_0)) must preserve the input expression identity');
  assert.doesNotMatch(out, /return value_[0-9a-f]+;/, 'the return must not reference an undefined copy output');
});

test('#8065 DEX register state uses one logical identifier for write and read', () => {
  const lowered = lowerVMEffectsToSemanticIr(dexRegisterFlow());
  const out = decompileManagedMethod(lowered).pseudocode;
  assert.match(out, /register_0 = 7;/);
  assert.match(out, /return register_0;/);
});


test('#8065 Wasm local state renders while bridge-internal stack snapshots stay hidden', () => {
  const lowered = lowerVMEffectsToSemanticIr(wasmLocalFlow());
  assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'state-write' && node.variable?.key === 'vm:wasm:stack:0'),
    'the lowerer should still retain its canonical stack checkpoint');
  const out = decompileManagedMethod(lowered).pseudocode;
  assert.match(out, /local_0 = 5;/);
  assert.match(out, /return local_0;/);
  assert.doesNotMatch(out, /stack_0\s*=/, 'bridge-internal operand-stack checkpoints are not source assignments');
  assert.ok(out.indexOf('return local_0;') === out.trimEnd().lastIndexOf('return local_0;'), 'the return remains terminal in rendered pseudocode');
});

test('#8065 CIL copy preserves its state-read input instead of fabricating an identifier', () => {
  const lowered = lowerVMEffectsToSemanticIr(cilLocalFlow());
  assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'copy'));
  const out = decompileManagedMethod(lowered).pseudocode;
  assert.match(out, /local_0 = 7;/);
  assert.match(out, /return local_0;/);
  assert.doesNotMatch(out, /return value_[0-9a-f]+;/);
});

test('#8065 state writes stay at their CFG block location across an explicit branch', () => {
  const out = decompileManagedMethod(lowerVMEffectsToSemanticIr(dexRegisterFlow({ branch: true })));
  const body = out.decompiledAst.body;
  const gotoIndex = body.findIndex((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x4;');
  const skippedWrite = body.findIndex((stmt) => stmt.kind === 'state-write' && stmt.text === 'register_0 = 9;');
  const targetLabel = body.findIndex((stmt) => stmt.kind === 'label' && stmt.text === 'bb_0x4:');
  const targetWrite = body.findIndex((stmt) => stmt.kind === 'state-write' && stmt.text === 'register_0 = 7;');
  assert.ok(gotoIndex >= 0 && skippedWrite > gotoIndex && targetLabel > skippedWrite && targetWrite > targetLabel,
    'state assignments must remain in their canonical block order instead of being propagated globally');
});

test('#8065 incomplete state/copy nodes fail closed instead of asserting a definitive alias', () => {
  const lowered = lowerVMEffectsToSemanticIr(dexRegisterFlow());
  const nodes = lowered.semanticIr.nodes.map((node) => {
    if (node.kind !== 'state-write' && node.kind !== 'state-read' && node.kind !== 'copy') return node;
    return {
      ...node,
      completeness: 'partial',
      unknown: { code: 'issue-8065-adversarial', reason: 'test-only incomplete state relation' },
    };
  });
  const adversarial = {
    ...lowered,
    semanticIr: { ...lowered.semanticIr, nodes },
  };
  const out = decompileManagedMethod(adversarial).pseudocode;
  assert.match(out, /unsupported_state_write\(7\);/);
  assert.match(out, /return unsupported_state_read\(\);/);
  assert.doesNotMatch(out, /register_0 = 7;/, 'partial state authority must not be upgraded into a definitive assignment');

  const cil = lowerVMEffectsToSemanticIr(cilLocalFlow());
  const cilNodes = cil.semanticIr.nodes.map((node) => node.kind === 'copy'
    ? { ...node, completeness: 'partial', unknown: { code: 'issue-8065-adversarial-copy', reason: 'test-only incomplete copy relation' } }
    : node);
  const cilOut = decompileManagedMethod({ ...cil, semanticIr: { ...cil.semanticIr, nodes: cilNodes } }).pseudocode;
  assert.match(cilOut, /return unsupported_copy\(local_0\);/);
});
