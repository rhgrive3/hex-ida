import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  X86_LONG64_BASE_FEATURE_STATE,
  X86_LONG64_BASE_PROFILE_ID,
  X86_LONG64_FEATURE_PROFILE,
  X86_LONG64_RESERVED_FEATURE_PROFILES,
  resolveX86Long64FeatureEnvelope,
} from '../../js/targets/architecture/x86_64/feature-contract.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

assert.equal(X86_LONG64_BASE_PROFILE_ID, 'x86_64:long-64');
assert.deepEqual(X86_LONG64_BASE_FEATURE_STATE, {
  cet:{ shadowStackEnabled:false, indirectBranchTrackingEnabled:false },
  mpx:{ enabled:false, bndPreserve:null },
});
assert.match(X86_LONG64_FEATURE_PROFILE.scopeResolution, /without-denominator-subtraction/);
assert.notEqual(X86_LONG64_RESERVED_FEATURE_PROFILES.cetShadowStack, X86_LONG64_BASE_PROFILE_ID);
assert.notEqual(X86_LONG64_RESERVED_FEATURE_PROFILES.mpx, X86_LONG64_BASE_PROFILE_ID);

assert.equal(resolveX86Long64FeatureEnvelope().supported, true);
for (const state of [
  { cet:{ shadowStackEnabled:true } },
  { cet:{ indirectBranchTrackingEnabled:true } },
  { mpx:{ enabled:true, bndPreserve:false } },
  { mpx:{ enabled:true, bndPreserve:true } },
]) assert.equal(resolveX86Long64FeatureEnvelope({}, { x86FeatureState:state }).supported, false);
assert.equal(resolveX86Long64FeatureEnvelope({}, { targetProfileId:X86_LONG64_RESERVED_FEATURE_PROFILES.cetShadowStack }).supported, false);
assert.equal(resolveX86Long64FeatureEnvelope({}, { targetProfileId:X86_LONG64_RESERVED_FEATURE_PROFILES.mpx }).supported, false);
assert.equal(resolveX86Long64FeatureEnvelope({}, { x86FeatureState:{ mpx:{ enabled:false, bndPreserve:true } } }).reason, 'x86-feature-state-malformed');

const call = createX86DecodedInstruction({
  instructionId:'x86-feature-contract:same-call', instructionCode:1, instructionFamily:'call',
  address:0x7000n, length:5, rawBytes:Uint8Array.from([0xe8,0,0,0,0]), mode:'long-64',
  detailAvailable:true, detailStatus:'complete',
  detail:{ operandCount:1, operands:[{type:'immediate',value:0x7100n,access:'read'}], implicitReads:[], implicitWrites:[], addressSizeBits:64, prefixes:{legacy:[],rex:null,vector:null} },
});
const baseBundle = liftX86MachineEffects(call);
assert.ok(['exact','exact-with-intrinsic'].includes(baseBundle.completeness));
for (const featureState of [
  { cet:{ shadowStackEnabled:true } },
  { mpx:{ enabled:true, bndPreserve:false } },
]) {
  const featureBundle = liftX86MachineEffects(call, { x86FeatureState:featureState });
  assert.equal(featureBundle.completeness, 'partial');
  assert.equal(featureBundle.controlEffect.kind, 'unknown');
  assert.notDeepEqual(featureBundle, baseBundle, 'same decoded instruction must discriminate feature state');
}

const lock = JSON.parse(fs.readFileSync(new URL('../../tools/validation/stage2/completion-scope.lock.json', import.meta.url), 'utf8'));
assert.equal(lock.growthOnly, true);
assert.ok(lock.architectureProfiles.includes('x86_64:long-64'));
assert.ok(lock.architectureInstructionProfiles.includes('x86_64:declared-long64-contract'));
assert.equal(lock.architectureProfiles.some((id) => /cet|mpx/i.test(id)), false, 'frozen lock did not predefine a CET/MPX-enabled x86 profile');
assert.equal(lock.architectureInstructionProfiles.some((id) => /cet|mpx/i.test(id)), false, 'frozen instruction contract did not state CET/MPX inclusion/exclusion');
console.log('x86 long-64 feature contract: PASS');
