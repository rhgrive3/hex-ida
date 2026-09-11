import test from 'node:test';
import assert from 'node:assert/strict';

import { LINUX_PLATFORM } from '../../../js/targets/platform/index.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

/* Issue #6033: arm64e has no canonical SysV-style ABI outside Apple platforms;
 * the ABI registry fail-closes `linux + arm64e` to `unknown`, but the Linux
 * platform profile handed out a generic `aapcs64` default for the same target
 * identity.  The platform default must not contradict the canonical resolver. */

test('#6033: linux + arm64 keeps the generic AAPCS64 default', () => {
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture:'arm64' }), 'aapcs64');
  assert.equal(resolveABIPlugin({ architecture:'arm64', platform:'linux' }).id, 'aapcs64');
});

test('#6033: linux + arm64e no longer offers an aapcs64 default', () => {
  assert.equal(LINUX_PLATFORM.defaultABI({ architecture:'arm64e' }), null);
});

test('#6033: platform default agrees with the ABI registry for linux + arm64e', () => {
  const resolved = resolveABIPlugin({ architecture:'arm64e', platform:'linux' });
  assert.equal(resolved.id, 'unknown');
  const defaultABI = LINUX_PLATFORM.defaultABI({ architecture:'arm64e' });
  if (defaultABI != null) {
    assert.notEqual(defaultABI, 'aapcs64');
  }
});

test('#6033: darwin + arm64e keeps resolving to the Darwin profile', () => {
  assert.equal(resolveABIPlugin({ architecture:'arm64e', platform:'darwin' }).id, 'darwin-arm64');
});
