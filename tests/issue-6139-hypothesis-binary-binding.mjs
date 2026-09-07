// Regression for #6139: verifyHypothesis() injected the active session's
// binaryHash as compileExperiment()'s preferred options.binaryHash, so a
// hypothesis explicitly bound to bin-A was silently re-bound to the active
// session's bin-B and the runExperiment() binary-version-mismatch guard never
// fired. The mismatch now fails closed before compilation; unbound
// hypotheses keep inheriting the session identity.
import assert from 'node:assert/strict';
import { RuntimeAnalysisPlatform } from '../js/runtime/index.js';
import { compileExperiment } from '../js/dynamic/experiments.js';

// The mismatch must be detected as a DebugAdapterError carrying both hashes.
{
  const hypothesis = { id: 'hyp-bin-A', binaryHash: 'bin-A', functionAddress: 0x1000n, fieldOffset: 0, fieldSize: 8, initial: 100, argumentIndex: 1, operation: 'set' };
  const compiled = compileExperiment(hypothesis, { binaryHash: 'bin-B' });
  assert.equal(compiled.binaryHash, 'bin-B',
    'precondition: compileExperiment() prefers the injected session hash (the overwrite #6139 describes)');
}

{
  // The platform contract: verifyHypothesis must reject before running.
  const platform = new RuntimeAnalysisPlatform({});
  platform.currentSession = function () {
    return { id: 'session-B', binaryHash: 'bin-B', addExperiment() {}, addObservation() {} };
  };
  await assert.rejects(
    () => platform.verifyHypothesis({ id: 'hyp-A', binaryHash: 'bin-A', functionAddress: 0x1000n, fieldOffset: 0, fieldSize: 8, initial: 100, argumentIndex: 1, operation: 'set' }),
    (error) => error?.code === 'binary-version-mismatch',
    'a hypothesis bound to another binary must fail closed instead of being re-bound',
  );
}
