// Issue #5618 regression: runtime.connect is a binary-scoped capability and
// must not create a session without either current or explicit binary identity.
import assert from 'node:assert/strict';

import { createCapabilityCatalog } from '../../../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const catalog = createCapabilityCatalog();
const entry = catalog.get('runtime.connect');
const platform = {
  adapter() { return { connected: false }; },
  currentSession() { return null; },
  startSession() { throw new Error('runtime.connect must not start an unbound session'); },
};

assert.throws(
  () => new CapabilityExecutor({ catalog, runtimePlatform: platform, binaryId: null }).verifyBinding(entry, {}, platform),
  (error) => error?.type === 'scope_violation',
  'runtime.connect must reject without current or explicit binary identity',
);

assert.doesNotThrow(
  () => new CapabilityExecutor({ catalog, runtimePlatform: platform, binaryId: null }).verifyBinding(entry, { binaryId: 'binary-explicit' }, platform),
  'an explicit binary identity is sufficient when no current binary is loaded',
);

assert.doesNotThrow(
  () => new CapabilityExecutor({ catalog, runtimePlatform: platform, binaryId: 'binary-current' }).verifyBinding(entry, {}, platform),
  'the current binary identity is sufficient when no explicit id is supplied',
);

assert.throws(
  () => new CapabilityExecutor({ catalog, runtimePlatform: platform, binaryId: 'binary-current' }).verifyBinding(entry, { binaryId: 'binary-other' }, platform),
  (error) => error?.type === 'scope_violation',
  'an explicit identity that differs from the current binary must remain rejected',
);

console.log('issue-5618-runtime-connect-binary-binding: ok');
