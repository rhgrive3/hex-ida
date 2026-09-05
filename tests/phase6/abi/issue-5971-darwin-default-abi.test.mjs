import test from 'node:test';
import assert from 'node:assert/strict';

import { DARWIN_PLATFORM, LINUX_PLATFORM } from '../../../js/targets/platform/index.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/aapcs64.js';
import { DARWIN_ARM64_ABI } from '../../../js/targets/abi/darwin-arm64.js';

test('#5971 Darwin ARM64 defaults to the Darwin ABI profile', () => {
  for (const architecture of ['arm64', 'arm64e']) {
    assert.equal(DARWIN_PLATFORM.defaultABI({ architecture }), DARWIN_ARM64_ABI.id);
  }

  assert.equal(LINUX_PLATFORM.defaultABI({ architecture:'arm64' }), AAPCS64_ABI.id);
  assert.equal(DARWIN_PLATFORM.defaultABI({ architecture:'x86_64' }), null);
});

test('#5971 Darwin default names a Darwin-compatible ABI instead of generic AAPCS64', () => {
  const abiId = DARWIN_PLATFORM.defaultABI({ architecture:'arm64' });

  assert.equal(abiId, DARWIN_ARM64_ABI.id);
  assert.equal(DARWIN_ARM64_ABI.platformPredicate({ platform:'darwin' }), true);
  assert.equal(AAPCS64_ABI.platformPredicate({ platform:'darwin' }), false);
  assert.notEqual(DARWIN_ARM64_ABI.id, AAPCS64_ABI.id);
});
