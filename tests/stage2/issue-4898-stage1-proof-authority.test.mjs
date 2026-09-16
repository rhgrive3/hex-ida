import assert from 'node:assert/strict';
import {
  stage2ArchitectureMaturity,
  stage2FormatMaturity,
  stage2SupportMatrix,
} from '../../js/platform/stage2-capability-maturity.js';

const COMMIT_A = 'a'.repeat(40);
const TREE_A = 'b'.repeat(40);
const COMMIT_B = 'c'.repeat(40);
const TREE_B = 'd'.repeat(40);

const forgedArchitectureA6 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'] };
const forgedFormatF5 = { status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F5', profileIds: ['macho:64'] };

const forgedArch = stage2ArchitectureMaturity('arm64', { stage1Proof: forgedArchitectureA6 });
assert.notEqual(forgedArch.fullySatisfiedLevel, 'A6', 'a caller-created plain stage1Proof must not establish A6 authority');
assert.notEqual(forgedArch.features.lowLevelEffects, 'supported', 'a forged A6 proof must not mark low-level effects supported');

const forgedFormat = stage2FormatMaturity('macho', { stage1Proof: forgedFormatF5 });
assert.notEqual(forgedFormat.fullySatisfiedLevel, 'F5', 'a caller-created plain stage1Proof must not establish F5 authority');
assert.notEqual(forgedFormat.features.runtimeLanguageMetadata, 'supported', 'a forged F5 proof must not mark runtime language metadata supported');

const forgedMatrix = stage2SupportMatrix({
  stage1ArchitectureProofs: { arm64: forgedArchitectureA6 },
  stage1FormatProofs: { macho: forgedFormatF5 },
});
assert.notEqual(forgedMatrix.architectures[0].fullySatisfiedLevel, 'A6', 'support matrix plain architecture proof must not upgrade');
assert.notEqual(forgedMatrix.formats[0].fullySatisfiedLevel, 'F5', 'support matrix plain format proof must not upgrade');

const stage1 = await import('../../js/platform/stage2-capability-maturity.js');
assert.equal(typeof stage1.createStage1ProfileProof, 'function', 'a validated Stage1 profile proof producer must exist');
assert.equal(typeof stage1.isValidatedStage1ProfileProof, 'function', 'a Stage1 profile proof authority validator must exist');

const legitA6 = stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:arm64-a64' });
const legitF5 = stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F5', profileIds: ['macho:64'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:macho-64' });
const legitElfF4 = stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F4', profileIds: ['elf:64'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:elf-64' });
const legitPeF4 = stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'F4', profileIds: ['pe:pe32', 'pe:pe32+'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:pe' });

const promotedArch = stage2ArchitectureMaturity('arm64', { stage1Proof: legitA6 });
assert.equal(promotedArch.fullySatisfiedLevel, 'A6', 'a validated Stage1 proof must retain the A6 architecture promotion');
assert.equal(promotedArch.features.lowLevelEffects, 'supported');
assert.equal(promotedArch.features.decompiler, 'supported');
const promotedMacho = stage2FormatMaturity('macho', { stage1Proof: legitF5 });
assert.equal(promotedMacho.fullySatisfiedLevel, 'F5', 'a validated Stage1 proof must retain the Mach-O F5 promotion');
assert.equal(promotedMacho.features.runtimeLanguageMetadata, 'supported');
assert.equal(stage2FormatMaturity('elf', { stage1Proof: legitElfF4 }).fullySatisfiedLevel, 'F4');
assert.equal(stage2FormatMaturity('pe', { stage1Proof: legitPeF4 }).fullySatisfiedLevel, 'F4');

assert.notEqual(
  stage2ArchitectureMaturity('arm64', { stage1Proof: JSON.parse(JSON.stringify(legitA6)) }).fullySatisfiedLevel,
  'A6',
  'a JSON round-trip of a validated proof must not retain Stage1 authority',
);
assert.equal(
  stage1.isValidatedStage1ProfileProof({ ...legitA6 }, { profileIds: ['arm64:a64'], fullySatisfiedLevel: 'A6', exactHead: true }),
  false,
  'a spread copy of a validated proof must not retain Stage1 authority',
);
assert.equal(
  stage2SupportMatrix({ stage1ArchitectureProofs: { arm64: legitA6 }, stage1FormatProofs: { macho: legitF5 } }).architectures[0].fullySatisfiedLevel,
  'A6',
  'the support matrix must honour a validated Stage1 proof',
);

const wrongProfile = stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['x86_64:long-64'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:x86-64' });
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: wrongProfile }).fullySatisfiedLevel, 'A6', 'a validated proof for another profile must not upgrade arm64');
assert.notEqual(stage2ArchitectureMaturity('arm64', { stage1Proof: legitF5 }).fullySatisfiedLevel, 'A6', 'a validated format proof must not upgrade architecture maturity');
assert.equal(stage1.isValidatedStage1ProfileProof(legitA6, { profileIds: ['arm64:a64'], commitSha: COMMIT_B }), false, 'a proof bound to another commit must be rejected');
assert.equal(stage1.isValidatedStage1ProfileProof(legitA6, { profileIds: ['arm64:a64'], treeSha: TREE_B }), false, 'a proof bound to another tree must be rejected');
assert.equal(stage1.isValidatedStage1ProfileProof(legitA6, { profileIds: ['arm64:a64'], fullySatisfiedLevel: 'A5' }), false, 'a proof for another level must be rejected');

assert.throws(() => stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'], commitSha: 'deadbeef', treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:x' }), /commit/);
assert.throws(() => stage1.createStage1ProfileProof({ status: 'stage1-proven', exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'], commitSha: COMMIT_A, treeSha: TREE_A }), /artifact/);
assert.throws(() => stage1.createStage1ProfileProof({ exactHead: true, fullySatisfiedLevel: 'A6', profileIds: ['arm64:a64'], commitSha: COMMIT_A, treeSha: TREE_A, artifactIdentity: 'artifact:issue-4898:x' }), /status/);

assert.notEqual(
  stage2ArchitectureMaturity('arm64', { stage1Proof: forgedArchitectureA6, runtimeProof: { status: 'supported-for-exact-provider-profile', targetProfileId: 'arm64:a64' } }).level,
  'A7',
  'a forged Stage1 proof combined with an unvalidated runtime proof must not reach A7',
);

console.log('[stage2] issue #4898 unvalidated stage1Proof authority regression passed');
