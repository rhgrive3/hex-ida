import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';

// #6015: the Darwin ARM64 plugin's platform allowlist omitted the simulator
// platform identifiers that the rest of the ABI layer already recognizes
// (registry APPLE_ARM64E_PLATFORMS, AAPCS64 APPLE_X18_RESERVED), so
// arm64/arm64e + ios-simulator fell through every predicate to `unknown`.

for (const platform of ['ios-simulator', 'ipados-simulator', 'tvos-simulator', 'watchos-simulator', 'visionos-simulator', 'maccatalyst']) {
  const arm64 = resolveABIPlugin({ architecture: 'arm64', platform });
  assert.equal(arm64.id, 'darwin-arm64', `arm64 + ${platform} must resolve to the Darwin ARM64 ABI`);
  const arm64e = resolveABIPlugin({ architecture: 'arm64e', platform });
  assert.equal(arm64e.id, 'darwin-arm64', `arm64e + ${platform} must resolve to the Darwin ARM64 ABI`);
}

// Existing resolutions unchanged.
assert.equal(resolveABIPlugin({ architecture: 'arm64', platform: 'ios' }).id, 'darwin-arm64');
assert.equal(resolveABIPlugin({ architecture: 'arm64', platform: 'darwin' }).id, 'darwin-arm64');
assert.equal(resolveABIPlugin({ architecture: 'arm64', platform: 'linux' }).id, 'aapcs64');
assert.notEqual(resolveABIPlugin({ architecture: 'x86_64', platform: 'ios-simulator' }).id, 'darwin-arm64', 'non-ARM64 architectures must not claim the Darwin ARM64 plugin');

console.log('ABI auto-resolution Darwin ARM64 simulator platforms (#6015): PASS');
