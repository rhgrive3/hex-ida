import assert from 'node:assert/strict';
import test from 'node:test';
import { readResolvedRepositorySource } from '../scripts/stable-repository-source.mjs';

const sourceStat = Object.freeze({
  dev: 1n,
  ino: 2n,
  size: 4n,
  mtimeNs: 10n,
  ctimeNs: 10n,
  isFile: () => true,
});

function resolved() {
  return { normalized: 'js/example.js', realSource: '/repo/js/example.js', sourceStat };
}

function stableHandle({ closeError = null, finalStat = sourceStat } = {}) {
  let statCalls = 0;
  return {
    async stat() { return statCalls++ === 0 ? sourceStat : finalStat; },
    async readFile() { return Buffer.from('data'); },
    async close() { if (closeError) throw closeError; },
  };
}

test('#9588 primary read failure remains authoritative when close also fails', async () => {
  const primary = new Error('PRIMARY_READ_FAILURE');
  const closeError = Object.assign(new Error('CLOSE_EIO'), { code: 'EIO' });
  await assert.rejects(
    readResolvedRepositorySource(resolved(), {
      openImpl: async () => stableHandle({ closeError }),
      readHandleImpl: async () => { throw primary; },
      sourceLabel: 'Bundled graph source',
    }),
    (error) => error === primary,
  );
});

test('#9588 provenance failure remains authoritative when close also fails', async () => {
  const changedStat = { ...sourceStat, ctimeNs: 11n, isFile: () => true };
  const closeError = Object.assign(new Error('CLOSE_EIO'), { code: 'EIO' });
  await assert.rejects(
    readResolvedRepositorySource(resolved(), {
      openImpl: async () => stableHandle({ closeError, finalStat: changedStat }),
      readHandleImpl: async () => Buffer.from('data'),
      sourceLabel: 'Bundled graph source',
    }),
    /changed during read/,
  );
});

test('#9588 successful operation still surfaces close failure', async () => {
  const closeError = Object.assign(new Error('CLOSE_EIO'), { code: 'EIO' });
  await assert.rejects(
    readResolvedRepositorySource(resolved(), {
      openImpl: async () => stableHandle({ closeError }),
      readHandleImpl: async () => Buffer.from('data'),
      sourceLabel: 'Bundled graph source',
    }),
    (error) => error === closeError,
  );
});

test('#9588 primary failure with successful close and success path remain unchanged', async () => {
  const primary = new Error('PRIMARY_ONLY');
  await assert.rejects(
    readResolvedRepositorySource(resolved(), {
      openImpl: async () => stableHandle(),
      readHandleImpl: async () => { throw primary; },
    }),
    (error) => error === primary,
  );
  const result = await readResolvedRepositorySource(resolved(), {
    openImpl: async () => stableHandle(),
    readHandleImpl: async () => Buffer.from('data'),
  });
  assert.equal(result.toString(), 'data');
});
