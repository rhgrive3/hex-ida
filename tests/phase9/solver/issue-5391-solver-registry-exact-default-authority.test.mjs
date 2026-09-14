// Regression for #5391: SolverRegistry's production mode (allowNonExactDefault:
// false) promoted a backend to the exact default on the self-declared
// `proofAuthority === 'exact'` property alone. An arbitrary object with a
// truthy id and that one string became the production exact default, bypassing
// the isExactProofBackend() trust contract (identity, capabilities(),
// capabilityFingerprint() pairing, exactProofs, model extraction).
// Contract now: default-exact promotion (register, unregister replacement and
// setDefaultBackend) is gated on isExactProofBackend() in production mode;
// allowNonExactDefault test registries keep the old lenient selection.
import assert from 'node:assert/strict';
import { SolverRegistry, createProductionSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { isExactProofBackend } from '../../../js/symbolic/solver/backend.js';
import { ExhaustiveBvBackend, EXHAUSTIVE_BACKEND_ID } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';

// 1. The issue's scenario: a forged self-declared exact object must NOT become
//    the production default.
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const forged = { id: 'forged-exact', proofAuthority: 'exact' };
  registry.registerBackend(forged);
  assert.equal(isExactProofBackend(forged), false, 'precondition: forged object fails the trust contract');
  assert.notEqual(registry.getDefaultBackend(), forged, 'forged object must not be selected as exact default');
  assert.equal(registry.getDefaultBackend(), null, 'no eligible default exists, so default stays unset');
}

// 2. setDefaultBackend() applies the same production gate.
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  registry.registerBackend(new ExhaustiveBvBackend());
  const other = { id: 'other', proofAuthority: 'exact' };
  registry.registerBackend(other);
  assert.throws(() => registry.setDefaultBackend('other'), /not an exact production backend/,
    'self-declared exact object rejected by setDefaultBackend');
  // the real exact backend remains selectable
  registry.setDefaultBackend(EXHAUSTIVE_BACKEND_ID);
  assert.equal(registry.getDefaultBackend().constructor.name, 'ExhaustiveBvBackend');
}

// 3. unregisterBackend() replacement search must not promote a forged object.
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const real = new ExhaustiveBvBackend();
  registry.registerBackend(real);
  registry.registerBackend({ id: 'forged-2', proofAuthority: 'exact' });
  registry.unregisterBackend(real.id);
  assert.equal(registry.getDefaultBackend(), null, 'replacement search ignores forged exact objects');
}

// 4. Acceptance: built-in production backends keep being selected.
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  registry.registerBackend(new ExhaustiveBvBackend());
  assert.equal(registry.getDefaultBackend().constructor.name, 'ExhaustiveBvBackend');
  assert.equal(createProductionSolverRegistry({ preferWorker: false }).getDefaultBackend().constructor.name, 'ExhaustiveBvBackend');
}

// 5. Acceptance: an exact backend whose advertised capabilities do not pair
//    with its own capabilityFingerprint() is rejected too.
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const mismatched = new ExhaustiveBvBackend();
  const realFingerprint = mismatched.capabilityFingerprint();
  mismatched.capabilities = () => Object.freeze({
    ...mismatched.baseCapabilities(),
    proofAuthority: 'exact',
    exactProofs: true,
    supportsModelExtraction: true,
    capabilityFingerprint: 'digest:0000',
  });
  registry.registerBackend(mismatched);
  assert.notEqual(realFingerprint, 'digest:0000');
  assert.equal(isExactProofBackend(mismatched), false, 'capabilities/fingerprint mismatch fails the trust contract');
  assert.equal(registry.getDefaultBackend(), null, 'mismatched backend not promoted');
  assert.throws(() => registry.setDefaultBackend(mismatched.id), /not an exact production backend/);
}

// 6. Acceptance: allowNonExactDefault test registries keep the lenient path.
{
  const registry = new SolverRegistry({ allowNonExactDefault: true });
  const fake = new FakeSolverBackend({ id: 'test-fake-solver', version: '1.0.0' });
  registry.registerBackend(fake);
  assert.equal(registry.getDefaultBackend(), fake, 'test registries may default to non-exact backends');
  registry.setDefaultBackend('test-fake-solver');
  assert.equal(registry.getDefaultBackend(), fake);
}

// 7. A malformed backend registered after a real one must not hijack the
//    default (first-eligible wins, and only contract-fulfilling backends are
//    eligible in production mode).
{
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  registry.registerBackend(new ExhaustiveBvBackend());
  registry.registerBackend({ id: 'late-forged', proofAuthority: 'exact' });
  assert.equal(registry.getDefaultBackend().constructor.name, 'ExhaustiveBvBackend');
}

console.log('issue-5391 solver registry exact default trust contract: ok');
