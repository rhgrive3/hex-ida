import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { closeDescriptorPreservingPrimary } from '../scripts/deploy-production.mjs';

test('#9598 close-only descriptor failure is still surfaced', () => {
  const closeFailure = Object.assign(new Error('CLOSE_EBADF'), { code: 'EBADF' });
  assert.throws(
    () => closeDescriptorPreservingPrimary(() => { throw closeFailure; }, 7, null),
    (error) => error === closeFailure,
  );
});

test('#9598 close failure cannot replace an established primary asset error', () => {
  const primary = Object.assign(new Error('PRIMARY_ASSET_FAILURE'), { code: 'EIO' });
  const closeFailure = Object.assign(new Error('CLOSE_EBADF'), { code: 'EBADF' });
  assert.doesNotThrow(() => closeDescriptorPreservingPrimary(() => { throw closeFailure; }, 7, primary));
});

test('#9598 asset descriptor scopes use primary-preserving close arbitration', () => {
  const source = readFileSync(new URL('../scripts/deploy-production.mjs', import.meta.url), 'utf8');
  for (const fd of ['childDirFd', 'fileFd', 'snapshotAssetsFd', 'assetsFd']) {
    assert.match(
      source,
      new RegExp(`closeDescriptorPreservingPrimary\\(closeSync, ${fd}, [^)]+PrimaryError\\)`),
      `${fd} must not let close failure mask the protected asset operation`,
    );
  }
  assert.doesNotMatch(source, /finally\s*\{\s*closeSync\((?:childDirFd|fileFd|snapshotAssetsFd|assetsFd)\);\s*\}/);
});
