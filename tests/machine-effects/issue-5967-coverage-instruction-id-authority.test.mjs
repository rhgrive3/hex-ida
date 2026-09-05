import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { classifyMachineEffectsCoverage } from '../../js/targets/architecture/coverage.js';

function bundle(instructionId = 'sample:1', completeness = 'exact', architectureId = 'arm64') {
  return createMachineEffectBundle({
    instructionId,
    architectureId,
    mode:'a64',
    operations:[{ kind:'barrier', scope:{ kind:'issue-5967' } }],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:{ instructionIds:[instructionId] },
    completeness,
  });
}

function pluginFor(effectBundle, id = 'arm64') {
  return {
    id,
    semanticVersion:'issue-5967',
    modes:() => ['a64'],
    capabilities:{ exactEffects:'available' },
    liftExact:() => effectBundle,
  };
}

function classifyExpected(expected, { context = false, effectBundle = bundle() } = {}) {
  const decoded = context ? { instructionId:'sample:1' } : { instructionId:expected };
  const executionContext = context ? { instructionId:expected } : {};
  return classifyMachineEffectsCoverage(pluginFor(effectBundle), decoded, executionContext);
}

{
  const result = classifyExpected('sample:1');
  assert.equal(result.status, 'covered');
  assert.equal(result.exact, true);
  assert.equal(result.instructionId, 'sample:1');
}

{
  const result = classifyExpected('  sample:1  ');
  assert.equal(result.status, 'covered', 'primitive string identity keeps canonical whitespace normalization');
}

{
  const result = classifyExpected('sample:2');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-bundle-instruction-mismatch');
  assert.equal(result.expected, 'sample:2');
  assert.equal(result.observed, 'sample:1');
}

for (const malformed of [
  ['sample:1'],
  1,
  true,
  '   ',
]) {
  const result = classifyExpected(malformed);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-bundle-instruction-mismatch');
  assert.equal(result.expected, null);
  assert.equal(result.observed, 'sample:1');
}

{
  let coercions = 0;
  const structured = {
    toString() {
      coercions += 1;
      return 'sample:1';
    },
  };
  const result = classifyExpected(structured);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-bundle-instruction-mismatch');
  assert.equal(result.expected, null);
  assert.equal(coercions, 0, 'structured instruction identity must never be coerced');
}

{
  const hostile = { toString() { throw new Error('must-not-coerce'); } };
  const result = classifyExpected(hostile);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-bundle-instruction-mismatch');
}

{
  const result = classifyExpected(['sample:1'], { context:true });
  assert.equal(result.status, 'error', 'structured context instructionId must not be laundered over a valid decoded identity');
  assert.equal(result.reason, 'machine-effects-bundle-instruction-mismatch');
}

{
  const result = classifyMachineEffectsCoverage(pluginFor(bundle()), {}, {});
  assert.equal(result.status, 'covered', 'absence of an expected instruction identity preserves existing coverage behavior');
}

{
  const partial = classifyExpected('sample:1', { effectBundle:bundle('sample:1', 'partial') });
  assert.equal(partial.status, 'covered');
  assert.equal(partial.exact, false);

  const unknown = classifyExpected('sample:1', { effectBundle:bundle('sample:1', 'unknown') });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.exact, false);
}

{
  const delegated = classifyMachineEffectsCoverage(
    pluginFor(bundle('sample:1', 'exact', 'arm64'), 'arm64e'),
    { instructionId:'sample:1', architectureId:'arm64e' },
    {},
  );
  assert.equal(delegated.status, 'covered', 'ARM64e delegation to canonical ARM64 bundles must remain supported');
}

console.log('issue #5967 coverage instruction-id authority: PASS');
