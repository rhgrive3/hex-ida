import test from 'node:test';
import assert from 'node:assert/strict';

import { DARWIN_PLATFORM, LINUX_PLATFORM } from '../../../js/targets/platform/index.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';
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
  const abiId = DARWIN_PLATFORM.defaultABI({ architecture:'arm64e' });
  const abi = resolveABIPlugin({ architecture:'arm64e', platform:'darwin', abiId });
  const stackRules = abi.stackRules();

  assert.equal(abiId, DARWIN_ARM64_ABI.id);
  assert.equal(abi, DARWIN_ARM64_ABI);
  assert.equal(DARWIN_ARM64_ABI.platformPredicate({ platform:'darwin' }), true);
  assert.equal(AAPCS64_ABI.platformPredicate({ platform:'darwin' }), false);
  assert.notEqual(DARWIN_ARM64_ABI.id, AAPCS64_ABI.id);

  assert.equal(stackRules.alignment, 16);
  assert.equal(stackRules.variadicAnonymousArguments, 'stack-only');
  assert.deepEqual(stackRules.reservedRegisters, ['x18']);
  assert.equal(stackRules.compactArgumentSlots, true);
  assert.equal(stackRules.argumentSlotBytes, null);
  assert.equal(stackRules.redZoneBytes, 128);
});
