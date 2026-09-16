import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { privilegedIdentity, releaseIdentityFor, assertStandardGraph, assertPrivilegedGraph } from '../../scripts/auth-build-policy.mjs';
import { parseJsonc, validateAuthConfig } from '../../scripts/validate-auth-config.mjs';
test('privileged-only edits update release identity without changing runtime content ID; deterministic DAG', () => {
  const runtime = 'a'.repeat(24), first = privilegedIdentity(runtime, 'parent-v1', 'child-v1', 'admin-v1');
  assert.deepEqual(privilegedIdentity(runtime, 'parent-v1', 'child-v1', 'admin-v1'), first);
  for (const [parent, child, admin] of [['parent-v2', 'child-v1', 'admin-v1'], ['parent-v1', 'child-v2', 'admin-v1'], ['parent-v1', 'child-v1', 'admin-v2']]) {
    const changed = privilegedIdentity(runtime, parent, child, admin);
    assert.equal(changed.buildId.split('.')[0], runtime); assert.notEqual(changed.buildId, first.buildId);
    assert.notEqual(releaseIdentityFor(['same-runtime', parent, child, admin]), releaseIdentityFor(['same-runtime', 'parent-v1', 'child-v1', 'admin-v1']));
  }
  assert.equal(releaseIdentityFor(['a', 'bc']), releaseIdentityFor(['a', 'bc']));
  assert.notEqual(releaseIdentityFor(['a', 'bc']), releaseIdentityFor(['ab', 'c']));
});
test('graph gate rejects privileged transitive modules, requires existing implementation', () => {
  assertStandardGraph({ inputs: { 'js/auth/client.js': {}, 'js/ai/ui/assistant.js': {} } }, 'standard');
  for (const path of ['js/ai/dev/ui/settings.js', 'js/userscript/dev/parent-rpc.js', 'js/auth/privileged/parent-entry.js', 'js/auth/server/router.js', 'js/auth/admin-app.js']) assert.throws(() => assertStandardGraph({ inputs: { [path]: {} } }, 'standard'), /leaks/);
  assert.throws(() => assertPrivilegedGraph({ inputs: {} }, 'child'), /omits/);
  assert.throws(() => assertStandardGraph({ inputs: {} }, 'empty'), /no verifiable/);
  assert.throws(() => assertStandardGraph({}, 'missing'), /no verifiable/);
});
test('local D1 configuration is usable but production sentinel is explicitly rejected', async () => {
  const config = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(validateAuthConfig(config, { local: true }), true);
  assert.throws(() => validateAuthConfig(config), /sentinel/);
  const production = structuredClone(config); production.d1_databases[0].database_id = '11111111-2222-3333-4444-555555555555';
  assert.equal(validateAuthConfig(production), true);
  production.assets.run_worker_first = false; assert.throws(() => validateAuthConfig(production), /Worker|worker/);
});

test('JSONC loader accepts inline comments, trailing commas, and comment-like string data', () => {
  const config = parseJsonc(`{
    "d1_databases": [{
      "binding": "AUTH_DB", // deployment binding
      "database_name": "hex-auth",
      "database_id": "11111111-2222-3333-4444-555555555555",
      "migrations_dir": "migrations/auth",
    }],
    "assets": { "run_worker_first": true },
    "commentLikeValue": "https://example.test/a//b",
  }`);
  assert.equal(validateAuthConfig(config), true);
  assert.equal(config.commentLikeValue, 'https://example.test/a//b');
  assert.throws(() => parseJsonc('{ "assets": /* unterminated }'), /unterminated block comment/);
  assert.throws(() => parseJsonc('{ "assets": }'), SyntaxError);
});
