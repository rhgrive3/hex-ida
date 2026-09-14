import test from 'node:test';

// The standalone script imports architecture-abi.mjs. Keep that entire public
// compatibility surface in canonical recursive Phase4 discovery: a passing
// core group alone previously left its first assertion failure unobserved.
test('public script and architecture/ABI compatibility regressions', async () => {
  await import('../issues-454-455-script-architecture.mjs');
});
