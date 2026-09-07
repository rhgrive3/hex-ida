import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE7_ARTIFACT_KINDS,
  dependencyClassFor,
} from '../../js/analysis/artifact-identity.js';

test('issue-3141: dependencyClassFor rejects inherited properties instead of treating them as known kinds', () => {
  // `__proto__` exists on every object, so the old truthiness probe
  // (`PHASE7_DEPENDENCY_CLASSES[kind]`) returned `Object.prototype` for it and
  // classified an unknown kind as a known dependency class.
  assert.throws(() => dependencyClassFor('__proto__'), /phase7-artifact-unknown-kind/);
  assert.throws(() => dependencyClassFor('constructor'), /phase7-artifact-unknown-kind/);
  assert.throws(() => dependencyClassFor('toString'), /phase7-artifact-unknown-kind/);
});

test('issue-3141: dependencyClassFor still accepts exactly the declared kinds', () => {
  for (const kind of PHASE7_ARTIFACT_KINDS) {
    const classes = dependencyClassFor(kind);
    assert.ok(Array.isArray(classes) && classes.length > 0, `${kind} must declare dependency classes`);
  }
});
