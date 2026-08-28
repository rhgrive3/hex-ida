import {
  INDEPENDENT_GENERATOR_IDENTITY,
  INDEPENDENT_GENERATOR_VERSION,
  ORACLE_PROFILE_INVENTORY,
} from './oracle-policy.mjs';
import {
  canonicalStringify,
  createCorpusCase,
  sha256Digest,
  validateCorpusCase,
} from './oracle-schema.mjs';

export const CORPUS_SCHEMA_VERSION = 'machine-effects-independent-oracle-corpus/v1';

function fail(code, detail = null) {
  throw new TypeError(detail == null ? code : `${code}:${detail}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertProfileCase(caseValue) {
  const profile = ORACLE_PROFILE_INVENTORY.find((entry) => entry.profileId === caseValue.profileId);
  if (!profile) fail('corpus-profile-not-in-inventory', caseValue.profileId);
  if (profile.architecture !== caseValue.architecture) fail('corpus-profile-architecture-mismatch', caseValue.profileId);
  return profile;
}

export function createCorpus(cases = [], {
  generatorIdentity = INDEPENDENT_GENERATOR_IDENTITY,
  generatorVersion = INDEPENDENT_GENERATOR_VERSION,
  corpusVersion = '1.0.0',
} = {}) {
  if (!Array.isArray(cases) || cases.length === 0) fail('corpus-cases-required');
  const normalized = cases.map((item) => {
    const caseValue = validateCorpusCase(item);
    assertProfileCase(caseValue);
    return caseValue;
  }).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const ids = normalized.map((item) => item.caseId);
  if (new Set(ids).size !== ids.length) fail('corpus-duplicate-case-id');
  const profileIds = [...new Set(normalized.map((item) => item.profileId))].sort();
  const payload = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    corpusVersion: String(corpusVersion),
    generatorIdentity: String(generatorIdentity),
    generatorVersion: String(generatorVersion),
    caseIds: ids,
    profileIds,
  };
  const corpusId = sha256Digest(payload);
  return deepFreeze({
    ...payload,
    corpusId,
    cases: normalized,
  });
}

export function createCorpusCaseFromFixture(input) {
  return createCorpusCase(input);
}

export function validateCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) fail('corpus-invalid');
  const allowed = new Set(['schemaVersion', 'corpusVersion', 'generatorIdentity', 'generatorVersion', 'caseIds', 'profileIds', 'corpusId', 'cases']);
  for (const key of Object.keys(corpus)) if (!allowed.has(key)) fail('corpus-unknown-field', key);
  for (const key of ['schemaVersion', 'corpusVersion', 'generatorIdentity', 'generatorVersion', 'caseIds', 'profileIds', 'corpusId', 'cases']) {
    if (!(key in corpus)) fail('corpus-missing-field', key);
  }
  if (corpus.schemaVersion !== CORPUS_SCHEMA_VERSION) fail('corpus-schema-version');
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) fail('corpus-cases-required');
  const normalized = createCorpus(corpus.cases, {
    generatorIdentity: corpus.generatorIdentity,
    generatorVersion: corpus.generatorVersion,
    corpusVersion: corpus.corpusVersion,
  });
  if (canonicalStringify(corpus.caseIds) !== canonicalStringify(normalized.caseIds)) fail('corpus-case-id-list-mismatch');
  if (canonicalStringify(corpus.profileIds) !== canonicalStringify(normalized.profileIds)) fail('corpus-profile-id-list-mismatch');
  if (corpus.corpusId !== normalized.corpusId) fail('corpus-stale-identity');
  return normalized;
}
