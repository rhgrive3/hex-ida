import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStandardGraph } from '../scripts/auth-build-policy.mjs';

const forbidden = [
  'JS/AI/DEV/secret.js',
  'Js/Userscript/Dev/worker.js',
  'JS/AUTH/PRIVILEGED/secret.js',
  'js/AUTH/SERVER/api.js',
  'JS/AUTH/ADMIN-APP.JS',
];

for (const input of forbidden) {
  test(`#9320 Windows-equivalent forbidden path is rejected: ${input}`, () => {
    assert.throws(
      () => assertStandardGraph({ inputs:{ [input]:{} } }, 'standard', { platform:'win32' }),
      /leaks privileged implementation/,
    );
  });
}

test('#9320 POSIX policy remains case-sensitive', () => {
  const resolver = (value) => String(value);
  assert.doesNotThrow(() => assertStandardGraph(
    { inputs:{ 'JS/AUTH/PRIVILEGED/secret.js':{} } },
    'standard',
    { platform:'linux', repoRoot:'/work/hex', realpathSync: resolver },
  ));
  assert.throws(
    () => assertStandardGraph(
      { inputs:{ 'js/auth/privileged/secret.js':{} } },
      'standard',
      { platform:'linux', repoRoot:'/work/hex', realpathSync: resolver },
    ),
    /leaks privileged implementation/,
  );
});
