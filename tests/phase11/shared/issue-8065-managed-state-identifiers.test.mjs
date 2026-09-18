import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
} from '../../../js/managed/index.js';
import {
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/shared/bridge-v2.js';

function stateFlow(kind) {
  const methodId = createManagedMethodId(`issue-8065-${kind}`, 0, 'f');
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
      bundle(0, {
        mnemonic: 'const',
        producedValues: [{ bits: 32, constant: 7 }],
        locationWrites: [{ kind, index: 0, bits: 32 }],
      }),
      bundle(1, {
        mnemonic: 'return',
        locationReads: [{ kind, index: 0, bits: 32 }],
        controlEffects: [{ kind: 'return' }],
      }),
    ],
  });
}

for (const kind of ['static-field', 'array-element', 'linear-memory']) {
  test(`#8065 ${kind} state identity is injective and identifier-safe`, () => {
    const out = decompileManagedMethod(lowerVMEffectsToSemanticIr(stateFlow(kind))).pseudocode;
    const assignment = out.match(/^\s*(state_[^\s=]+)\s*=\s*7;/m);
    const returned = out.match(/return\s+([^;]+);/);
    assert.ok(assignment, `missing ${kind} assignment: ${out}`);
    assert.ok(returned, `missing ${kind} return: ${out}`);
    assert.equal(returned[1], assignment[1], 'write/read must render the same canonical state identifier');
    assert.doesNotMatch(assignment[1], /-/, 'hyphenated VM location kind must not leak as subtraction syntax');
    assert.match(assignment[1], /^state_[A-Za-z0-9$]+$/, 'encoded state name must use the bridge identifier alphabet');
  });
}
