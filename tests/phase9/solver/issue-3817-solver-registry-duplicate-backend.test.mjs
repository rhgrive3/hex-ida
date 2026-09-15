import assert from 'node:assert/strict';
import test from 'node:test';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SolverRegistry } from '../../../js/symbolic/solver/registry.js';

function nonExact(id) {
  return { id, version: '0', proofAuthority: 'none', capabilities() { return {}; } };
}

test('#3817 duplicate-id registration cannot silently replace a backend', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const exact = new ExhaustiveBvBackend({ id: 'same' });
  registry.registerBackend(exact);
  assert.equal(registry.getDefaultBackend(), exact);
  assert.throws(() => registry.registerBackend(nonExact('same')), /already registered/);
  assert.equal(registry.getDefaultBackend(), exact);
  assert.equal(registry.getDefaultBackend().proofAuthority, 'exact');
  assert.equal(registry.getBackend('same'), exact);
});

test('#3817 exact-to-exact duplicate id is rejected under the same policy', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const first = new ExhaustiveBvBackend({ id: 'dup' });
  const second = new ExhaustiveBvBackend({ id: 'dup' });
  registry.registerBackend(first);
  assert.throws(() => registry.registerBackend(second), /already registered/);
  assert.equal(registry.getBackend('dup'), first);
});

test('#3817 duplicate-id rejection applies to permissive test registries too', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: true });
  registry.registerBackend(nonExact('dup'));
  assert.throws(() => registry.registerBackend(nonExact('dup')), /already registered/);
});

test('#3817 re-registration after unregister keeps prior default selection semantics', () => {
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const exact = new ExhaustiveBvBackend({ id: 'cycle' });
  registry.registerBackend(exact);
  registry.unregisterBackend('cycle');
  assert.equal(registry.getDefaultBackend(), null);
  assert.doesNotThrow(() => registry.registerBackend(exact));
  assert.equal(registry.getDefaultBackend(), exact);
});
