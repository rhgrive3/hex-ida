/** World/profile identity, never a claim that the world has been proved closed. */
import { createEntityId, deepFreeze, stableStringify } from './index.js';
import {
  snapshotContractData, recordFields, exactString, exactInteger, exactEnum,
  stringSet, compareIdentity, sha256Text, assertMatchingId, contractFail,
} from './structured.js';

export const WORLD_SCOPE_SCHEMA = 'world-scope/v1';
export const ASSUMPTION_SET_SCHEMA = 'assumption-set/v1';
const WORLDS = new WeakSet();
const ASSUMPTIONS = new WeakSet();

function sourceIdentity(input) {
  recordFields(input, ['kind', 'sha256', 'sourceInstance', 'generation', 'rangeManifest', 'immutableProvider'], 'world-source-fields');
  const kind = exactEnum(input.kind, ['complete-content', 'verified-ranges', 'local-immutable'], 'world-source-kind');
  if (kind === 'complete-content') {
    if (Object.keys(input).some((key) => !['kind', 'sha256'].includes(key))) contractFail('world-source-kind-fields');
    return { kind, sha256: sha256Text(input.sha256, 'world-source-sha256') };
  }
  const result = {
    kind, sourceInstance: exactString(input.sourceInstance, 'world-source-instance'),
    generation: exactString(input.generation, 'world-source-generation'),
  };
  if (kind === 'verified-ranges') {
    if ('sha256' in input) contractFail('world-source-kind-fields');
    result.rangeManifest = exactString(input.rangeManifest, 'world-range-manifest');
    result.immutableProvider = exactString(input.immutableProvider, 'world-immutable-provider');
  } else if ('rangeManifest' in input || 'immutableProvider' in input || 'sha256' in input) {
    contractFail('world-source-kind-fields');
  }
  return result;
}

function binaryMember(input) {
  recordFields(input, ['binaryId', 'sliceId', 'sourceIdentity', 'loadMapHash', 'relocationViewHash'], 'world-binary-fields');
  return {
    binaryId: exactString(input.binaryId, 'world-binary-id'),
    sliceId: exactString(input.sliceId, 'world-slice-id'),
    sourceIdentity: sourceIdentity(input.sourceIdentity),
    loadMapHash: exactString(input.loadMapHash, 'world-load-map'),
    relocationViewHash: exactString(input.relocationViewHash, 'world-relocation-view'),
  };
}

function profile(input) {
  recordFields(input, ['isaRevision', 'features', 'abi', 'abiRevision', 'osModel', 'endianness', 'addressBits', 'exceptionModel', 'memoryModel'], 'world-profile-fields');
  return {
    isaRevision: exactString(input.isaRevision, 'world-isa-revision'),
    features: stringSet(input.features, 'world-features', 512),
    abi: exactString(input.abi, 'world-abi'),
    abiRevision: exactString(input.abiRevision, 'world-abi-revision'),
    osModel: exactString(input.osModel, 'world-os-model'),
    endianness: exactEnum(input.endianness, ['le', 'be'], 'world-endianness'),
    addressBits: exactInteger(input.addressBits, 'world-address-bits', { min: 1, max: 64 }),
    exceptionModel: exactString(input.exceptionModel, 'world-exception-model'),
    memoryModel: exactString(input.memoryModel, 'world-memory-model'),
  };
}

export function createWorldScope(value) {
  const input = snapshotContractData(value, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['schema', 'id', 'binarySet', 'profile', 'environment', 'coverage', 'generation'], 'world-fields');
  if (input.schema !== undefined && input.schema !== WORLD_SCOPE_SCHEMA) contractFail('world-schema');
  if (!Array.isArray(input.binarySet) || !input.binarySet.length || input.binarySet.length > 4096) contractFail('world-binary-set');
  const members = input.binarySet.map(binaryMember).sort((a, b) => compareIdentity(a.binaryId, b.binaryId) || compareIdentity(a.sliceId, b.sliceId));
  for (let i = 1; i < members.length; i++) {
    if (members[i].binaryId === members[i - 1].binaryId && members[i].sliceId === members[i - 1].sliceId) contractFail('world-duplicate-binary-slice');
  }
  const env = input.environment;
  recordFields(env, ['dynamicLoading', 'concurrency', 'interposition', 'ambientState'], 'world-environment-fields');
  const body = {
    schema: WORLD_SCOPE_SCHEMA,
    binarySet: members,
    profile: profile(input.profile),
    environment: {
      dynamicLoading: exactEnum(env.dynamicLoading, ['open', 'sealed'], 'world-dynamic-loading'),
      concurrency: exactEnum(env.concurrency, ['single-thread', 'modeled', 'unknown'], 'world-concurrency'),
      interposition: exactEnum(env.interposition, ['possible', 'excluded-with-evidence'], 'world-interposition'),
      ambientState: exactString(env.ambientState, 'world-ambient-state'),
    },
    coverage: exactString(input.coverage, 'world-coverage-required'),
    generation: exactString(input.generation, 'world-generation-required'),
  };
  const id = createEntityId({ binaryId: members[0].binaryId, kind: WORLD_SCOPE_SCHEMA, identity: body });
  assertMatchingId(input.id, id, 'world-id-mismatch');
  const result = deepFreeze({ ...body, id });
  WORLDS.add(result);
  return result;
}

export function assertWorldScope(world) {
  if (!world || !WORLDS.has(world)) contractFail('world-scope-noncanonical');
  return world;
}

export function worldsEqual(left, right) {
  assertWorldScope(left); assertWorldScope(right);
  return left.id === right.id && stableStringify(left) === stableStringify(right);
}

export function worldContains(world, binaryId, sliceId = null) {
  assertWorldScope(world);
  return world.binarySet.some((item) => item.binaryId === binaryId && (sliceId === null || item.sliceId === sliceId));
}

/** SAT qualification requires an independently checked receipt at admission. */
export function createAssumptionSet(value, world) {
  assertWorldScope(world);
  const input = snapshotContractData(value);
  recordFields(input, ['schema', 'id', 'world', 'predicates', 'provenance', 'satisfiability', 'satisfiabilityEvidence'], 'assumption-fields');
  if (input.schema !== undefined && input.schema !== ASSUMPTION_SET_SCHEMA) contractFail('assumption-schema');
  if (input.world !== undefined && input.world !== world.id) contractFail('assumption-world-mismatch');
  const body = {
    schema: ASSUMPTION_SET_SCHEMA, world: world.id,
    predicates: stringSet(input.predicates ?? [], 'assumption-predicates'),
    provenance: stringSet(input.provenance ?? [], 'assumption-provenance'),
    satisfiability: exactEnum(input.satisfiability ?? 'not-checked', ['checked-sat', 'not-checked', 'inconsistent'], 'assumption-satisfiability'),
    satisfiabilityEvidence: stringSet(input.satisfiabilityEvidence ?? [], 'assumption-satisfiability-evidence'),
  };
  if (body.satisfiability !== 'not-checked' && !body.satisfiabilityEvidence.length) contractFail('assumption-satisfiability-evidence-required');
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: ASSUMPTION_SET_SCHEMA, identity: body });
  assertMatchingId(input.id, id, 'assumption-id-mismatch');
  const result = deepFreeze({ ...body, id });
  ASSUMPTIONS.add(result);
  return result;
}

export function assertAssumptionSet(value, world = null) {
  if (!value || !ASSUMPTIONS.has(value)) contractFail('assumption-set-noncanonical');
  if (world !== null && value.world !== assertWorldScope(world).id) contractFail('assumption-world-mismatch');
  return value;
}

/** Difference is identity/provenance, not a proof that a result is reusable. */
export function diffWorldScopes(before, after) {
  assertWorldScope(before); assertWorldScope(after);
  const key = (item) => `${item.binaryId.length}:${item.binaryId}${item.sliceId}`;
  const previous = new Map(before.binarySet.map((item) => [key(item), item]));
  const next = new Map(after.binarySet.map((item) => [key(item), item]));
  const added = [], removed = [], changed = [];
  for (const [id, item] of next) {
    if (!previous.has(id)) added.push(item);
    else if (stableStringify(item) !== stableStringify(previous.get(id))) changed.push({ before: previous.get(id), after: item });
  }
  for (const [id, item] of previous) if (!next.has(id)) removed.push(item);
  return deepFreeze({
    schema: 'world-delta/v1', before: before.id, after: after.id, added, removed, changed,
    profileChanged: stableStringify(before.profile) !== stableStringify(after.profile),
    environmentChanged: stableStringify(before.environment) !== stableStringify(after.environment),
    coverageChanged: before.coverage !== after.coverage,
    generationChanged: before.generation !== after.generation,
  });
}
