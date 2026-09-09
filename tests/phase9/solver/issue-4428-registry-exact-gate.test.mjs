import assert from 'node:assert/strict';
import test from 'node:test';

import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { PROOF_AUTHORITY, isExactProofBackend } from '../../../js/symbolic/solver/backend.js';
import { SolverRegistry } from '../../../js/symbolic/solver/registry.js';

function fakeExactBackend(id = 'issue-4428-fake-exact') {
  return {
    id,
    version: '0',
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilities() {
      return {
        proofAuthority: PROOF_AUTHORITY.EXACT,
        exactProofs: false,
        supportsModelExtraction: false,
        capabilityFingerprint: 'fake-capability',
      };
    },
    capabilityFingerprint() {
      return 'fake-capability';
    },
  };
}

test('#4428 production registry does not select an authority-string-only exact backend', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const fake = fakeExactBackend();

  assert.equal(isExactProofBackend(fake), false);
  registry.registerBackend(fake);
  assert.equal(registry.getDefaultBackend(), null);

  const exact = new ExhaustiveBvBackend({ id: 'issue-4428-real-exact' });
  registry.registerBackend(exact);
  assert.equal(registry.getDefaultBackend(), exact);
});

test('#4428 setDefault and unregister replacement use the same exact validator', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const exact = new ExhaustiveBvBackend({ id: 'issue-4428-real-exact' });
  const fake = fakeExactBackend('issue-4428-replacement-fake');
  registry.registerBackend(exact);
  registry.registerBackend(fake);

  assert.throws(() => registry.setDefaultBackend(fake.id), /exact production backend/);
  assert.equal(registry.getDefaultBackend(), exact);

  registry.unregisterBackend(exact.id);
  assert.equal(registry.getDefaultBackend(), null);
});

test('#4428 test registries still permit non-exact defaults', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: true });
  const fake = fakeExactBackend('issue-4428-test-fake');
  registry.registerBackend(fake);
  assert.equal(registry.getDefaultBackend(), fake);
});
