import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');

export const EXTERNAL_ORACLE_POLICY = Object.freeze([
  Object.freeze({
    id: 'compiler-truth',
    role: 'independent-source-and-concrete-vector-evidence',
    semanticAuthority: 'source-manifest-and-independent-evaluation-only',
    defaultNetworkRequired: false,
    requiredPaths: Object.freeze([
      'tests/compiler-truth/run.mjs',
      'tests/compiler-truth/run-core.mjs',
      'tests/compiler-truth/sources/scalars.c',
      'tests/compiler-truth/expected.json',
    ]),
  }),
  Object.freeze({
    id: 'ghidra-differential',
    role: 'external-differential-diagnostic',
    semanticAuthority: 'not-absolute-isa-truth',
    defaultNetworkRequired: false,
    requiredPaths: Object.freeze([
      'tools/decompiler/ghidra-diff.mjs',
      'tools/decompiler/GhidraDump.java',
      '.github/workflows/ghidra-differential.yml',
    ]),
  }),
  Object.freeze({
    id: 'capstone',
    role: 'decoder-evidence-only',
    semanticAuthority: 'disassembly-text-does-not-prove-semantics',
    defaultNetworkRequired: false,
    requiredPaths: Object.freeze([
      'tests/capstone-capability.mjs',
    ]),
  }),
  Object.freeze({
    id: 'formal-architectural-models',
    role: 'claim-local-symbolic-and-concrete-semantic-evidence',
    semanticAuthority: 'complete-artifact-observable-partition-only',
    defaultNetworkRequired: false,
    requiredPaths: Object.freeze([
      'tools/validation/machine-effects/oracle-evidence-v2.mjs',
      'tools/validation/machine-effects/generate-formal-evidence.mjs',
    ]),
    checkedInEvidencePaths: Object.freeze([
      'tools/validation/machine-effects/generated/formal-evidence-artifacts.json',
    ]),
  }),
  Object.freeze({
    id: 'herdtools7-aarch64-memory-model',
    role: 'claim-local-permitted-and-forbidden-outcome-evidence',
    semanticAuthority: 'declared-litmus-outcome-universe-only',
    defaultNetworkRequired: false,
    requiredPaths: Object.freeze([
      'tests/machine-effects/fixtures/formal-source/aarch64-relaxed.litmus',
      'tests/machine-effects/fixtures/formal-source/aarch64-acquire.litmus',
      'tests/machine-effects/fixtures/formal-source/aarch64-release.litmus',
      'tests/machine-effects/fixtures/formal-source/aarch64-acq-rel.litmus',
      'tests/machine-effects/fixtures/formal-source/aarch64-seq-cst.litmus',
    ]),
  }),
]);

export function inspectExternalOracleInfrastructure({ root = ROOT } = {}) {
  const entries = EXTERNAL_ORACLE_POLICY.map((oracle) => {
    const paths = oracle.requiredPaths.map((relativePath) => ({
      path: relativePath,
      present: fs.existsSync(path.join(root, relativePath)),
    }));
    const checkedInEvidencePaths = (oracle.checkedInEvidencePaths ?? []).map((relativePath) => ({
      path: relativePath,
      present: fs.existsSync(path.join(root, relativePath)),
    }));
    return Object.freeze({
      ...oracle,
      requiredPaths: paths,
      checkedInEvidencePaths,
      available: paths.every((entry) => entry.present),
      checkedInEvidenceAvailable: checkedInEvidencePaths.length > 0
        && checkedInEvidencePaths.every((entry) => entry.present),
      regenerationStatus: 'not-verified',
    });
  });
  return Object.freeze({
    schemaVersion: 'machine-effects-external-oracle-inventory/v1',
    defaultNetworkRequired: false,
    entries: Object.freeze(entries),
  });
}

export function assertExternalOraclePolicy(report = inspectExternalOracleInfrastructure()) {
  const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
  for (const id of ['compiler-truth', 'ghidra-differential', 'capstone', 'formal-architectural-models', 'herdtools7-aarch64-memory-model']) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`external-oracle-missing: ${id}`);
    if (!entry.available) {
      const missing = entry.requiredPaths.filter((item) => !item.present).map((item) => item.path);
      throw new Error(`external-oracle-infrastructure-missing: ${id}: ${missing.join(', ')}`);
    }
    if (entry.defaultNetworkRequired) throw new Error(`external-oracle-default-network-forbidden: ${id}`);
  }
  if (byId.get('capstone').semanticAuthority !== 'disassembly-text-does-not-prove-semantics') {
    throw new Error('capstone-semantic-authority-forbidden');
  }
  if (byId.get('ghidra-differential').semanticAuthority === 'absolute-isa-truth') {
    throw new Error('ghidra-absolute-semantic-authority-forbidden');
  }
  if (byId.get('formal-architectural-models').semanticAuthority !== 'complete-artifact-observable-partition-only') throw new Error('formal-model-authority-overbroad');
  if (byId.get('herdtools7-aarch64-memory-model').semanticAuthority !== 'declared-litmus-outcome-universe-only') throw new Error('memory-model-authority-overbroad');
  return true;
}

export function createExternalOracleEvidence({ oracleId, subject, verdict, details = null } = {}) {
  const policy = EXTERNAL_ORACLE_POLICY.find((entry) => entry.id === oracleId);
  if (!policy) throw new Error(`unknown-external-oracle: ${oracleId}`);
  if (!subject) throw new Error('external-oracle-subject-required');
  const allowed = new Set(['supports', 'contradicts', 'diagnostic', 'unavailable']);
  if (!allowed.has(verdict)) throw new Error(`invalid-external-oracle-verdict: ${verdict}`);
  return Object.freeze({
    schemaVersion: 'machine-effects-external-oracle-evidence/v1',
    oracleId,
    role: policy.role,
    semanticAuthority: policy.semanticAuthority,
    subject: String(subject),
    verdict,
    details,
  });
}
