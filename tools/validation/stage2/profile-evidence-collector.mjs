/*
 * Exact-run producer for the Stage 2 profile denominator.  This module is
 * deliberately a producer, not a verifier: it executes canonical focused
 * tests, records their output, and publishes nothing when any prerequisite is
 * missing.  The final verifier validates the published identities again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { a2DenominatorReport } from '../machine-effects/a2-denominator.mjs';
import { phase12DenominatorReport } from '../phase12/denominator.mjs';
import { f6KnownImplementationGaps } from '../../../js/rebuild/transaction-v2.js';
import { STAGE2_PROFILE_EVIDENCE_IDS, createStage2ProfileEvidence } from '../../../js/platform/stage2-profile-evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INVENTORY_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominator-inventory.json');
const DENOMINATOR_LOCK_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominators.lock.json');
const MANAGED_MANIFEST_PATH = 'tests/stage2/fixtures/managed-real/manifest.json';
const F6_MANIFEST_PATH = 'tests/phase12/rebuild/fixtures/manifest.json';
export const PROFILE_EVIDENCE_RUN_SCHEMA = 'hex-stage2-profile-evidence-run/v1';
export const PROFILE_UNIT_PROOF_SCHEMA = 'hex-stage2-profile-unit-proof/v1';
export const PROFILE_EVIDENCE_RUN_ROOT = 'reports/stage2/profile-evidence-runs';

const RULES = Object.freeze({
  'S2-A7-NATIVE': Object.freeze({
    providerProfileIds: ['native:lldb-compatible-v1:host', 'native:remote-debug-v1:qemu-lldb'],
    sourceRefs: ['js/runtime/authority.js', 'js/platform/stage2-profile-evidence.js', 'tools/validation/stage2/a7-lldb-real-fixture.mjs', 'tools/validation/stage2/a7-cross-target-real-fixtures.mjs'],
    testRefs: ['tests/stage2/runtime-authority.test.mjs', 'tests/stage2/capability-promotion.test.mjs', 'tests/stage2/a7-lldb-real-fixture.test.mjs', 'tests/stage2/a7-cross-target-real-fixtures.test.mjs'],
    requiredProfileIds: ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
    realFixtureRefsByProfile: Object.freeze({
      'arm64:a64': Object.freeze(['tests/stage2/fixtures/a7-runtime/aarch64-a64.S']),
      'arm64e:a64+pac': Object.freeze(['tests/stage2/fixtures/a7-runtime/aarch64-pac.S']),
      'x86_64:long-64': Object.freeze(['tests/stage2/fixtures/a7-runtime/x86_64-long64.S']),
      'riscv64:rv64imc': Object.freeze(['tests/stage2/fixtures/a7-runtime/riscv64-rv64imc.S']),
    }),
    providerProofCommandIdsByProfile: Object.freeze({
      'arm64:a64':'a7-cross-target-real-fixtures', 'arm64e:a64+pac':'a7-cross-target-real-fixtures',
      'x86_64:long-64':'a7-lldb-real-fixture', 'riscv64:rv64imc':'a7-cross-target-real-fixtures',
    }),
    commandIds: ['a7-runtime-authority', 'a7-capability-promotion', 'a7-lldb-real-fixture', 'a7-cross-target-real-fixtures'],
  }),
  'S2-M6-WASM': Object.freeze({ providerProfileIds: ['managed:wasm:provider-bound-runtime-v1:test'], sourceRefs: ['js/managed/wasm/parser.js', 'js/managed/runtime-binding.js'], testRefs: ['tests/stage2/managed-runtime.test.mjs', 'tests/stage2/managed-real-fixtures.test.mjs'], commandIds: ['m6-managed-runtime', 'm6-real-fixtures'] }),
  'S2-M6-DEX': Object.freeze({ providerProfileIds: ['managed:dex:provider-bound-runtime-v1:test'], sourceRefs: ['js/managed/dex/parser.js', 'js/managed/runtime-binding.js'], testRefs: ['tests/stage2/managed-runtime.test.mjs', 'tests/stage2/managed-real-fixtures.test.mjs'], commandIds: ['m6-managed-runtime', 'm6-real-fixtures'] }),
  'S2-M6-CIL': Object.freeze({ providerProfileIds: ['managed:cil:provider-bound-runtime-v1:test'], sourceRefs: ['js/managed/cil/parser.js', 'js/managed/runtime-binding.js'], testRefs: ['tests/stage2/managed-runtime.test.mjs', 'tests/stage2/managed-real-fixtures.test.mjs'], commandIds: ['m6-managed-runtime', 'm6-real-fixtures'] }),
  'S2-M6-JVM': Object.freeze({ providerProfileIds: ['managed:jvm:provider-bound-runtime-v1:test'], sourceRefs: ['js/managed/jvm/parser.js', 'js/managed/runtime-binding.js'], testRefs: ['tests/stage2/managed-runtime.test.mjs', 'tests/stage2/managed-real-fixtures.test.mjs'], commandIds: ['m6-managed-runtime', 'm6-real-fixtures'] }),
  'S2-F6-MACHO': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/rebuild/transaction-v2.js', 'js/rebuild/format-safe.js', 'tools/validation/rebuild-independent-oracle.mjs'],
    testRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs', 'tests/stage2/rebuild-transaction.test.mjs', 'tests/stage2/independent-oracle.test.mjs'],
    negativeTestRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs'],
    f6Profiles: ['macho:64'],
    commandIds: ['f6-real-rebuild'],
    independentOracleCommandIds: ['f6-real-rebuild'],
  }),
  'S2-F6-ELF': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/rebuild/transaction-v2.js', 'js/rebuild/format-safe.js', 'tools/validation/rebuild-independent-oracle.mjs'],
    testRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs', 'tests/stage2/rebuild-transaction.test.mjs', 'tests/stage2/independent-oracle.test.mjs'],
    negativeTestRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs'],
    f6Profiles: ['elf:64'],
    commandIds: ['f6-real-rebuild'],
    independentOracleCommandIds: ['f6-real-rebuild'],
  }),
  'S2-F6-PE': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/rebuild/transaction-v2.js', 'js/rebuild/format-safe.js', 'tools/validation/rebuild-independent-oracle.mjs'],
    testRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs', 'tests/stage2/rebuild-transaction.test.mjs', 'tests/stage2/independent-oracle.test.mjs'],
    negativeTestRefs: ['tests/phase12/rebuild/f6-real-fixtures.test.mjs'],
    f6Profiles: ['pe:pe32', 'pe:pe32+'],
    commandIds: ['f6-real-rebuild'],
    independentOracleCommandIds: ['f6-real-rebuild'],
  }),
  'S2-P12-KNOWLEDGE': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/phase12/package-envelope.js', 'js/knowledge/phase12-recognition.js', 'js/signature/index.js'],
    testRefs: ['tests/phase12/knowledge/package.test.mjs'],
    negativeTestRefs: ['tests/phase12/knowledge/package.test.mjs'],
    realFixtureRefs: ['tests/phase12/fixtures/profile-evidence/knowledge-package.json'],
    commandIds: ['p12-knowledge'],
  }),
  'S2-P12-RULES': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/knowledge/phase12-rules.js'],
    testRefs: ['tests/phase12/knowledge/rules.test.mjs'],
    negativeTestRefs: ['tests/phase12/knowledge/rules.test.mjs'],
    realFixtureRefs: ['tests/phase12/fixtures/profile-evidence/capability-rule.json'],
    commandIds: ['p12-rules'],
  }),
  'S2-P12-PATTERNS': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/pattern/index.js'],
    testRefs: ['tests/phase12/pattern/evaluator.test.mjs'],
    negativeTestRefs: ['tests/phase12/pattern/evaluator.test.mjs'],
    realFixtureRefs: ['tests/phase12/fixtures/profile-evidence/pattern-struct.json'],
    commandIds: ['p12-patterns'],
  }),
  'S2-P12-COLLAB-REMOTE': Object.freeze({
    providerProfileIds: [],
    sourceRefs: ['js/collaboration/remote-authority.js', 'js/collaboration/remote-transport.js'],
    testRefs: ['tests/stage2/remote-collaboration.test.mjs', 'tests/stage2/remote-canonical-transport.test.mjs'],
    negativeTestRefs: ['tests/stage2/remote-canonical-transport.test.mjs'],
    activeTransportCommandIds: ['p12-remote-transport'],
    commandIds: ['p12-remote-transport'],
    independentOracleCommandIds: ['p12-remote-transport'],
  }),
});
export const PROFILE_UNIT_PROOF_RULES = RULES;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return { status: result.status, stdout: result.stdout?.trim() || '', stderr: result.stderr?.trim() || '' };
}
function gitIdentity(relative) {
  if (!relative || path.posix.normalize(relative) !== relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\\')) throw new Error(`profile-proof-ref-invalid:${relative}`);
  const result = git(['rev-parse', `HEAD:${relative}`], true);
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout)) throw new Error(`profile-proof-ref-untracked:${relative}`);
  return `git:${relative}@${result.stdout}`;
}
function fixtureIdentity(relative) {
  const resolved = path.join(ROOT, relative);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`profile-proof-fixture-missing:${relative}`);
  return `artifact:${relative}@sha256:${sha256(fs.readFileSync(resolved))}`;
}
function canonicalHead() {
  const commitSha = git(['rev-parse', 'HEAD']).stdout;
  const treeSha = git(['rev-parse', 'HEAD^{tree}']).stdout;
  if (!/^[0-9a-f]{40}$/.test(commitSha) || !/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('profile-proof-head-invalid');
  return { commitSha, treeSha };
}
function assertClean() {
  const status = git(['status', '--porcelain', '--untracked-files=all']).stdout;
  if (status) throw new Error('profile-proof-worktree-dirty');
}
function loadInventory() {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  if (!inventory.items || typeof inventory.items !== 'object') throw new Error('profile-proof-inventory-invalid');
  return inventory;
}
function managedFixtureMap() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANAGED_MANIFEST_PATH), 'utf8'));
  if (manifest.schemaVersion !== 'hex-stage2-managed-real-fixtures/v1' || !Array.isArray(manifest.fixtures)) throw new Error('profile-proof-managed-manifest-invalid');
  const result = new Map();
  for (const fixture of manifest.fixtures) {
    if (!['wasm', 'dex', 'cil', 'jvm'].includes(fixture.frontendId) || result.has(fixture.frontendId) || fixture.real === false) continue;
    const relative = path.posix.join(path.posix.dirname(MANAGED_MANIFEST_PATH), fixture.path);
    if (!fs.existsSync(path.join(ROOT, relative))) continue;
    result.set(fixture.frontendId, { fixture, relative });
  }
  return result;
}
function f6FixtureMap() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, F6_MANIFEST_PATH), 'utf8'));
  if (manifest.schemaVersion !== 'f6-real-rebuild-fixtures/v1' || !Array.isArray(manifest.fixtures)) throw new Error('profile-proof-f6-manifest-invalid');
  const required = new Set(['macho:64', 'elf:64', 'pe:pe32', 'pe:pe32+']);
  const found = new Map();
  for (const fixture of manifest.fixtures) if (fixture.real === true && required.has(fixture.profile)) found.set(fixture.profile, path.posix.normalize(fixture.path));
  return { manifest, found, missing: [...required].filter((profile) => !found.has(profile)) };
}

export function inspectProfileEvidencePrerequisites() {
  const failures = [];
  // A run that omits a denominator item can never be consumed by the final
  // verifier.  Keep this check here, before any command is executed, so a
  // future closure of the current A2/F6/Phase12 gaps cannot accidentally turn
  // this five-item producer into a partial publication.
  const missingRules = STAGE2_PROFILE_EVIDENCE_IDS.filter((itemId) => !Object.hasOwn(RULES, itemId));
  const unexpectedRules = Object.keys(RULES).filter((itemId) => !STAGE2_PROFILE_EVIDENCE_IDS.includes(itemId));
  failures.push(...missingRules.map((itemId) => `missing-profile-proof-rule:${itemId}`));
  failures.push(...unexpectedRules.map((itemId) => `unexpected-profile-proof-rule:${itemId}`));
  const a2 = a2DenominatorReport().validation;
  if (a2.terminalEligible !== true) failures.push(...(a2.blockingGaps || []).map((gap) => `known-a2-gap:${gap}`));
  failures.push(...f6KnownImplementationGaps().map((gap) => `known-f6-gap:${gap}`));
  const phase12 = phase12DenominatorReport();
  if (phase12.valid !== true) failures.push('phase12-denominator-invalid');
  else if (phase12.terminalEligible !== true) failures.push(...(phase12.blockingGaps || []).map((gap) => `known-phase12-gap:${gap}`));
  const managed = managedFixtureMap();
  if (!managed.has('dex')) failures.push('missing-real-compiled-fixture:dex');
  const f6 = f6FixtureMap();
  failures.push(...f6.missing.map((profile) => `missing-real-rebuild-fixture:${profile}`));
  for (const [itemId, rule] of Object.entries(RULES)) {
    if (Array.isArray(rule.requiredProfileIds)) {
      for (const profileId of rule.requiredProfileIds) {
        const refs = rule.realFixtureRefsByProfile?.[profileId] || [];
        if (refs.length === 0 || refs.some((ref) => !fs.existsSync(path.join(ROOT, ref)))) failures.push(`missing-real-profile-fixture:${itemId}:${profileId}`);
        if (!rule.providerProofCommandIdsByProfile?.[profileId]) failures.push(`missing-active-provider-proof:${itemId}:${profileId}`);
      }
      continue;
    }
    const staticFixtures = (rule.realFixtureRefs || []).filter((ref) => fs.existsSync(path.join(ROOT, ref)));
    const managedFixture = itemId.startsWith('S2-M6-') && managed.has(itemId.slice('S2-M6-'.length).toLowerCase());
    const f6Fixtures = Array.isArray(rule.f6Profiles) && rule.f6Profiles.length > 0 && rule.f6Profiles.every((profile) => f6.found.has(profile));
    const activeTransport = Array.isArray(rule.activeTransportCommandIds) && rule.activeTransportCommandIds.length > 0
      && rule.activeTransportCommandIds.every((id) => rule.commandIds.includes(id));
    if (staticFixtures.length === 0 && !managedFixture && !f6Fixtures && !activeTransport) failures.push(`missing-real-profile-fixture:${itemId}`);
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures), managed, f6 });
}

function runCanonical(id, args) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1' } });
  return Object.freeze({ id, argv: [process.execPath, ...args], status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, signal: result.signal || null, durationMs: Date.now() - startedAt, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') });
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function relativeRunPath(runId, name) { return `${PROFILE_EVIDENCE_RUN_ROOT}/${runId}/${name}`; }
function writeRun(outputDir, run) {
  const parent = path.dirname(outputDir);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(outputDir)) throw new Error('profile-proof-output-already-exists');
  const temp = fs.mkdtempSync(path.join(parent, '.profile-evidence-run-'));
  try {
    for (const [name, value] of Object.entries(run.files)) fs.writeFileSync(path.join(temp, name), jsonBytes(value), { flag: 'wx' });
    const manifest = { ...run };
    delete manifest.files;
    fs.writeFileSync(path.join(temp, 'manifest.json'), jsonBytes(manifest), { flag: 'wx' });
    fs.renameSync(temp, outputDir);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export function collectProfileEvidence({ expectedCommitSha, expectedTreeSha, outputDir, runId = `run-${Date.now().toString(36)}` } = {}) {
  assertClean();
  const head = canonicalHead();
  if (String(expectedCommitSha || '').toLowerCase() !== head.commitSha) throw new Error('profile-proof-stale-commit');
  if (String(expectedTreeSha || '').toLowerCase() !== head.treeSha) throw new Error('profile-proof-stale-tree');
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(runId)) throw new Error('profile-proof-run-id-invalid');
  const prerequisites = inspectProfileEvidencePrerequisites();
  if (!prerequisites.ok) throw new Error(`profile-proof-prerequisites-incomplete:${prerequisites.failures.join(',')}`);
  const destination = outputDir || path.join(ROOT, PROFILE_EVIDENCE_RUN_ROOT, runId);
  if (path.resolve(destination) !== path.join(ROOT, PROFILE_EVIDENCE_RUN_ROOT, runId)) throw new Error('profile-proof-output-path-invalid');
  const inventory = loadInventory();
  const denominatorLock = JSON.parse(fs.readFileSync(DENOMINATOR_LOCK_PATH, 'utf8'));
  const commands = [
    runCanonical('a7-runtime-authority', ['tests/stage2/runtime-authority.test.mjs']),
    runCanonical('a7-capability-promotion', ['tests/stage2/capability-promotion.test.mjs']),
    runCanonical('a7-lldb-real-fixture', ['tests/stage2/a7-lldb-real-fixture.test.mjs']),
    runCanonical('a7-cross-target-real-fixtures', ['tests/stage2/a7-cross-target-real-fixtures.test.mjs']),
    runCanonical('m6-managed-runtime', ['tests/stage2/managed-runtime.test.mjs']),
    runCanonical('m6-real-fixtures', ['tests/stage2/managed-real-fixtures.test.mjs']),
    runCanonical('f6-real-rebuild', ['tests/phase12/rebuild/f6-real-fixtures.test.mjs']),
    runCanonical('p12-knowledge', ['tests/phase12/knowledge/package.test.mjs']),
    runCanonical('p12-rules', ['tests/phase12/knowledge/rules.test.mjs']),
    runCanonical('p12-patterns', ['tests/phase12/pattern/evaluator.test.mjs']),
    runCanonical('p12-remote-transport', ['tests/stage2/remote-canonical-transport.test.mjs']),
  ];
  const commandProofMarkers = Object.freeze({
    'a7-lldb-real-fixture': '[stage2] active x86 LLDB A7 provider proof passed; canonical evidence assembly remains required',
    'a7-cross-target-real-fixtures': '[stage2] active AArch64/PAC/RV64 LLDB remote provider proofs passed',
    'm6-real-fixtures': 'deterministic real managed fixtures passed for wasm/dex/cil/jvm',
    'f6-real-rebuild': 'F6_REAL_REBUILD_PROOF=',
    'p12-knowledge': '[phase12] package/provenance/recognition tests passed',
    'p12-rules': '[phase12] deterministic capability-rule tests passed',
    'p12-patterns': '[phase12] bounded declarative pattern tests passed',
    'p12-remote-transport': '[stage2] canonical encrypted remote transport and independent Ed25519 oracle passed',
  });
  if (commands.some((command) => command.status !== 'passed')) throw new Error(`profile-proof-command-failed:${commands.filter((command) => command.status !== 'passed').map((command) => command.id).join(',')}`);
  for (const [id, marker] of Object.entries(commandProofMarkers)) {
    if (!commands.find((command) => command.id === id)?.stdout.includes(marker)) throw new Error(`profile-proof-command-marker-missing:${id}`);
  }
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const files = {};
  const commandOutputIdentity = (command) => {
    const name = `command-${command.id}.json`;
    const output = { schemaVersion: 'hex-stage2-profile-command-output/v1', commandId: command.id, candidateCommitSha: head.commitSha, candidateTreeSha: head.treeSha, status: command.status, exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr };
    files[name] = output;
    return `artifact:${relativeRunPath(runId, name)}@sha256:${sha256(jsonBytes(output))}`;
  };
  const commandOutputIdentities = new Map(commands.map((command) => [command.id, commandOutputIdentity(command)]));
  const items = {};
  for (const [itemId, rule] of Object.entries(RULES)) {
    const denominator = inventory.items[itemId];
    if (!denominator || !Array.isArray(denominator.unitIds) || !denominator.unitIds.length) throw new Error(`profile-proof-denominator-missing:${itemId}`);
    const sourceIdentities = rule.sourceRefs.map(gitIdentity);
    const testIdentities = rule.testRefs.map(gitIdentity);
    const fixture = itemId.startsWith('S2-M6-') ? prerequisites.managed.get(itemId.slice('S2-M6-'.length).toLowerCase()) : null;
    const f6FixtureRefs = (rule.f6Profiles || []).map((profile) => prerequisites.f6.found.get(profile)).filter(Boolean);
    const profileFixtureRefs = (rule.requiredProfileIds || []).flatMap((profile) => rule.realFixtureRefsByProfile?.[profile] || []);
    const realFixtureIdentities = [
      ...(Array.isArray(rule.realFixtureRefs) ? rule.realFixtureRefs.map(fixtureIdentity) : []),
      ...(fixture ? [fixtureIdentity(fixture.relative), fixtureIdentity(MANAGED_MANIFEST_PATH)] : []),
      ...f6FixtureRefs.map(fixtureIdentity),
      ...(f6FixtureRefs.length ? [fixtureIdentity(F6_MANIFEST_PATH)] : []),
      ...profileFixtureRefs.map(fixtureIdentity),
      ...(rule.activeTransportCommandIds || []).map((id) => commandOutputIdentities.get(id)),
    ];
    const negativeTestIdentities = (rule.negativeTestRefs || rule.testRefs).map(gitIdentity);
    const independentOracleIdentities = (rule.independentOracleCommandIds || []).map((id) => commandOutputIdentities.get(id));
    const unitEvidence = {};
    for (const unitId of denominator.unitIds) {
      const commandSummaries = rule.commandIds.map((id) => commandById.get(id));
      // Test identities are not real-fixture identities.  A missing canonical
      // fixture must block the run instead of being silently replaced with a
      // test file (or any other arbitrary tracked file).
      if (realFixtureIdentities.length === 0) throw new Error(`profile-proof-real-fixture-missing:${itemId}`);
      const proof = { schemaVersion: PROFILE_UNIT_PROOF_SCHEMA, itemId, unitId, candidateCommitSha: head.commitSha, candidateTreeSha: head.treeSha, status: 'passed', commandIds: rule.commandIds, commandOutputIdentities: rule.commandIds.map((id) => commandOutputIdentities.get(id)), commandOutputDigests: commandSummaries.map((command) => `sha256:${sha256(`${command.stdout}\n${command.stderr}`)}`), sourceIdentities, testIdentities, providerProfileIds: rule.providerProfileIds, realFixtureIdentities, negativeTestIdentities, independentOracleIdentities };
      const name = `${itemId.toLowerCase()}-${sha256(unitId).slice(0, 16)}.json`;
      files[name] = proof;
      unitEvidence[unitId] = `artifact:${relativeRunPath(runId, name)}@sha256:${sha256(jsonBytes(proof))}`;
    }
    items[itemId] = { profileIds: denominator.profiles, unitIds: denominator.unitIds, providerProfileIds: rule.providerProfileIds, sourceIdentities, testIdentities, realFixtureIdentities, negativeTestIdentities, independentOracleIdentities, unitEvidence };
  }
  const generatedAt = new Date().toISOString();
  const profileEvidence = createStage2ProfileEvidence({
    commitSha: head.commitSha,
    treeSha: head.treeSha,
    generatedAt,
    items: Object.fromEntries(Object.entries(items).map(([itemId, item]) => {
      const denominator = denominatorLock.items?.[itemId];
      return [itemId, {
        profileIds: item.profileIds,
        candidateCommitSha: head.commitSha,
        candidateTreeSha: head.treeSha,
        denominatorId: denominator?.id,
        denominatorLockHash: denominator?.lockHash,
        coveredUnitIds: item.unitIds,
        unitEvidence: item.unitEvidence,
        realFixtureIdentities: item.realFixtureIdentities,
        negativeTestIdentities: item.negativeTestIdentities,
        evidenceIdentities: RULES[itemId].commandIds.map((id) => commandOutputIdentities.get(id)),
        providerProfileIds: item.providerProfileIds,
        implementationIdentity: item.sourceIdentities[0],
        independentOracleIdentities: item.independentOracleIdentities,
      }];
    })),
  });
  files['profile-evidence.json'] = profileEvidence;
  const profileEvidenceIdentity = `artifact:${relativeRunPath(runId, 'profile-evidence.json')}@sha256:${sha256(jsonBytes(profileEvidence))}`;
  const run = { schemaVersion: PROFILE_EVIDENCE_RUN_SCHEMA, runId, candidateCommitSha: head.commitSha, candidateTreeSha: head.treeSha, generatedAt, profileEvidenceIdentity, commands: commands.map(({ stdout, stderr, ...summary }) => ({ ...summary, outputIdentity: commandOutputIdentities.get(summary.id), stdoutDigest: `sha256:${sha256(stdout)}`, stderrDigest: `sha256:${sha256(stderr)}`, proofMarker: commandProofMarkers[summary.id] || null })), items, files };
  writeRun(destination, run);
  return Object.freeze({ outputDir: destination, run });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  try {
    const result = collectProfileEvidence({ expectedCommitSha: value('--commit'), expectedTreeSha: value('--tree'), outputDir: value('--output'), runId: value('--run-id') || undefined });
    process.stdout.write(`${JSON.stringify({ ok: true, outputDir: result.outputDir, runId: result.run.runId, profileEvidenceIdentity: result.run.profileEvidenceIdentity })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
