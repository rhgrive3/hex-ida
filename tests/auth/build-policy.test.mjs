import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privilegedIdentity, releaseIdentityFor, assertStandardGraph, assertPrivilegedGraph } from '../../scripts/auth-build-policy.mjs';
import { parseJsonc, validateAuthConfig, parseCliArgs } from '../../scripts/validate-auth-config.mjs';
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

test('privileged graph kind discriminator fails closed', () => {
  const parent = { inputs: {
    'js/userscript/dev/parent-worker-runtime.js': {},
    'js/userscript/dev/parent-rpc.js': {},
    'js/userscript/dev/bootstrap-host.js': {},
  } };
  const child = { inputs: {
    'js/ai/dev/supervisor/dev-supervisor-v0.js': {},
    'js/ai/dev/ui/settings.js': {},
    'js/ai/dev/ui/engine-router.js': {},
    'js/ai/dev/ui/controls.js': {},
  } };

  assert.doesNotThrow(() => assertPrivilegedGraph(parent, 'parent'));
  assert.doesNotThrow(() => assertPrivilegedGraph(child, 'child'));
  for (const kind of ['parennt', 'admin', 'future-kind', '', undefined]) {
    assert.throws(() => assertPrivilegedGraph(child, kind), /Unsupported privileged bundle kind/);
  }
  assert.throws(() => assertPrivilegedGraph({ inputs: {} }, 'parent'), /omits/);
  assert.throws(() => assertPrivilegedGraph({ inputs: {} }, 'child'), /omits/);

  // #9175: reject suffix-shadowed inputs for parent and child
  const repoRoot = '/repo/hex-ida';
  const shadowedParent = { inputs: {
    'vendor/shadow/js/userscript/dev/parent-worker-runtime.js': {},
    'node_modules/pkg/js/userscript/dev/parent-rpc.js': {},
    'other/js/userscript/dev/bootstrap-host.js': {},
  } };
  assert.throws(() => assertPrivilegedGraph(shadowedParent, 'parent', { repoRoot }), /parent bundle omits/);

  const shadowedChild = { inputs: {
    'vendor/shadow/js/ai/dev/supervisor/dev-supervisor-v0.js': {},
    'node_modules/pkg/js/ai/dev/ui/settings.js': {},
    'custom/js/ai/dev/ui/engine-router.js': {},
    'js/ai/dev/ui/controls.js': {},
  } };
  assert.throws(() => assertPrivilegedGraph(shadowedChild, 'child', { repoRoot }), /child bundle omits/);

  // Absolute paths within repoRoot are accepted; absolute paths outside are rejected
  const absoluteValidParent = { inputs: {
    '/repo/hex-ida/js/userscript/dev/parent-worker-runtime.js': {},
    '/repo/hex-ida/js/userscript/dev/parent-rpc.js': {},
    '/repo/hex-ida/js/userscript/dev/bootstrap-host.js': {},
  } };
  assert.doesNotThrow(() => assertPrivilegedGraph(absoluteValidParent, 'parent', { repoRoot }));

  const absoluteOutsideParent = { inputs: {
    '/outside/repo/js/userscript/dev/parent-worker-runtime.js': {},
    '/outside/repo/js/userscript/dev/parent-rpc.js': {},
    '/outside/repo/js/userscript/dev/bootstrap-host.js': {},
  } };
  assert.throws(() => assertPrivilegedGraph(absoluteOutsideParent, 'parent', { repoRoot }), /parent bundle omits/);

  // Windows separator support
  const windowsParent = { inputs: {
    'js\\userscript\\dev\\parent-worker-runtime.js': {},
    'js\\userscript\\dev\\parent-rpc.js': {},
    'js\\userscript\\dev\\bootstrap-host.js': {},
  } };
  assert.doesNotThrow(() => assertPrivilegedGraph(windowsParent, 'parent', { repoRoot }));
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

  // #9170: line comments must not duplicate line terminators
  assert.deepEqual(parseJsonc('// c\n{"x":1}'), { x: 1 });
  assert.deepEqual(parseJsonc('\uFEFF// bom\r\n{"x":2,}'), { x: 2 });

  // Verify exact line counts and error offset preservation
  let errorWithoutComment;
  try { parseJsonc('\n{"a": 1, "b": }'); } catch (e) { errorWithoutComment = e; }
  let errorWithComment;
  try { parseJsonc('// comment\n{"a": 1, "b": }'); } catch (e) { errorWithComment = e; }
  // Position of syntax error should be identical in line count
  assert.ok(errorWithComment instanceof SyntaxError);

  // #9180: multiline block comment must preserve line terminators and source line layout
  const blockCommentSource = `{\n  /* first\n     second */\n  "a":\n}`;
  let blockCommentError;
  try { parseJsonc(blockCommentSource); } catch (e) { blockCommentError = e; }
  assert.ok(blockCommentError instanceof SyntaxError);
  // Compare with identical whitespace layout where comment was replaced by spaces and newlines
  const equivalentSource = `{\n            \n              \n  "a":\n}`;
  let equivalentError;
  try { parseJsonc(equivalentSource); } catch (e) { equivalentError = e; }
  assert.equal(blockCommentError.message, equivalentError.message);

  // #9180: CRLF preservation in block comments
  const crlfSource = '{\r\n  /* line1\r\n     line2 */\r\n  "x": 1\r\n}';
  assert.deepEqual(parseJsonc(crlfSource), { x: 1 });

  // #9188: trailing comma normalization must preserve character width and error positions
  const trailingCommaInput = '{"a":{"b":1,},"c":}';
  const spaceEquivalentInput = '{"a":{"b":1 },"c":}';
  let trailingCommaError;
  try { parseJsonc(trailingCommaInput); } catch (e) { trailingCommaError = e; }
  let spaceEquivalentError;
  try { parseJsonc(spaceEquivalentInput); } catch (e) { spaceEquivalentError = e; }
  assert.ok(trailingCommaError instanceof SyntaxError);
  assert.equal(trailingCommaError.message, spaceEquivalentError.message);

  // #9188: multiple nested trailing commas must not cause accumulated offset drift
  const multiTrailingInput = '{"a":[1,2,],"b":{"c":3,},"d":}';
  const multiSpaceInput = '{"a":[1,2 ],"b":{"c":3 },"d":}';
  let multiTrailingError;
  try { parseJsonc(multiTrailingInput); } catch (e) { multiTrailingError = e; }
  let multiSpaceError;
  try { parseJsonc(multiSpaceInput); } catch (e) { multiSpaceError = e; }
  assert.equal(multiTrailingError.message, multiSpaceError.message);
});

test('#9193 validate-auth-config CLI argument validation rejects unknown options and typos', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const cli = path.join(root, 'scripts/validate-auth-config.mjs');

  // parseCliArgs unit validations
  assert.deepEqual(parseCliArgs([]), { file: 'wrangler.jsonc', local: false });
  assert.deepEqual(parseCliArgs(['--config=custom.jsonc']), { file: 'custom.jsonc', local: false });
  assert.deepEqual(parseCliArgs(['--local']), { file: 'wrangler.jsonc', local: true });
  assert.deepEqual(parseCliArgs(['--config=custom.jsonc', '--local']), { file: 'custom.jsonc', local: true });
  assert.deepEqual(parseCliArgs(['--local', '--config=custom.jsonc']), { file: 'custom.jsonc', local: true });

  assert.throws(() => parseCliArgs(['--configg=bad.jsonc']), /Unknown argument: --configg=bad\.jsonc/);
  assert.throws(() => parseCliArgs(['--locla']), /Unknown argument: --locla/);
  assert.throws(() => parseCliArgs(['unexpected.jsonc']), /Unknown argument: unexpected\.jsonc/);
  assert.throws(() => parseCliArgs(['--config=a.jsonc', '--config=b.jsonc']), /Duplicate --config option/);
  assert.throws(() => parseCliArgs(['--local', '--local']), /Duplicate --local option/);
  assert.throws(() => parseCliArgs(['--config=']), /Invalid --config option: path cannot be empty/);

  // Process execution validations
  const typoResult = spawnSync(process.execPath, [cli, '--configg=bad.jsonc'], { cwd: root, encoding: 'utf8' });
  assert.equal(typoResult.status, 1, 'typo in option name must exit non-zero');
  assert.match(typoResult.stderr, /Unknown argument: --configg=bad\.jsonc/);
  assert.doesNotMatch(typoResult.stdout, /Auth deployment configuration validated/);

  const typoLocalResult = spawnSync(process.execPath, [cli, '--locla'], { cwd: root, encoding: 'utf8' });
  assert.equal(typoLocalResult.status, 1, 'typo in --local option must exit non-zero');
  assert.match(typoLocalResult.stderr, /Unknown argument: --locla/);

  const positionalResult = spawnSync(process.execPath, [cli, 'extra'], { cwd: root, encoding: 'utf8' });
  assert.equal(positionalResult.status, 1, 'positional argument must exit non-zero');
  assert.match(positionalResult.stderr, /Unknown argument: extra/);

  const validLocalResult = spawnSync(process.execPath, [cli, '--local'], { cwd: root, encoding: 'utf8' });
  assert.equal(validLocalResult.status, 0, 'supported --local must succeed against default config');
  assert.match(validLocalResult.stdout, /Auth deployment configuration validated/);
});

