import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePhysicalIPadEvidence } from '../../../js/platform/physical-ipad-evidence.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { STAGE2_PROFILE_EVIDENCE_IDS, validateStage2DenominatorLock, validateStage2ProfileEvidence } from '../../../js/platform/stage2-profile-evidence.js';
import { a2DenominatorReport } from '../machine-effects/a2-denominator.mjs';
import { phase12DenominatorReport } from '../phase12/denominator.mjs';
import { f6KnownImplementationGaps } from '../../../js/rebuild/transaction-v2.js';
import { PROFILE_EVIDENCE_RUN_ROOT, PROFILE_UNIT_PROOF_RULES, PROFILE_UNIT_PROOF_SCHEMA } from './profile-evidence-collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_PATH = path.join(ROOT, 'reports/stage2/stage2-verdict.json');
const SCOPE_PATH = path.join(ROOT, 'tools/validation/stage2/completion-scope.lock.json');
const LEDGER_PATH = path.join(ROOT, 'tools/validation/stage2/closure-ledger.json');
const DENOMINATOR_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominators.lock.json');
const DENOMINATOR_INVENTORY_PATH = path.join(ROOT, 'tools/validation/stage2/profile-denominator-inventory.json');
const OUTPUT_LIMIT = 7000;
const REQUIRED_LEDGER_IDS = Object.freeze([
  ...STAGE2_PROFILE_EVIDENCE_IDS,
  'S2-IPAD-PHYSICAL',
  'S2-FINAL-AUDIT',
]);
const LEDGER_SCOPE_PROFILES = Object.freeze({
  'S2-F6-MACHO': Object.freeze(['rebuild:transaction-v2']),
  'S2-F6-ELF': Object.freeze(['rebuild:transaction-v2']),
  'S2-F6-PE': Object.freeze(['rebuild:transaction-v2']),
  'S2-P12-KNOWLEDGE': Object.freeze(['knowledge-packages:v1']),
  'S2-P12-RULES': Object.freeze(['capability-rules:v1']),
  'S2-P12-PATTERNS': Object.freeze(['patterns:read-only-v1']),
  'S2-P12-COLLAB-REMOTE': Object.freeze(['collaboration:local-v1', 'collaboration:remote-security-v1']),
});
const LEDGER_SCOPE_PROFILE = Object.freeze({
  'S1-A2-NATIVE': 'arm64:a64 + arm64e:a64+pac + x86_64:long-64 + riscv64:rv64imc',
  'S2-A7-NATIVE': 'native A7 provider/architecture locked profiles',
  'S2-M6-WASM': 'managed:wasm:m6',
  'S2-M6-DEX': 'managed:dex:m6',
  'S2-M6-CIL': 'managed:cil:m6',
  'S2-M6-JVM': 'managed:jvm:m6',
  'S2-F6-MACHO': 'macho:64 F6',
  'S2-F6-ELF': 'elf:64 F6',
  'S2-F6-PE': 'pe:pe32 + pe:pe32+ F6',
  'S2-P12-KNOWLEDGE': 'knowledge-packages:v1',
  'S2-P12-RULES': 'capability-rules:v1',
  'S2-P12-PATTERNS': 'patterns:read-only-v1',
  'S2-P12-COLLAB-REMOTE': 'collaboration:remote-security-v1',
  'S2-IPAD-PHYSICAL': 'physical-ipad-ipados-webkit',
  'S2-FINAL-AUDIT': 'phase1-12 exact candidate',
});

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return { status: result.status, stdout: result.stdout?.trim() || '', stderr: result.stderr?.trim() || '' };
}
function bounded(text) { const value = String(text || ''); return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT); }
function parseArg(name, argv) {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}
function hasFlag(name, argv) { return argv.includes(name); }
export function parseNonNegativeInteger(name, argv) {
  const raw = parseArg(name, argv);
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.trim() === '') throw new TypeError(`${name.slice(2)}-invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name.slice(2)}-invalid`);
  return value;
}
function run(command) {
  const startedAt = Date.now();
  const result = spawnSync(command.bin, command.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1' } });
  return Object.freeze({
    command: [command.bin, ...command.args].join(' '),
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal || null,
    durationMs: Date.now() - startedAt,
    stdoutTail: bounded(result.stdout),
    stderrTail: bounded(result.stderr),
  });
}
const node = (...args) => ({ bin: process.execPath, args });
const npm = (...args) => ({ bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', ...args] });

export function validateScopeAndLedger(headSha, overrides = {}) {
  const scope = overrides.scope || JSON.parse(fs.readFileSync(SCOPE_PATH, 'utf8'));
  const ledger = overrides.ledger || JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const errors = [];
  if (scope.schemaVersion !== 'hex-completion-scope-lock/v1') errors.push('scope-schema-invalid');
  if (scope.growthOnly !== true) errors.push('scope-not-growth-only');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineCommit || '')) errors.push('scope-baseline-commit-invalid');
  if (!/^[0-9a-f]{40}$/.test(scope.baselineTree || '')) errors.push('scope-baseline-tree-invalid');
  if (!Array.isArray(scope.requiredTargetPlatforms) || !scope.requiredTargetPlatforms.includes('physical-ipad-ipados-webkit')) errors.push('physical-ipad-missing-from-scope');
  if (/^[0-9a-f]{40}$/.test(scope.baselineCommit || '') && /^[0-9a-f]{40}$/.test(scope.baselineTree || '')) {
    const baselineTree = git(['rev-parse', `${scope.baselineCommit}^{tree}`], true);
    if (baselineTree.status !== 0 || baselineTree.stdout !== scope.baselineTree) errors.push('scope-baseline-tree-mismatch');
  }
  const ancestor = git(['merge-base', '--is-ancestor', scope.baselineCommit, headSha], true);
  if (ancestor.status !== 0) errors.push('scope-baseline-not-ancestor');
  if (ledger.schemaVersion !== 'hex-completion-ledger/v1') errors.push('ledger-schema-invalid');
  if (ledger.scopeVersion !== scope.scopeVersion) errors.push('ledger-scope-version-mismatch');
  if (JSON.stringify(ledger.terminalStates) !== JSON.stringify(['PROVEN', 'PREEXISTING_NORMATIVE_EXCLUSION'])) errors.push('ledger-terminal-states-invalid');
  if (!Array.isArray(ledger.items)) errors.push('ledger-items-invalid');
  const ids = new Set();
  for (const item of ledger.items || []) {
    if (!item.id || ids.has(item.id)) errors.push(`ledger-id-invalid:${item.id || '<missing>'}`);
    ids.add(item.id);
    if (!REQUIRED_LEDGER_IDS.includes(item.id)) errors.push(`ledger-unexpected-id:${item.id}`);
    if (item.stage !== (item.id === 'S1-A2-NATIVE' ? 1 : 2)) errors.push(`ledger-stage-invalid:${item.id}`);
    for (const field of ['lane', 'sourceOfRequirement', 'owner']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) errors.push(`ledger-field-invalid:${item.id}:${field}`);
    }
    if (item.scopeProfile !== LEDGER_SCOPE_PROFILE[item.id]) errors.push(`ledger-scope-profile-invalid:${item.id}`);
    const declaredProfiles = Array.isArray(item.scopeProfiles) ? [...new Set(item.scopeProfiles.map(String))].sort() : [];
    const expectedProfiles = [...(LEDGER_SCOPE_PROFILES[item.id] || [])].sort();
    if (JSON.stringify(declaredProfiles) !== JSON.stringify(expectedProfiles)) errors.push(`ledger-scope-profiles-invalid:${item.id}`);
    if (item.status !== 'IN_PROGRESS' || item.proofIdentity !== null) errors.push(`ledger-declared-proof-invalid:${item.id}`);
    for (const field of ['implementationRefs', 'testRefs', 'verifierRefs', 'supportTruthRefs']) {
      const refs = item[field];
      if (!Array.isArray(refs) || refs.length === 0 || new Set(refs).size !== refs.length) {
        errors.push(`ledger-refs-invalid:${item.id}:${field}`);
        continue;
      }
      for (const ref of refs) {
        if (typeof ref !== 'string' || !safeRelativePath(ref.replace(/\*\*/g, 'placeholder'))) {
          errors.push(`ledger-ref-invalid:${item.id}:${ref}`);
          continue;
        }
        const matched = ref.includes('*')
          ? git(['ls-files', ref], true).stdout
          : git(['cat-file', '-e', `${headSha}:${ref}`], true).status === 0;
        if (!matched) errors.push(`ledger-ref-missing:${item.id}:${ref}`);
      }
    }
  }
  const requiredPhase12Profiles = [...new Set((scope.phase12CapabilityProfiles || []).map(String).filter(Boolean))].sort();
  const mappedPhase12Profiles = [...new Set((ledger.items || []).flatMap((item) => Array.isArray(item.scopeProfiles) ? item.scopeProfiles.map(String) : []))].sort();
  for (const profile of requiredPhase12Profiles) if (!mappedPhase12Profiles.includes(profile)) errors.push(`phase12-profile-unmapped:${profile}`);
  for (const profile of mappedPhase12Profiles) if (!requiredPhase12Profiles.includes(profile)) errors.push(`phase12-profile-out-of-scope:${profile}`);
  for (const id of REQUIRED_LEDGER_IDS) if (!ids.has(id)) errors.push(`ledger-required-id-missing:${id}`);
  return { ok: errors.length === 0, errors, scope, ledger, ledgerItemCount: ids.size };
}

function auditStage2Source() {
  const paths = [
    'js/runtime/authority.js',
    'js/managed/runtime-binding.js',
    'js/rebuild/transaction-v2.js',
    'js/collaboration/remote-authority.js',
    'js/collaboration/remote-delivery.js',
    'js/platform/physical-ipad-evidence.js',
    'js/platform/stage2-profile-evidence.js',
    'js/platform/stage2-capability-maturity.js',
    'js/knowledge/phase12-rules.js',
  ];
  const findings = [];
  for (const relative of paths) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    if (/\b(?:TODO|FIXME)\b/.test(text)) findings.push(`${relative}:todo-fixme`);
    if (/not[- ]implemented/i.test(text)) findings.push(`${relative}:not-implemented-marker`);
  }
  return { ok: findings.length === 0, findings };
}

function readEvidenceJson(finalMode, evidencePath, requiredReason, missingReason, invalidReason) {
  if (!finalMode) return { required: false, status: 'not-evaluated-in-implementation-mode' };
  if (!evidencePath) return { required: true, status: 'failed', reason: requiredReason };
  const relative = safeRelativePath(evidencePath);
  if (!relative) return { required: true, status: 'failed', reason: invalidReason, detail: 'evidence-path-must-be-repository-relative' };
  const resolved = path.resolve(ROOT, relative);
  if (!fs.existsSync(resolved)) return { required: true, status: 'failed', reason: missingReason };
  const repositoryFile = repositoryFileAtRoot(relative);
  if (!repositoryFile) return { required: true, status: 'failed', reason: invalidReason, detail: 'evidence-path-outside-repository-or-not-regular-file' };
  try { return { required: true, status: 'loaded', record: JSON.parse(fs.readFileSync(repositoryFile, 'utf8')) }; }
  catch (error) { return { required: true, status: 'failed', reason: invalidReason, detail: String(error?.message || error) }; }
}

export function stage2CanonicalBuildIdentity() {
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'userscript/release-version.json'), 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(String(release.releaseIdentity || ''))) throw new TypeError('stage2-release-identity-invalid');
  if (!/^[0-9a-f]{24}$/.test(String(release.buildId || ''))) throw new TypeError('stage2-build-id-invalid');
  if (!Number.isSafeInteger(release.serial) || release.serial < 1) throw new TypeError('stage2-release-serial-invalid');
  return `userscript-release:${release.releaseIdentity}:build:${release.buildId}:serial:${release.serial}`;
}

function physicalEvidenceResult({ finalMode, evidencePath, headSha, treeSha, requestedBuildIdentity }) {
  const buildIdentity = stage2CanonicalBuildIdentity();
  if (requestedBuildIdentity != null && String(requestedBuildIdentity) !== buildIdentity) return {
    required: finalMode,
    status: 'failed',
    reason: 'physical-ipad-requested-build-identity-mismatch',
    expectedBuildIdentity: buildIdentity,
  };
  const loaded = readEvidenceJson(finalMode, evidencePath, 'physical-ipad-evidence-required', 'physical-ipad-evidence-file-missing', 'physical-ipad-evidence-json-invalid');
  if (loaded.status !== 'loaded') return loaded;
  const checked = validatePhysicalIPadEvidence(loaded.record, {
    commitSha: headSha,
    treeSha,
    buildIdentity,
    resolveEvidenceIdentity: (identity, context) => physicalEvidenceIdentityAtHead(identity, context, headSha, treeSha),
  });
  return { required: true, status: checked.ok ? 'passed' : 'failed', reason: checked.reason || null, evidenceId: checked.evidenceId || loaded.record.evidenceId || null };
}

function safeRelativePath(ref) {
  const value = String(ref || '');
  return value && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..') ? value : null;
}

function repositoryFileAtRoot(ref) {
  const relative = safeRelativePath(ref);
  if (!relative) return null;
  const resolved = path.resolve(ROOT, relative);
  const lexicalRelative = path.relative(ROOT, resolved);
  if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return null;
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(ROOT);
    realFile = fs.realpathSync(resolved);
  } catch { return null; }
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  return realFile;
}

export function isStage2RepositoryFile(ref) {
  return repositoryFileAtRoot(ref) !== null;
}

function loadDenominatorInventory() {
  if (!fs.existsSync(DENOMINATOR_INVENTORY_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DENOMINATOR_INVENTORY_PATH, 'utf8')); }
  catch { return null; }
}

function inventoryIdentityAtHead(ref, itemId) {
  const value = safeRelativePath(ref);
  const canonical = loadDenominatorInventory()?.items?.[itemId];
  if (!value || !canonical || !Array.isArray(canonical.inventoryRefs) || !canonical.inventoryRefs.includes(value)) return null;
  const resolved = git(['rev-parse', `HEAD:${value}`], true);
  return resolved.status === 0 && /^[0-9a-f]{40}$/.test(resolved.stdout) ? resolved.stdout : null;
}

function denominatorUnitIdsAtHead(itemId, inventoryRefs) {
  const item = loadDenominatorInventory()?.items?.[itemId];
  if (!item || !Array.isArray(item.unitIds) || !Array.isArray(item.inventoryRefs)) return [];
  const left = [...new Set((inventoryRefs || []).map(String))].sort();
  const right = [...new Set(item.inventoryRefs.map(String))].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) return [];
  return item.unitIds;
}

function gitIdentityAtHead(identity) {
  const match = /^git:([^@]+)@([0-9a-f]{40})$/.exec(String(identity || ''));
  if (!match) return null;
  const relative = safeRelativePath(match[1]);
  if (!relative) return null;
  const resolved = git(['rev-parse', `HEAD:${relative}`], true);
  return resolved.status === 0 && resolved.stdout === match[2] ? identity : null;
}

function profileUnitArtifactValid(relative, context, candidateCommitSha, candidateTreeSha) {
  const prefix = `${PROFILE_EVIDENCE_RUN_ROOT}/`;
  if (!relative.startsWith(prefix) || relative.split('/').length !== 5 || !relative.endsWith('.json')) return false;
  let artifact;
  const artifactPath = repositoryFileAtRoot(relative);
  if (!artifactPath) return false;
  try { artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')); } catch { return false; }
  if (!artifact || artifact.schemaVersion !== PROFILE_UNIT_PROOF_SCHEMA || artifact.itemId !== context.itemId || artifact.unitId !== context.unitId || artifact.candidateCommitSha !== candidateCommitSha || artifact.candidateTreeSha !== candidateTreeSha || artifact.status !== 'passed') return false;
  const rule = PROFILE_UNIT_PROOF_RULES[context.itemId];
  if (!rule || JSON.stringify(artifact.providerProfileIds || []) !== JSON.stringify(rule.providerProfileIds)) return false;
  const refs = (values) => values.map((ref) => `git:${ref}@${git(['rev-parse', `HEAD:${ref}`], true).stdout}`);
  if (JSON.stringify(artifact.sourceIdentities || []) !== JSON.stringify(refs(rule.sourceRefs))) return false;
  if (JSON.stringify(artifact.testIdentities || []) !== JSON.stringify(refs(rule.testRefs))) return false;
  if (!Array.isArray(artifact.negativeTestIdentities) || artifact.negativeTestIdentities.length === 0 || artifact.negativeTestIdentities.some((value) => gitIdentityAtHead(value) !== value)) return false;
  if (!Array.isArray(artifact.commandOutputIdentities) || artifact.commandOutputIdentities.length !== rule.commandIds.length) return false;
  for (const identity of artifact.commandOutputIdentities) {
    const match = /^artifact:([^@]+)@sha256:([0-9a-f]{64})$/.exec(identity || '');
    if (!match) return false;
    const outputPath = safeRelativePath(match[1]);
    const outputFile = outputPath && outputPath.startsWith(`${PROFILE_EVIDENCE_RUN_ROOT}/`) ? repositoryFileAtRoot(outputPath) : null;
    if (!outputFile) return false;
    const outputBytes = fs.readFileSync(outputFile);
    if (createHash('sha256').update(outputBytes).digest('hex') !== match[2]) return false;
    let output;
    try { output = JSON.parse(outputBytes); } catch { return false; }
    if (output.schemaVersion !== 'hex-stage2-profile-command-output/v1' || output.candidateCommitSha !== candidateCommitSha || output.candidateTreeSha !== candidateTreeSha || output.status !== 'passed') return false;
  }
  return Array.isArray(artifact.realFixtureIdentities) && artifact.realFixtureIdentities.length > 0;
}

function evidenceIdentityAtHead(identity, context = {}, candidateCommitSha = null, candidateTreeSha = null) {
  const value = String(identity || '');
  const gitMatch = /^git:([^@]+)@([0-9a-f]{40})$/.exec(value);
  if (gitMatch) {
    if (context.kind === 'unit' && context.requireCanonicalUnitEvidence !== false) return null;
    const relative = safeRelativePath(gitMatch[1]);
    if (!relative) return null;
    const resolved = git(['rev-parse', `HEAD:${relative}`], true);
    return resolved.status === 0 && resolved.stdout === gitMatch[2] ? value : null;
  }
  const artifactMatch = /^artifact:([^@]+)@sha256:([0-9a-f]{64})$/.exec(value);
  if (!artifactMatch) return null;
  const relative = safeRelativePath(artifactMatch[1]);
  if (!relative) return null;
  const resolved = repositoryFileAtRoot(relative);
  if (!resolved) return null;
  const digest = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  if (digest !== artifactMatch[2]) return null;
  if (context.kind === 'unit' && candidateCommitSha && candidateTreeSha && !profileUnitArtifactValid(relative, context, candidateCommitSha, candidateTreeSha)) return null;
  return value;
}

function physicalEvidenceIdentityAtHead(identity, context = {}, candidateCommitSha = null, candidateTreeSha = null) {
  if (!/^artifact:[^@]+@sha256:[0-9a-f]{64}$/.test(String(identity || ''))) return null;
  return evidenceIdentityAtHead(identity, context, candidateCommitSha, candidateTreeSha);
}

export function stage2KnownDenominatorGaps() {
  const a2 = a2DenominatorReport().validation;
  const phase12 = phase12DenominatorReport();
  const gaps = [...f6KnownImplementationGaps()];
  if (a2.valid !== true) gaps.push('a2-denominator-invalid');
  if (a2.terminalEligible !== true) gaps.push(...(a2.blockingGaps || []));
  if (phase12.valid !== true) {
    gaps.push('phase12-denominator-invalid');
    gaps.push(...(phase12.failures || []).map((failure) => `phase12-denominator:${failure}`));
  } else if (phase12.terminalEligible !== true) {
    gaps.push(...(phase12.blockingGaps || []));
  }
  return Object.freeze([...new Set(gaps)].sort());
}

function profileEvidenceResult({ finalMode, evidencePath, headSha, treeSha, scope }) {
  const loaded = readEvidenceJson(finalMode, evidencePath, 'stage2-profile-evidence-required', 'stage2-profile-evidence-file-missing', 'stage2-profile-evidence-json-invalid');
  if (loaded.status !== 'loaded') return loaded;
  if (!fs.existsSync(DENOMINATOR_PATH)) return { required: true, status: 'failed', reason: 'stage2-profile-denominator-lock-missing', failures: [] };
  let denominatorLock;
  try { denominatorLock = JSON.parse(fs.readFileSync(DENOMINATOR_PATH, 'utf8')); }
  catch (error) { return { required: true, status: 'failed', reason: 'stage2-profile-denominator-lock-invalid', failures: [String(error?.message || error)] }; }
  const lockChecked = validateStage2DenominatorLock(denominatorLock, {
    scope,
    resolveInventoryIdentity: inventoryIdentityAtHead,
    resolveDenominatorUnitIds: denominatorUnitIdsAtHead,
  });
  if (!lockChecked.ok) return { required: true, status: 'failed', reason: lockChecked.reason, failures: lockChecked.failures || [] };
  const knownDenominatorGaps = stage2KnownDenominatorGaps();
  if (knownDenominatorGaps.length) return {
    required: true,
    status: 'failed',
    reason: 'stage2-known-implementation-denominator-incomplete',
    failures: knownDenominatorGaps,
  };
  const checked = validateStage2ProfileEvidence(loaded.record, {
    commitSha: headSha,
    treeSha,
    denominatorLock,
    scope,
    resolveInventoryIdentity: inventoryIdentityAtHead,
    resolveDenominatorUnitIds: denominatorUnitIdsAtHead,
    requireCanonicalUnitEvidence: true,
    resolveEvidenceIdentity: (identity, context) => evidenceIdentityAtHead(identity, { ...context, requireCanonicalUnitEvidence: true }, headSha, treeSha),
  });
  return {
    required: true,
    status: checked.ok ? 'passed' : 'failed',
    reason: checked.reason || null,
    failures: checked.failures || [],
    evidenceId: checked.evidenceId || loaded.record.evidenceId || null,
    provenIds: checked.ok ? Object.freeze([...STAGE2_PROFILE_EVIDENCE_IDS]) : Object.freeze([]),
  };
}

function commandPassed(results, fragment) {
  return results.some((result) => result.command.includes(fragment) && result.status === 'passed');
}

function candidateMergeResult({ finalMode, headSha, treeSha, expectedMainSha }) {
  if (!finalMode) return { required: false, status: 'not-evaluated-in-implementation-mode', currentMainSha: null, candidateMergeTree: null };
  if (!/^[0-9a-f]{40}$/.test(String(expectedMainSha || '').toLowerCase())) return { required: true, status: 'failed', reason: 'current-main-sha-required', currentMainSha: null, candidateMergeTree: null };
  const fetched = git(['fetch', '--quiet', 'origin', 'main'], true);
  if (fetched.status !== 0) return { required: true, status: 'failed', reason: 'current-main-fetch-failed', currentMainSha: null, candidateMergeTree: null };
  const currentMainSha = git(['rev-parse', 'origin/main'], true).stdout;
  if (currentMainSha !== String(expectedMainSha).toLowerCase()) return { required: true, status: 'failed', reason: 'current-main-sha-mismatch', currentMainSha, candidateMergeTree: null };
  if (git(['merge-base', '--is-ancestor', currentMainSha, headSha], true).status !== 0) return { required: true, status: 'failed', reason: 'candidate-not-reconciled-with-current-main', currentMainSha, candidateMergeTree: null };
  const merged = git(['merge-tree', '--write-tree', currentMainSha, headSha], true);
  const candidateMergeTree = merged.stdout.split(/\s+/).find((value) => /^[0-9a-f]{40}$/.test(value)) || null;
  if (merged.status !== 0 || !candidateMergeTree) return { required: true, status: 'failed', reason: 'candidate-merge-tree-conflict', currentMainSha, candidateMergeTree };
  if (candidateMergeTree !== treeSha) return { required: true, status: 'failed', reason: 'candidate-merge-tree-differs-from-tested-tree', currentMainSha, candidateMergeTree };
  return { required: true, status: 'passed', reason: null, currentMainSha, candidateMergeTree };
}

export function minimumVerdictCounts({ structural, sourceAudit, commands, profiles, physical, ledger, generatedOutput, candidateMerge, releaseBlockingIssueCount }) {
  const profileFailures = Array.isArray(profiles.failures) ? profiles.failures : [];
  const failedCommands = commands.filter((result) => result.status !== 'passed').length;
  const stage2Passed = commandPassed(commands, 'tests/stage2/run.mjs');
  const fullCheckPassed = commandPassed(commands, 'run check');
  const benchmarkPassed = commandPassed(commands, 'benchmark:baseline');
  return Object.freeze({
    unmappedCount: ledger.unmappedCount,
    unprovenCount: ledger.unresolved.length,
    scopeReductionCount: structural.errors.filter((reason) => reason.includes('scope-') || reason.includes('baseline-')).length,
    promotedFallbackCount: stage2Passed && profiles.status === 'passed' ? 0 : 1,
    coverageDenominatorMisses: profiles.status === 'passed' ? 0 : Math.max(1, profileFailures.filter((reason) => reason.includes('denominator') || reason.includes('profile')).length),
    requiredValidatorMisses: failedCommands + (generatedOutput.status === 'passed' ? 0 : 1) + (candidateMerge.status === 'passed' ? 0 : 1),
    fuzzOrPropertyFailures: fullCheckPassed ? 0 : 1,
    mutationSelfTestFailures: stage2Passed ? 0 : 1,
    realFixtureFailures: profiles.status === 'passed' ? 0 : 1,
    performanceBudgetFailures: benchmarkPassed ? 0 : 1,
    requiredTargetPlatformFailures: physical.status === 'passed' ? 0 : 1,
    supportProjectionMismatches: sourceAudit.ok && stage2Passed ? 0 : 1,
    releaseBlockingIssueCount: releaseBlockingIssueCount == null ? 1 : releaseBlockingIssueCount,
    staleEvidenceCount: [profiles, physical, candidateMerge].filter((item) => item.status !== 'passed').length,
  });
}

function effectiveLedger(structural, { headSha, treeSha, sourceAudit, commands, physical, profiles, full }) {
  const benchmark = commandPassed(commands, 'benchmark:baseline');
  const fullCheck = full && commandPassed(commands, 'check');
  const provenProfiles = new Set(profiles.provenIds || []);
  const conditions = Object.fromEntries([...STAGE2_PROFILE_EVIDENCE_IDS].map((id) => [id, provenProfiles.has(id)]));
  conditions['S2-IPAD-PHYSICAL'] = physical.status === 'passed';
  conditions['S2-FINAL-AUDIT'] = sourceAudit.ok && benchmark && fullCheck;
  const proofIdentity = `${headSha}:${treeSha}`;
  const items = (structural.ledger.items || []).map((item) => ({
    id: item.id,
    declaredStatus: item.status,
    effectiveStatus: conditions[item.id] === true ? 'PROVEN' : item.status === 'PREEXISTING_NORMATIVE_EXCLUSION' ? 'PREEXISTING_NORMATIVE_EXCLUSION' : 'UNPROVEN',
    proofIdentity: conditions[item.id] === true ? proofIdentity : null,
  }));
  const unresolved = items.filter((item) => REQUIRED_LEDGER_IDS.includes(item.id) && !['PROVEN', 'PREEXISTING_NORMATIVE_EXCLUSION'].includes(item.effectiveStatus));
  return { items, unresolved, unmappedCount: REQUIRED_LEDGER_IDS.filter((id) => !items.some((item) => item.id === id)).length };
}

export function verifyStage2({ expectedSha = null, expectedMainSha = null, finalMode = false, physicalEvidencePath = null, profileEvidencePath = null, buildIdentity = null, releaseBlockingIssueCount = null, full = false } = {}) {
  const headSha = git(['rev-parse', 'HEAD']).stdout;
  const treeSha = git(['rev-parse', 'HEAD^{tree}']).stdout;
  if (!/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('stage2-git-identity-invalid');
  if (finalMode && !/^[0-9a-f]{40}$/.test(String(expectedSha || '').toLowerCase())) throw new Error('stage2-exact-head-required');
  if (expectedSha && headSha !== String(expectedSha).toLowerCase()) throw new Error(`stage2-exact-head-mismatch: expected ${expectedSha}, got ${headSha}`);
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).stdout;
  if (dirty) throw new Error(`stage2-worktree-not-clean:\n${dirty}`);

  const structural = validateScopeAndLedger(headSha);
  const sourceAudit = auditStage2Source();
  const physical = physicalEvidenceResult({ finalMode, evidencePath: physicalEvidencePath, headSha, treeSha, requestedBuildIdentity: buildIdentity });
  const profiles = profileEvidenceResult({ finalMode, evidencePath: profileEvidencePath, headSha, treeSha, scope: structural.scope });
  const candidateMerge = candidateMergeResult({ finalMode, headSha, treeSha, expectedMainSha });
  const preflightBlocked = finalMode && (
    !structural.ok || !sourceAudit.ok || !full || releaseBlockingIssueCount !== 0
    || physical.status !== 'passed' || profiles.status !== 'passed' || candidateMerge.status !== 'passed'
  );
  const commands = [
    node('tools/validation/stage1/verify.mjs', '--expect-sha', headSha),
    node('tests/stage2/run.mjs'),
    npm('runtime:test'),
    npm('phase11:test'),
    npm('phase12:test'),
    npm('benchmark:baseline'),
  ];
  if (finalMode) commands.push(npm('userscript:build'));
  if (full) commands.push(npm('check'));
  const commandResults = preflightBlocked ? [] : commands.map(run);
  const generatedDirty = preflightBlocked ? '' : git(['status', '--porcelain', '--untracked-files=all']).stdout;
  const generatedOutput = {
    required: finalMode,
    status: !finalMode ? 'not-evaluated-in-implementation-mode' : preflightBlocked ? 'blocked-by-preflight' : generatedDirty ? 'failed' : 'passed',
    reason: preflightBlocked ? 'generated-output-check-not-run' : generatedDirty ? 'generated-output-zero-diff-failed' : null,
  };
  const ledger = effectiveLedger(structural, { headSha, treeSha, sourceAudit, commands: commandResults, physical, profiles, full });
  const counts = minimumVerdictCounts({ structural, sourceAudit, commands: commandResults, profiles, physical, ledger, generatedOutput, candidateMerge, releaseBlockingIssueCount });

  const failures = [];
  if (!structural.ok) failures.push(...structural.errors.map((reason) => ({ gate: 'scope-ledger', reason })));
  if (!sourceAudit.ok) failures.push(...sourceAudit.findings.map((reason) => ({ gate: 'source-audit', reason })));
  for (const result of commandResults) if (result.status !== 'passed') failures.push({ gate: 'command', reason: result.command });
  if (physical.status === 'failed') failures.push({ gate: 'physical-ipad', reason: physical.reason });
  if (profiles.status === 'failed') failures.push({ gate: 'profile-evidence', reason: profiles.reason, details: profiles.failures || [] });
  if (generatedOutput.status === 'failed') failures.push({ gate: 'generated-output', reason: generatedOutput.reason });
  if (candidateMerge.status === 'failed') failures.push({ gate: 'candidate-merge-tree', reason: candidateMerge.reason });
  if (ledger.unmappedCount !== 0) failures.push({ gate: 'ledger', reason: `unmapped-count:${ledger.unmappedCount}` });
  if (finalMode && !full) failures.push({ gate: 'final-audit', reason: 'full-repository-check-required' });
  if (finalMode && ledger.unresolved.length) failures.push({ gate: 'ledger', reason: `unproven-count:${ledger.unresolved.length}` });
  if (finalMode && releaseBlockingIssueCount == null) failures.push({ gate: 'release-audit', reason: 'release-blocking-issue-count-required' });
  if (finalMode) for (const [name, value] of Object.entries(counts)) if (value !== 0) failures.push({ gate: 'machine-verdict', reason: `${name}:${value}` });

  const verdict = failures.length === 0 ? (finalMode ? 'COMPLETE' : 'IMPLEMENTATION_READY') : 'NOT_COMPLETE';
  const report = {
    schemaVersion: 'stage2-verdict/v3',
    stage: 2,
    headSha,
    treeSha,
    scopeLockHash: `stage2-scope-lock:${stableDigest(structural.scope)}`,
    candidateCommit: headSha,
    candidateTree: treeSha,
    currentMainCommit: candidateMerge.currentMainSha,
    candidateMergeTree: candidateMerge.candidateMergeTree,
    expectedSha: expectedSha || null,
    finalMode,
    full,
    generatedAt: new Date().toISOString(),
    scope: { version: structural.scope.scopeVersion, baselineCommit: structural.scope.baselineCommit, ledgerItemCount: structural.ledgerItemCount, status: structural.ok ? 'passed' : 'failed' },
    sourceAudit,
    commands: commandResults,
    generatedOutput,
    candidateMerge,
    profileEvidence: profiles,
    physicalIPadEvidence: physical,
    ledger,
    ...counts,
    failures,
    verdict,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (verdict === 'NOT_COMPLETE') throw new Error(`stage2-not-complete: ${failures.map((item) => `${item.gate}:${item.reason}`).join(', ')}`);
  return Object.freeze(report);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    const report = verifyStage2({
      expectedSha: parseArg('--expect-sha', argv),
      expectedMainSha: parseArg('--expect-main-sha', argv),
      finalMode: hasFlag('--final', argv),
      physicalEvidencePath: parseArg('--physical-evidence', argv),
      profileEvidencePath: parseArg('--profile-evidence', argv),
      buildIdentity: parseArg('--build-identity', argv),
      releaseBlockingIssueCount: parseNonNegativeInteger('--release-blocking-issue-count', argv),
      full: hasFlag('--full', argv),
    });
    console.log(`Stage 2 verdict: ${report.verdict} @ ${report.headSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
