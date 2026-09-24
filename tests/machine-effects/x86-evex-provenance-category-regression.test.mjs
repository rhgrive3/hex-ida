import assert from 'node:assert/strict';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { classifyEvexCategory } from '../../js/targets/architecture/x86_64/effects/extended-state-evex.js';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';

// Verify EVEX blend category classification
assert.equal(classifyEvexCategory('vblendmps'), 'simd');
assert.equal(classifyEvexCategory('vblendmpd'), 'simd');
assert.equal(classifyEvexCategory('vaddps'), 'fp');

// Verify public decoder without receiver provenance remains fail-closed
const capstone = await createCapstoneX86Session();
try {
  const raw = capstone.decode([0x62, 0xf2, 0x6d, 0x08, 0x65, 0xc1], 0x750000n)[0];
  const bundle = liftX86MachineEffects(raw, { instructionId: 'regress:vblendmps:public' });
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects?.reason, 'x86-evex-trusted-decoder-provenance-required');
} finally {
  capstone.close();
}

// Verify browser receiver provenance correctly preserves receiver brand and attributes category
await forEachX86BrowserSession(async ({ decodeAndLift }) => {
  const [{ decoded: raw, effects: bundle }] = await decodeAndLift([0x62, 0xf2, 0x6d, 0x08, 0x65, 0xc1], 0x750000n);
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.equal(bundle.metadata?.category, 'simd');
  const intrinsic = bundle.operations.find(op => op.kind === 'intrinsic');
  assert.equal(intrinsic?.metadata?.category, 'simd');
  assert.equal(bundle.possibleFaults.some(f => f.kind === 'x86-simd-floating-point-exception'), false);
});

console.log('x86 EVEX provenance and category regression: PASS');
