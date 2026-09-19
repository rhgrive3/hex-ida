import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFixture, verify } from '../scripts/fetch-real-fixtures.mjs';

const spec = {
  file: 'issue-9279.bin',
  size: 1,
  sha256: '00',
  urlEnv: 'HEX_ISSUE_9279_URL',
};

function fsError(code) {
  return Object.assign(new Error(`${code}: injected stat failure`), { code });
}

test('#9279 only absence stat errors become missing-fixture diagnostics', async () => {
  await assert.rejects(
    () => verify('sample', '/does/not/matter', spec, { statImpl: async () => { throw fsError('ENOENT'); } }),
    /sample: fixture is missing/,
  );
  await assert.rejects(
    () => verify('sample', '/does/not/matter', spec, { statImpl: async () => { throw fsError('ENOTDIR'); } }),
    /sample: fixture is missing/,
  );
});

test('#9279 permission and IO stat failures preserve their diagnosis', async () => {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'EMFILE']) {
    await assert.rejects(
      () => verify('sample', '/does/not/matter', spec, { statImpl: async () => { throw fsError(code); } }),
      (error) => error?.code === code && !/fixture is missing/.test(error.message),
    );
  }
});

test('#9279 non-repairable inspection failures never enter download/replace flow', async () => {
  let fetched = 0;
  process.env.HEX_ISSUE_9279_URL = 'https://example.invalid/fixture.bin';
  try {
    await assert.rejects(
      () => fetchFixture('sample', spec, {
        verifyImpl: async () => { throw fsError('EACCES'); },
        fetchImpl: async () => {
          fetched++;
          throw new Error('download must not run');
        },
      }),
      (error) => error?.code === 'EACCES',
    );
    assert.equal(fetched, 0);
  } finally {
    delete process.env.HEX_ISSUE_9279_URL;
  }
});
