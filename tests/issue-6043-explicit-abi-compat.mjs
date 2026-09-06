import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../js/targets/abi/index.js';

test('6043: cross-architecture explicit abiId is rejected', () => {
  assert.equal(
    resolveABIPlugin({ architecture: 'arm64', platform: 'linux', abiId: 'microsoft-x64' }).id,
    'unknown',
  );
  assert.equal(
    resolveABIPlugin({ architecture: 'x86_64', platform: 'windows', abiId: 'aapcs64' }).id,
    'unknown',
  );
});

test('6043: cross-platform explicit abiId is rejected', () => {
  assert.equal(
    resolveABIPlugin({ architecture: 'x86_64', platform: 'linux', abiId: 'microsoft-x64' }).id,
    'unknown',
  );
});

test('6043: matching explicit abiId still resolves', () => {
  assert.equal(
    resolveABIPlugin({ architecture: 'x86_64', platform: 'windows', abiId: 'microsoft-x64' }).id,
    'microsoft-x64',
  );
  assert.equal(
    resolveABIPlugin({ architecture: 'riscv64', abiId: 'lp64d' }).id,
    'lp64d',
  );
  assert.equal(
    resolveABIPlugin({ architecture: 'arm64e', platform: 'darwin', abiId: 'darwin-arm64' }).id,
    'darwin-arm64',
  );
});
