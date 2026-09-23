import assert from 'node:assert/strict';
import test from 'node:test';

import { verify } from '../scripts/fetch-real-fixtures.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function entry({ dev = 1, ino = 2, size = 4 } = {}) {
  return {
    dev,
    ino,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function handleFor(openedEntry, closeError = null) {
  return {
    async stat() { return openedEntry; },
    async close() {
      if (closeError) throw closeError;
    },
  };
}

test('#9470 SHA mismatch remains repairable when handle close also fails', async () => {
  const file = entry();
  const closeError = Object.assign(new Error('close EIO'), { code: 'EIO' });

  await assert.rejects(
    () => verify('demo', '/cache/demo.bin', { size: 4, sha256: SHA_A }, {
      statImpl: async () => file,
      openImpl: async () => handleFor(file, closeError),
      digestHandleImpl: async () => ({ size: 4, sha256: SHA_B }),
    }),
    (error) => {
      assert.equal(error.name, 'FixtureVerificationError');
      assert.equal(error.repairable, true);
      assert.match(error.message, /SHA-256 mismatch/);
      assert.equal(error.cleanupError, closeError);
      assert.equal(error.cause, closeError);
      return true;
    },
  );
});

test('#9470 digest-size mismatch remains repairable when close fails', async () => {
  const file = entry();
  const closeError = Object.assign(new Error('close ENOSPC'), { code: 'ENOSPC' });

  await assert.rejects(
    () => verify('demo', '/cache/demo.bin', { size: 4, sha256: SHA_A }, {
      statImpl: async () => file,
      openImpl: async () => handleFor(file, closeError),
      digestHandleImpl: async () => ({ size: 3, sha256: SHA_A }),
    }),
    (error) => {
      assert.equal(error.repairable, true);
      assert.match(error.message, /size mismatch/);
      assert.equal(error.cleanupError, closeError);
      return true;
    },
  );
});

test('#9470 identity mismatch remains primary when close fails', async () => {
  const selected = entry({ ino: 2 });
  const opened = entry({ ino: 3 });
  const closeError = Object.assign(new Error('close EIO'), { code: 'EIO' });

  await assert.rejects(
    () => verify('demo', '/cache/demo.bin', { size: 4, sha256: SHA_A }, {
      statImpl: async () => selected,
      openImpl: async () => handleFor(opened, closeError),
      digestHandleImpl: async () => ({ size: 4, sha256: SHA_A }),
    }),
    (error) => {
      assert.equal(error.repairable, true);
      assert.match(error.message, /identity changed before hashing/);
      assert.equal(error.cleanupError, closeError);
      return true;
    },
  );
});

test('#9470 standalone close failure after successful verification still surfaces', async () => {
  const file = entry();
  const closeError = Object.assign(new Error('close EIO'), { code: 'EIO' });
  let stats = 0;

  await assert.rejects(
    () => verify('demo', '/cache/demo.bin', { size: 4, sha256: SHA_A }, {
      statImpl: async () => {
        stats++;
        return file;
      },
      openImpl: async () => handleFor(file, closeError),
      digestHandleImpl: async () => ({ size: 4, sha256: SHA_A }),
    }),
    (error) => error === closeError,
  );
  assert.equal(stats, 2);
});

test('#9470 successful verification and close remain unchanged', async () => {
  const file = entry();
  const result = await verify('demo', '/cache/demo.bin', { size: 4, sha256: SHA_A }, {
    statImpl: async () => file,
    openImpl: async () => handleFor(file),
    digestHandleImpl: async () => ({ size: 4, sha256: SHA_A }),
  });
  assert.deepEqual(result, { size: 4, sha256: SHA_A });
});
