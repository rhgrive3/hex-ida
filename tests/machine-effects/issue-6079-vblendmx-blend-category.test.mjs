import assert from 'node:assert/strict';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { classifyEvexCategory } from '../../js/targets/architecture/x86_64/effects/extended-state-evex.js';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';

// #6079: VBLENDMPS/VBLENDMPD are opmask-controlled blends with no floating
// point arithmetic (Intel SDM: SIMD Floating-Point Exceptions: None). The
// generic EVEX owner classified them as `fp` and minted MXCSR read/write and
// an architecturally nonexistent #XM candidate.
assert.equal(classifyEvexCategory('vblendmps'), 'simd');
assert.equal(classifyEvexCategory('vblendmpd'), 'simd');

// Genuine FP EVEX families keep the fp category.
assert.equal(classifyEvexCategory('vaddps'), 'fp');
assert.equal(classifyExUnchanged('vfmadd231ps'), 'fp');

function classifyExUnchanged(name) {
  return classifyEvexCategory(name);
}

const blendFixtures = [
    ['vblendmps', [0x62, 0xf2, 0x6d, 0x08, 0x65, 0xc1]],
    ['vblendmpd', [0x62, 0xf2, 0xed, 0x08, 0x65, 0xc1]],
];
const fpEncoding = [0x62, 0xf2, 0x77, 0x48, 0x9a, 0x01];
const capstone = await createCapstoneX86Session();
try {
  for (const [label, encoding] of [...blendFixtures, ['v4fmaddps', fpEncoding]]) {
    const raw = capstone.decode(encoding, 0x750000n)[0];
    assert.ok(raw, `${label}: decoder fixture must decode`);
    assert.equal(raw.mnemonic, label);
    const bundle = liftX86MachineEffects(raw, { instructionId: `vblend-mxcsr-${label}` });
    assert.equal(bundle?.completeness, 'partial', `${label}: public decoder rows lack receiver authority`);
    assert.equal(bundle.unknownEffects?.reason, 'x86-evex-trusted-decoder-provenance-required');
  }
} finally { capstone.close(); }

await forEachX86BrowserSession(async ({ decodeAndLift }) => {
  for (const [label, encoding] of blendFixtures) {
    const [{ decoded:raw, effects:bundle }] = await decodeAndLift(encoding, 0x750000n);
    assert.equal(raw.mnemonic, label);
    assert.equal(bundle?.completeness, 'exact-with-intrinsic', `${label}: ${bundle?.unknownEffects?.reason}`);
    const intrinsic = bundle.operations.find((operation) => operation.kind === 'intrinsic');
    assert.ok(intrinsic, `${label}: intrinsic required`);
    const reads = intrinsic.effectSummary.registersRead;
    const writes = intrinsic.effectSummary.registersWritten;
    assert.equal(reads.includes('mxcsr'), false, `${label}: MXCSR read must not be minted`);
    assert.equal(writes.includes('mxcsr'), false, `${label}: MXCSR write must not be minted`);
    assert.equal(intrinsic.metadata.fpEnvironmentDependency, undefined, `${label}: no FP environment dependency`);
    assert.equal(bundle.possibleFaults.some((fault) => fault.kind === 'x86-simd-floating-point-exception'), false, `${label}: no #XM candidate`);
    assert.equal(bundle.metadata.category ?? intrinsic.metadata.category, 'simd');
  }

// Genuine FP EVEX families keep their MXCSR dependency and #XM candidate.
// v4fmaddps is a generic-owner FP family (EVEX.512.F2.0F38.W0 9A).
const [{ effects:fpBundle }] = await decodeAndLift(fpEncoding, 0x750000n);
assert.equal(fpBundle?.completeness, 'exact-with-intrinsic', fpBundle?.unknownEffects?.reason);
const fpIntrinsic = fpBundle.operations.find((operation) => operation.kind === 'intrinsic');
assert.equal(fpIntrinsic.metadata.fpEnvironmentDependency, 'MXCSR', 'real FP generic EVEX keeps the MXCSR dependency');
assert.ok(fpIntrinsic.effectSummary.registersRead.includes('mxcsr'));
});

console.log('x86 EVEX VBLENDMP* blend-category authority (#6079): PASS');
