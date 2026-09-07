import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { classifyMachineEffectsCoverage } from '../../js/targets/architecture/coverage.js';

let sequence = 0;

function exactBundle(architectureId, mode, instructionId) {
  return createMachineEffectBundle({
    instructionId,
    architectureId,
    mode,
    operations:[{ kind:'barrier', scope:{ kind:'coverage-test' } }],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:[],
    origin:{ instructionIds:[instructionId] },
    completeness:'exact',
  });
}

function coveragePlugin(id, bundleArchitectureId = id) {
  let liftCalls = 0;
  return {
    plugin:{
      id,
      semanticVersion:'issue-5442',
      modes:() => ['a64'],
      capabilities:{ exactEffects:'available' },
      liftExact(decoded, context) {
        liftCalls += 1;
        const instructionId = String(context?.instructionId ?? decoded?.instructionId ?? `issue-5442-${++sequence}`);
        return exactBundle(bundleArchitectureId, 'a64', instructionId);
      },
    },
    liftCalls:() => liftCalls,
  };
}

function classify(plugin, architecture, { field = 'architecture', context = false } = {}) {
  const instructionId = `issue-5442-${++sequence}`;
  const decoded = { instructionId };
  const executionContext = { instructionId };
  if (context) executionContext[field] = architecture;
  else decoded[field] = architecture;
  return classifyMachineEffectsCoverage(plugin, decoded, executionContext);
}

{
  const state = coveragePlugin('arm64');
  assert.equal(classify(state.plugin, 'arm64').status, 'covered');
  assert.equal(classify(state.plugin, ' ARM64 ').status, 'covered');
  assert.equal(classify(state.plugin, 'ARM64', { field:'architectureId' }).status, 'covered');
  assert.equal(state.liftCalls(), 3);
}

for (const malformed of [
  ['arm64'],
  { toString:() => 'arm64' },
  64,
  true,
]) {
  const state = coveragePlugin('arm64');
  const result = classify(state.plugin, malformed);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-input-architecture-mismatch');
  assert.equal(state.liftCalls(), 0, 'malformed architecture identity must be rejected before liftExact');
}

{
  const state = coveragePlugin('arm64');
  const result = classify(state.plugin, ['arm64'], { field:'architectureId', context:true });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'machine-effects-input-architecture-mismatch');
  assert.equal(state.liftCalls(), 0, 'structured context architecture identity must not reach liftExact');
}

{
  const state = coveragePlugin('arm64');
  const result = classify(state.plugin, 'ARM64', { field:'architecture', context:true });
  assert.equal(result.status, 'covered');
  assert.equal(state.liftCalls(), 1);
}

{
  const state = coveragePlugin('arm64e', 'arm64');
  assert.equal(classify(state.plugin, 'arm64e').status, 'covered');
  assert.equal(classify(state.plugin, 'arm64').status, 'covered');
  assert.equal(state.liftCalls(), 2, 'ARM64e delegation to canonical ARM64 bundles must remain supported');
}

console.log('issue #5442 machine-effects coverage architecture identity: PASS');
