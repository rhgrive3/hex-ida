import test from 'node:test';
import assert from 'node:assert/strict';

import { DARWIN_PLATFORM, LINUX_PLATFORM } from '../../../js/targets/platform/index.js';
import {
  AAPCS64_ABI,
  DARWIN_ARM64_ABI,
  resolveABIPlugin,
} from '../../../js/targets/abi/index.js';

test('#5971 Darwin ARM64 defaults to the Darwin ABI profile', () => {
  for (const architecture of ['arm64', 'arm64e']) {
    assert.equal(DARWIN_PLATFORM.defaultABI({ architecture }), 'darwin-arm64');
  }

  assert.equal(LINUX_PLATFORM.defaultABI({ architecture:'arm64' }), 'aapcs64');
  assert.equal(DARWIN_PLATFORM.defaultABI({ architecture:'x86_64' }), null);
});

test('#5971 Darwin default is supported by the selected ABI profile', () => {
  const abiId = DARWIN_PLATFORM.defaultABI({ architecture:'arm64' });
  const resolved = resolveABIPlugin({ abiId, architecture:'arm64', platform:'darwin' });

  assert.equal(resolved, DARWIN_ARM64_ABI);
  assert.equal(resolved.platformPredicate({ platform:'darwin' }), true);
  assert.equal(AAPCS64_ABI.platformPredicate({ platform:'darwin' }), false);
  assert.notEqual(resolved, AAPCS64_ABI);
});
