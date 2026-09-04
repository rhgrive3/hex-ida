import test from 'node:test';
import assert from 'node:assert/strict';
import { LINUX_PLATFORM, DARWIN_PLATFORM, platformProfile } from '../../js/targets/platform/index.js';

test('6033: linux does not default non-Apple arm64e to aapcs64', () => {
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture: 'arm64e' }), null);
});

test('6033: linux keeps the arm64 default', () => {
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture: 'arm64' }), 'aapcs64');
});

test('6033: linux returns null for unrelated architectures', () => {
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture: 'x86_64' }), null);
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture: 'riscv64' }), null);
  assert.equal(LINUX_PLATFORM.defaultABI({}), null);
});

test('6033: darwin keeps the Apple arm64e default', () => {
  assert.equal(DARWIN_PLATFORM.defaultABI({ architecture: 'arm64e' }), 'aapcs64');
  assert.equal(DARWIN_PLATFORM.defaultABI({ architecture: 'arm64' }), 'aapcs64');
});

test('6033: registry lookup exposes the same linux default', () => {
  assert.equal(platformProfile('linux').defaultABI({ architecture: 'arm64e' }), null);
});
