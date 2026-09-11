import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

function bundle(methodId, bytecodeOffset, input) {
  return createVMEffectBundle({
    frontendId: 'dex',
    methodId,
    operationId: createVMOperationId(methodId, bytecodeOffset),
    bytecodeOffset,
    completeness: 'exact',
    ...input,
  });
}

function decompile(bundles, suffix) {
  const methodId = createManagedMethodId(`issue-4025-${suffix}`, 'm');
  const rewritten = bundles(methodId);
  const fn = createVMEffectFunction({
    frontendId: 'dex',
    methodId,
    bundles: rewritten,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  return { lowered, out: decompileManagedMethod(fn) };
}

test('unconditional forward branch stays explicit and targets a rendered label', () => {
  const { lowered, out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 4 }],
    }),
    bundle(methodId, 2, {
      mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 123 }],
    }),
    bundle(methodId, 4, {
      mnemonic: 'return-void',
      controlEffects: [{ kind: 'return' }],
    }),
  ], 'forward');

  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'branch');
  assert.ok(branch, 'production lowering must preserve the unconditional branch node');
  assert.deepEqual(branch.targets, ['bb_0x4']);

  const body = out.decompiledAst.body;
  const gotoIndex = body.findIndex((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x4;');
  const skippedIndex = body.findIndex((stmt) => stmt.kind === 'assign');
  const labelIndex = body.findIndex((stmt) => stmt.kind === 'label' && stmt.text === 'bb_0x4:');

  assert.ok(gotoIndex >= 0, 'unconditional branch must not disappear from pseudocode');
  assert.ok(labelIndex >= 0, 'goto target must have a rendered label');
  assert.ok(skippedIndex > gotoIndex && skippedIndex < labelIndex,
    'layout-only block may be printed, but it must remain skipped by the explicit goto');
  assert.match(out.pseudocode, /goto bb_0x4;[\s\S]*0x7B[\s\S]*bb_0x4:/);

  assert.ok(body[gotoIndex].source, 'goto must retain branch provenance for source mapping');
  assert.ok(body[labelIndex].source, 'target label must retain block provenance for source mapping');
});

test('backward branch keeps a concrete target label instead of falling through', () => {
  const { out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 2 }],
    }),
    bundle(methodId, 2, {
      mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 7 }],
    }),
    bundle(methodId, 4, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 2 }],
    }),
  ], 'backward');

  assert.ok(out.decompiledAst.body.some((stmt) => stmt.kind === 'label' && stmt.text === 'bb_0x2:'));
  assert.ok(out.decompiledAst.body.filter((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x2;').length >= 2);
});

test('conditional branch rendering remains intact', () => {
  const { out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 1 }],
    }),
    bundle(methodId, 2, {
      mnemonic: 'if-nez',
      consumedValues: [{ id: 'cond', bits: 32 }],
      controlEffects: [{ kind: 'conditional-branch', targetOffset: 6 }],
    }),
    bundle(methodId, 4, {
      mnemonic: 'return-void',
      controlEffects: [{ kind: 'return' }],
    }),
    bundle(methodId, 6, {
      mnemonic: 'return-void',
      controlEffects: [{ kind: 'return' }],
    }),
  ], 'conditional');

  assert.ok(out.decompiledAst.body.some((stmt) => stmt.kind === 'if'));
  assert.ok(out.decompiledAst.body.some((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x6;'));
  assert.ok(out.pseudocode.includes('if'));
});

test('branch over a side-effecting call keeps the call behind the target transfer', () => {
  const { out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 4 }],
    }),
    bundle(methodId, 2, {
      mnemonic: 'invoke-static',
      callEffects: [{ target: 'LLogger;->side_effect()V', dispatchKind: 'direct', unresolved: false }],
    }),
    bundle(methodId, 4, {
      mnemonic: 'return-void',
      controlEffects: [{ kind: 'return' }],
    }),
  ], 'call-skip');

  const body = out.decompiledAst.body;
  const gotoIndex = body.findIndex((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x4;');
  const callIndex = body.findIndex((stmt) => stmt.kind === 'call_stmt' && stmt.text.includes('side_effect'));
  const labelIndex = body.findIndex((stmt) => stmt.kind === 'label' && stmt.text === 'bb_0x4:');
  assert.ok(gotoIndex >= 0 && callIndex > gotoIndex && labelIndex > callIndex);
});

test('branch over a trap keeps the trap behind the target transfer', () => {
  const { out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 4 }],
    }),
    bundle(methodId, 2, {
      mnemonic: 'trap',
      controlEffects: [{ kind: 'trap' }],
    }),
    bundle(methodId, 4, {
      mnemonic: 'return-void',
      controlEffects: [{ kind: 'return' }],
    }),
  ], 'trap-skip');

  const body = out.decompiledAst.body;
  const gotoIndex = body.findIndex((stmt) => stmt.kind === 'goto' && stmt.text === 'goto bb_0x4;');
  const trapIndex = body.findIndex((stmt) => stmt.kind === 'trap');
  const labelIndex = body.findIndex((stmt) => stmt.kind === 'label' && stmt.text === 'bb_0x4:');
  assert.ok(gotoIndex >= 0 && trapIndex > gotoIndex && labelIndex > trapIndex);
});

test('unresolved unconditional control does not fabricate a concrete goto target', () => {
  const { lowered, out } = decompile((methodId) => [
    bundle(methodId, 0, {
      mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: null }],
    }),
  ], 'unresolved');

  assert.equal(lowered.semanticIr.nodes.some((node) => node.kind === 'branch'), false);
  assert.equal(lowered.semanticIr.nodes.some((node) => node.kind === 'unknown-control-effect'), true);
  assert.equal(out.decompiledAst.body.some((stmt) => stmt.kind === 'goto'), false);
});
