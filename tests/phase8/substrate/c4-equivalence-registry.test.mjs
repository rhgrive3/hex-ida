import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C4_EQUIVALENCE_REWRITE_REGISTRY,
  C4_EQUIVALENCE_REWRITE_REGISTRY_VERSION,
  c4EquivalenceRewriteRegistryFailure,
  c4EquivalenceRewriteRule,
} from '../../../js/decompiler/phase8/c4-equivalence-registry.js';
import {
  MEMORY_REWRITE_VALIDATION_VERIFIER,
  TERMINAL_EFFECT_REWRITE_VALIDATION_VERIFIER,
  validateMemoryRewriteAdoption,
  validateTerminalEffectRewriteAdoption,
} from '../../../js/decompiler/phase8/pass-validation.js';

const kinds=['memory-byte-rewrite','cfg-rewrite','bounded-loop-rewrite','terminal-control-effect-rewrite'];

test('C4-04B memory/CFG rewrite registry is an exact four-family denominator',()=>{
  assert.equal(C4_EQUIVALENCE_REWRITE_REGISTRY_VERSION,'hex.phase8.c4-equivalence-registry/1');
  assert.deepEqual(C4_EQUIVALENCE_REWRITE_REGISTRY.map(row=>row.kind),kinds);
  assert.equal(new Set(C4_EQUIVALENCE_REWRITE_REGISTRY.map(row=>row.kind)).size,kinds.length);
  for(const row of C4_EQUIVALENCE_REWRITE_REGISTRY){
    assert.equal(Object.isFrozen(row),true);
    assert.equal(Object.isFrozen(row.observables),true);
    assert.ok(row.observables.length>0);
    assert.equal(c4EquivalenceRewriteRule(row.kind),row);
    assert.equal(c4EquivalenceRewriteRegistryFailure(row.kind,row.verifier),null);
  }
});

test('C4-04B registry prevents cross-verifier or undeclared rewrite authority',async()=>{
  assert.equal(c4EquivalenceRewriteRegistryFailure('cfg-rewrite',TERMINAL_EFFECT_REWRITE_VALIDATION_VERIFIER),'phase8-c4-rewrite-verifier-mismatch');
  assert.equal(c4EquivalenceRewriteRegistryFailure('terminal-control-effect-rewrite',MEMORY_REWRITE_VALIDATION_VERIFIER),'phase8-c4-rewrite-verifier-mismatch');
  assert.equal(c4EquivalenceRewriteRegistryFailure('future-rewrite',MEMORY_REWRITE_VALIDATION_VERIFIER),'phase8-c4-rewrite-kind-unregistered');
  await assert.rejects(
    validateMemoryRewriteAdoption({passId:'p',passVersion:'1',transformKind:'terminal-control-effect-rewrite',targets:['x'],rewrite:{before:1,after:1},memoryRequest:{}}),
    /phase8-c4-rewrite-verifier-mismatch/,
  );
  await assert.rejects(
    validateTerminalEffectRewriteAdoption({passId:'p',passVersion:'1',transformKind:'cfg-rewrite',targets:['x'],rewrite:{before:1,after:1},effectRequest:{}}),
    /phase8-c4-rewrite-verifier-mismatch/,
  );
  await assert.rejects(
    validateMemoryRewriteAdoption({passId:'p',passVersion:'1',transformKind:'future-rewrite',targets:['x'],rewrite:{before:1,after:1},memoryRequest:{}}),
    /phase8-c4-rewrite-kind-unregistered/,
  );
});
