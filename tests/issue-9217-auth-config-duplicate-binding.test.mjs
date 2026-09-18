// #9217: a deployment config that declares AUTH_DB more than once cannot prove
// which definition the auth worker resolves. Validation must fail closed on
// duplicate cardinality and must not depend on `Array.prototype.find()` order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthConfig } from '../scripts/validate-auth-config.mjs';

function authDatabase(overrides = {}) {
  return {
    binding: 'AUTH_DB',
    database_name: 'hex-auth',
    database_id: '11111111-1111-1111-1111-111111111111',
    migrations_dir: 'migrations/auth',
    ...overrides,
  };
}

function configWith(d1Databases) {
  return { assets: { run_worker_first: true }, d1_databases: d1Databases };
}

test('#9217 accepts exactly one policy-compliant AUTH_DB binding', () => {
  assert.equal(validateAuthConfig(configWith([authDatabase()])), true);
});

test('#9217 ignores unrelated D1 bindings while validating the unique AUTH_DB', () => {
  const config = configWith([
    { binding: 'SESSIONS_DB', database_name: 'sessions', database_id: 'not-a-uuid', migrations_dir: 'elsewhere' },
    authDatabase(),
    { binding: 'CACHE_DB', database_name: 'cache', database_id: 'still-not-a-uuid', migrations_dir: 'nope' },
  ]);
  assert.equal(validateAuthConfig(config), true);
});

test('#9217 rejects zero AUTH_DB bindings', () => {
  assert.throws(() => validateAuthConfig(configWith([])), /AUTH_DB must be defined exactly once/);
  assert.throws(() => validateAuthConfig(configWith(undefined)), /AUTH_DB must be defined exactly once/);
  assert.throws(() => validateAuthConfig({ assets: { run_worker_first: true } }), /AUTH_DB must be defined exactly once/);
});

test('#9217 rejects duplicate AUTH_DB bindings regardless of array order', () => {
  const valid = authDatabase();
  const invalidDuplicate = authDatabase({ database_name: 'wrong-db', database_id: 'not-a-uuid', migrations_dir: 'wrong/migrations' });

  let forwardError;
  try { validateAuthConfig(configWith([valid, invalidDuplicate])); } catch (error) { forwardError = error; }
  let reverseError;
  try { validateAuthConfig(configWith([invalidDuplicate, valid])); } catch (error) { reverseError = error; }

  assert.ok(forwardError, 'valid-then-invalid duplicate must fail');
  assert.ok(reverseError, 'invalid-then-valid duplicate must fail');
  assert.match(forwardError.message, /AUTH_DB must be defined exactly once/);
  assert.equal(forwardError.message, reverseError.message, 'validation must not depend on binding order');
});

test('#9217 rejects two individually valid AUTH_DB definitions as ambiguous', () => {
  const first = authDatabase();
  const second = authDatabase({ database_id: '22222222-2222-2222-2222-222222222222' });
  assert.throws(() => validateAuthConfig(configWith([first, second])), /AUTH_DB must be defined exactly once/);
  assert.throws(() => validateAuthConfig(configWith([second, first])), /AUTH_DB must be defined exactly once/);
});

test('#9217 still enforces the existing policy for the unique AUTH_DB entry', () => {
  assert.throws(
    () => validateAuthConfig(configWith([authDatabase({ database_name: 'other-db' })])),
    /AUTH_DB and migrations\/auth must be configured/,
  );
  assert.throws(
    () => validateAuthConfig(configWith([authDatabase({ migrations_dir: 'other/migrations' })])),
    /AUTH_DB and migrations\/auth must be configured/,
  );
  assert.throws(
    () => validateAuthConfig(configWith([authDatabase({ database_id: 'not-a-uuid' })])),
    /AUTH_DB database_id must be a real D1 UUID/,
  );

  const sentinel = configWith([authDatabase({ database_id: '00000000-0000-0000-0000-000000000000' })]);
  assert.throws(() => validateAuthConfig(sentinel), /sentinel/);
  assert.equal(validateAuthConfig(sentinel, { local: true }), true);
});
