/**
 * Phase 7 derived-artifact identity and dependency contract.
 *
 * Phase 7 caches expensive derived analysis (points-to sets, function
 * summaries, escape facts, type graphs, debug-derived facts, function
 * candidates). Reusing one of those against the wrong inputs is not a
 * performance bug, it is a semantic correctness bug: a caller that keeps a
 * precise `NoAlias` after its callee's summary changed is now publishing a
 * false strong conclusion.
 *
 * This module does not introduce a second cache. It builds the canonical
 * `createArtifactDescriptor` key from the Phase 7 dimensions listed in the
 * execution plan, so every Phase 7 producer keys the same way and the existing
 * ArtifactStore dependency validation does the invalidation work.
 */

import { createArtifactDescriptor } from '../core/artifacts/contracts.js';
import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const PHASE7_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Every Phase 7 artifact kind. Naming them here (rather than passing free
 * strings) is what lets the ownership/verifier tests enumerate the set and
 * check that each kind declares its dependency class.
 */
export const PHASE7_ARTIFACT_KINDS = Object.freeze([
  'phase7.alias.region',
  'phase7.pointsto.local',
  'phase7.summary.local',
  'phase7.summary.escape',
  'phase7.summary.interprocedural',
  'phase7.types.constraint-graph',
  'phase7.debug.facts',
  'phase7.discovery.candidates',
]);

const KIND_SET = new Set(PHASE7_ARTIFACT_KINDS);

/**
 * Which semantic inputs each kind is actually derived from.
 *
 * This is the machine-readable form of the plan's change-impact table. It is
 * consulted by `dependencyClassFor` so that invalidation is neither broader
 * (FM-14) nor narrower (FM-15) than the real dependency edges.
 */
export const PHASE7_DEPENDENCY_CLASSES = deepFreeze({
  'phase7.alias.region': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions'],
  'phase7.pointsto.local': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries'],
  'phase7.summary.local': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries'],
  'phase7.summary.escape': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries'],
  'phase7.summary.interprocedural': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries', 'libraryModel'],
  'phase7.types.constraint-graph': ['binary', 'semantic', 'abi', 'calleeSummaries', 'debugIdentity', 'userConstraints'],
  'phase7.debug.facts': ['binary', 'debugIdentity', 'debugProvider'],
  'phase7.discovery.candidates': ['binary', 'loaderEvidence', 'debugIdentity', 'calleeSummaries', 'architecture'],
});

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function optional(value, code = 'phase7-artifact-invalid-optional-id') {
  if (value == null) return null;
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function sortedIds(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => nonEmpty(value, code)))].sort();
}

export function dependencyClassFor(kind) {
  if (!KIND_SET.has(kind)) fail('phase7-artifact-unknown-kind');
  return PHASE7_DEPENDENCY_CLASSES[kind];
}

/**
 * Option-group names recognized across the dependency table.
 *
 * These are the only keys allowed in `input.options`: the descriptor projects
 * the bag down to the option groups the kind's dependency class declares, so
 * an unrelated analysis' tuning options cannot change this kind's identity
 * (FM-14 over-invalidation). Keys that are not a known option group at all
 * fail closed — silently dropping a real dependency's options would narrow
 * the key below the actual semantics (FM-15), which is worse than a cache
 * miss.
 */
const OPTION_CLASS_KEYS = deepFreeze(
  [...new Set(Object.values(PHASE7_DEPENDENCY_CLASSES).flat())]
    .filter((name) => name.endsWith('Options')),
);

function projectOptionsForKind(options, classes) {
  const projected = {};
  const declared = new Set(classes.filter((name) => OPTION_CLASS_KEYS.includes(name)));
  for (const key of Object.keys(options)) {
    if (!OPTION_CLASS_KEYS.includes(key)) fail(`phase7-artifact-unknown-option-class:${key}`);
    if (declared.has(key)) projected[key] = options[key];
  }
  return projected;
}

/**
 * Presentation state that must never enter a semantic cache key.
 *
 * Keying alias analysis by "which tab is open" or "what the user renamed this
 * function to" both over-invalidates and makes the cache non-reproducible, so
 * the descriptor builder rejects these outright instead of silently hashing
 * them.
 */
const FORBIDDEN_KEY_FIELDS = Object.freeze([
  'fileName', 'filename', 'path', 'tabId', 'displayAddress', 'addressText',
  'userName', 'userComment', 'bookmark', 'selection', 'scrollOffset', 'theme',
]);

function assertNoPresentationState(config, seen = new WeakSet()) {
  if (!config || typeof config !== 'object' || seen.has(config)) return;
  seen.add(config);
  try {
    if (config instanceof Map) {
      for (const [key, value] of config) {
        if (typeof key === 'string' && FORBIDDEN_KEY_FIELDS.includes(key)) {
          fail(`phase7-artifact-presentation-state-in-key:${key}`);
        }
        assertNoPresentationState(key, seen);
        assertNoPresentationState(value, seen);
      }
      return;
    }
    if (config instanceof Set) {
      for (const value of config) assertNoPresentationState(value, seen);
      return;
    }
    for (const key of Object.keys(config)) {
      if (FORBIDDEN_KEY_FIELDS.includes(key)) fail(`phase7-artifact-presentation-state-in-key:${key}`);
      assertNoPresentationState(config[key], seen);
    }
  } finally {
    seen.delete(config);
  }
}

/**
 * Builds the canonical descriptor for one Phase 7 artifact.
 *
 * `upstreamArtifactIds` is the load-bearing field: the ArtifactStore refuses to
 * serve a record whose upstreams no longer validate, which is what makes stale
 * reuse impossible rather than merely discouraged.
 */
export function createPhase7ArtifactDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase7-artifact-invalid-input');
  const kind = nonEmpty(input.kind ?? input.artifactKind, 'phase7-artifact-kind-required');
  if (!KIND_SET.has(kind)) fail('phase7-artifact-unknown-kind');
  const classes = dependencyClassFor(kind);

  const budgetClass = optional(input.budgetClass, 'phase7-artifact-invalid-budget-class');
  const architectureSemanticVersion = classes.includes('semantic')
    ? nonEmpty(input.architectureSemanticVersion, 'phase7-artifact-architecture-semantic-version-required')
    : optional(input.architectureSemanticVersion, 'phase7-artifact-invalid-architecture-semantic-version');
  const abiSemanticVersion = classes.includes('abi')
    ? nonEmpty(input.abiSemanticVersion, 'phase7-artifact-abi-semantic-version-required')
    : optional(input.abiSemanticVersion, 'phase7-artifact-invalid-abi-semantic-version');
  // Budget class only belongs in the key when completeness can depend on it.
  // An artifact produced under an exhaustive budget is not interchangeable with
  // one truncated under an interactive budget.
  const keyExtras = {
    phase7SchemaVersion: PHASE7_ARTIFACT_SCHEMA_VERSION,
    architectureId: classes.includes('architecture') || classes.includes('semantic')
      ? nonEmpty(input.architectureId, 'phase7-artifact-architecture-required')
      : optional(input.architectureId, 'phase7-artifact-invalid-architecture-id'),
    abiId: classes.includes('abi')
      ? nonEmpty(input.abiId, 'phase7-artifact-abi-required')
      : optional(input.abiId, 'phase7-artifact-invalid-abi-id'),
    platformId: optional(input.platformId, 'phase7-artifact-invalid-platform-id'),
    snapshotId: nonEmpty(input.snapshotId, 'phase7-artifact-snapshot-required'),
    cfgVersion: classes.includes('cfg') ? nonEmpty(input.cfgVersion, 'phase7-artifact-cfg-version-required') : null,
    ssaVersion: classes.includes('ssa') ? nonEmpty(input.ssaVersion, 'phase7-artifact-ssa-version-required') : null,
    memorySsaVersion: classes.includes('memoryssa')
      ? nonEmpty(input.memorySsaVersion, 'phase7-artifact-memoryssa-version-required')
      : null,
    budgetClass: input.budgetAffectsCompleteness === false ? null : budgetClass,
    calleeSummaryIds: classes.includes('calleeSummaries')
      ? sortedIds(input.calleeSummaryIds, 'phase7-artifact-invalid-callee-summary-id')
      : [],
    libraryModelId: classes.includes('libraryModel') ? optional(input.libraryModelId, 'phase7-artifact-invalid-library-model-id') : null,
    // A declared dependency must be bound in the key: a producer that derives
    // from debug sources has to name which provider version and matched build
    // identity it used. Omitting them would drop the debug dimension from the
    // cache key entirely (#5836).
    debugProviderVersion: classes.includes('debugProvider')
      ? nonEmpty(input.debugProviderVersion, 'phase7-artifact-debug-provider-version-required')
      : classes.includes('debugIdentity')
      ? optional(input.debugProviderVersion, 'phase7-artifact-invalid-debug-provider-version')
      : null,
    debugBuildIdentity: kind === 'phase7.debug.facts'
      ? nonEmpty(input.debugBuildIdentity, 'phase7-artifact-debug-build-identity-required')
      : optional(input.debugBuildIdentity, 'phase7-artifact-invalid-debug-build-identity'),
    // The debug identity digest binds the full canonical debug identity —
    // including the matched-partial coverage domain that decides which
    // records are hard evidence — into the key (#5849).
    debugIdentityDigest: classes.includes('debugIdentity')
      ? nonEmpty(input.debugIdentityDigest, 'phase7-artifact-debug-identity-digest-required')
      : null,
    loaderEvidenceId: classes.includes('loaderEvidence') ? optional(input.loaderEvidenceId, 'phase7-artifact-invalid-loader-evidence-id') : null,
    userConstraintDigest: classes.includes('userConstraints') ? optional(input.userConstraintDigest, 'phase7-artifact-invalid-user-constraint-digest') : null,
  };

  const options = input.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('phase7-artifact-invalid-options');
  assertNoPresentationState(options);
  const kindOptions = projectOptionsForKind(options, classes);

  return createArtifactDescriptor({
    binaryId: nonEmpty(input.binaryId, 'phase7-artifact-binary-id-required'),
    sliceId: optional(input.sliceId, 'phase7-artifact-invalid-slice-id'),
    entityId: optional(input.functionId ?? input.entityId, 'phase7-artifact-invalid-entity-id'),
    artifactKind: kind,
    producerId: nonEmpty(input.analyzerId, 'phase7-artifact-analyzer-required'),
    producerVersion: nonEmpty(input.analyzerVersion, 'phase7-artifact-analyzer-version-required'),
    versions: {
      loader: input.loaderVersion ?? 'n/a',
      architectureSemantic: architectureSemanticVersion ?? 'n/a',
      abiSemantic: abiSemanticVersion ?? 'n/a',
      semanticSchema: nonEmpty(input.semanticSchemaVersion, 'phase7-artifact-semantic-schema-required'),
    },
    relevance: {
      loader: input.loaderVersion != null,
      architectureSemantic: classes.includes('semantic') || architectureSemanticVersion != null,
      abiSemantic: classes.includes('abi') || abiSemanticVersion != null,
      semanticSchema: true,
      provider: keyExtras.debugProviderVersion != null,
    },
    providerVersion: keyExtras.debugProviderVersion ?? undefined,
    config: kindOptions,
    keyExtras,
    upstreamArtifactIds: sortedIds(input.upstreamArtifactIds, 'phase7-artifact-invalid-upstream-id'),
    originRefs: sortedIds(input.originRefs, 'phase7-artifact-invalid-origin-ref'),
  });
}

/**
 * Explains why a cached artifact does not match a request.
 *
 * Consumers use the returned reason to schedule recomputation. They must never
 * treat "no reason found but ids differ" as permission to use the old record,
 * which is why an unexplained mismatch still reports `identity`.
 */
export function explainArtifactMismatch(expected, observed) {
  if (!expected || !observed) return 'missing';
  if (expected.artifactId === observed.artifactId) return null;
  if (expected.artifactKind !== observed.artifactKind) return 'kind';
  if (expected.binaryId !== observed.binaryId) return 'binary';
  if (expected.producerVersion !== observed.producerVersion) return 'analyzer-version';
  if (stableDigest(expected.versions) !== stableDigest(observed.versions)) return 'semantic-version';
  if (stableDigest(expected.upstreamArtifactIds) !== stableDigest(observed.upstreamArtifactIds)) return 'dependency';
  if (expected.keyMaterialHash !== observed.keyMaterialHash) return 'options';
  return 'identity';
}
