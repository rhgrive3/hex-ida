import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { assertStandardGraph } from '../scripts/auth-build-policy.mjs';

const repoRoot = path.resolve('/repo');

function resolverFor(map) {
  return (value) => {
    const key = path.resolve(String(value));
    if (key === repoRoot) return repoRoot;
    const mapped = map.get(key);
    if (mapped instanceof Error) throw mapped;
    if (mapped) return mapped;
    return key;
  };
}

for (const code of ['ENOENT', 'ENOTDIR']) {
  test(`#9472 standard graph rejects declared input whose identity fails with ${code}`, () => {
    const input = 'js/public/disappeared.js';
    const error = Object.assign(new Error('gone'), { code });
    const map = new Map([[path.resolve(repoRoot, input), error]]);

    assert.throws(
      () => assertStandardGraph({ inputs: { [input]: {} } }, 'standard', {
        repoRoot,
        realpathSync: resolverFor(map),
      }),
      /cannot establish source identity/,
    );
  });
}

test('#9472 ordinary existing allowed input remains accepted', () => {
  const input = 'js/public/ok.js';
  const realInput = path.resolve(repoRoot, input);
  const map = new Map([[realInput, realInput]]);
  assert.doesNotThrow(() => assertStandardGraph({ inputs: { [input]: {} } }, 'standard', {
    repoRoot,
    realpathSync: resolverFor(map),
  }));
});

test('#9472 allowed-looking symlink resolving to forbidden source remains rejected', () => {
  const input = 'js/public/alias.js';
  const realInput = path.resolve(repoRoot, 'js/auth/privileged/secret.js');
  const map = new Map([[path.resolve(repoRoot, input), realInput]]);

  assert.throws(
    () => assertStandardGraph({ inputs: { [input]: {} } }, 'standard', {
      repoRoot,
      realpathSync: resolverFor(map),
    }),
    /leaks privileged implementation/,
  );
});

test('#9472 direct forbidden path remains rejected before identity resolution', () => {
  let calls = 0;
  assert.throws(
    () => assertStandardGraph({ inputs: { 'js/auth/privileged/secret.js': {} } }, 'standard', {
      repoRoot,
      realpathSync() {
        calls++;
        throw new Error('resolver should not be needed for lexical forbidden path');
      },
    }),
    /leaks privileged implementation/,
  );
  assert.equal(calls, 0);
});
