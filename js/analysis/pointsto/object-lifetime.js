/** Lifetime descriptors over the existing points-to/escape/summary owners.
 * No heap contents, alias solver or runtime allocation namespace is created.
 * A bounded frame describes normal activation boundaries, not validity of an
 * arbitrary pointer or uniqueness across recursive/concurrent activations. */
import { createEntityId, deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { exactString, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { createPointsToTarget, provenSeparationAuthority } from './lattice.js';
import { classifyRootOrigin, createEscapeRecord } from '../summary/escape.js';
import { createFunctionSummary, functionSummaryDigest } from '../summary/contract.js';

export const OBJECT_LIFETIME_VERSION = '1.0.0';
const OWNERS = new WeakMap();
const same = (a, b) => stableStringify(a) === stableStringify(b);
const rootShape = t => ({ rootKey: t.rootKey, rootKind: t.rootKind, rootEntityId: t.rootEntityId,
  rootIdentity: t.rootIdentity, address: t.address, addressSpace: t.addressSpace });

export function createCanonicalObjectLifetimeOwner({ ir, cfg, pointsToRun, escapeResult, summary,
  world, assumptions, snapshotId, binaryId, work } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  exactString(snapshotId, 'object-lifetime-snapshot');
  if (!ir || !cfg || cfg.functionId !== ir.functionId || !world.binarySet.some(row => row.binaryId === binaryId)
    || !ir.origin?.byteRanges?.length || ir.origin.byteRanges.some(row => row.binaryId !== binaryId)
    || pointsToRun?.status?.snapshotId !== snapshotId || escapeResult?.status?.snapshotId !== snapshotId
    || !Array.isArray(ir.nodes) || ir.nodes.length > 4096 || !Array.isArray(cfg.blocks) || cfg.blocks.length > 1024
    || typeof pointsToRun.pointsTo?.values !== 'function' || typeof escapeResult.nonEscapingRoots?.has !== 'function'
    || typeof escapeResult.rootOrigins?.get !== 'function') contractFail('object-lifetime-canonical-owner-binding');
  const ownedSummary = createFunctionSummary(summary);
  if (ownedSummary.functionId !== ir.functionId || ownedSummary.status.snapshotId !== snapshotId) contractFail('object-lifetime-summary-binding');
  const roots = new Map(), escaped = new Map();
  for (const sets of [pointsToRun.pointsTo, pointsToRun.ssaPointsTo]) {
    if (!sets) continue;
    for (const set of sets.values()) {
      work.charge('workUnits');
      for (const input of set.targets ?? []) {
        work.charge('workUnits'); const target = createPointsToTarget(input), old = roots.get(target.rootKey);
        if (old && !same(rootShape(old), rootShape(target))) contractFail('object-lifetime-root-collision');
        if (!old) { if (roots.size >= 8192) contractFail('object-lifetime-root-budget'); roots.set(target.rootKey, target); work.charge('residentBytes', 1024); }
      }
    }
  }
  if (!Array.isArray(escapeResult.escapes) || escapeResult.escapes.length > 16384) contractFail('object-lifetime-escape-budget');
  for (const input of escapeResult.escapes) {
    work.charge('workUnits'); const row = createEscapeRecord(input), list = escaped.get(row.rootKey) ?? [];
    list.push(row); escaped.set(row.rootKey, list);
  }
  const nodes = new Map(ir.nodes.map(row => [row.id, row])), blocks = new Map((ir.blocks ?? []).map(row => [row.id, row]));
  const exits = ir.nodes.filter(row => row.kind === 'return').map(row => row.id).sort();
  const normalExitCoverage = cfg.blocks.length > 0 && cfg.blocks.some(row => row.id === cfg.entryBlockId)
    && cfg.blocks.every(row => Array.isArray(row.successors) && (row.successors.length > 0
      || nodes.get(blocks.get(row.id)?.nodeIds?.at(-1))?.kind === 'return'));
  const complete = pointsToRun.status.completeness === 'complete' && escapeResult.status.completeness === 'complete';
  const source = { worldId: world.id, assumptionsId: assumptions.id, snapshotId, binaryId, functionId: ir.functionId,
    irDigest: stableDigest(ir), cfgDigest: stableDigest(cfg), summaryDigest: functionSummaryDigest(ownedSummary),
    pointsStatus: pointsToRun.status, escapeStatus: escapeResult.status,
    roots: [...roots].map(([key, target]) => [key, rootShape(target), escapeResult.rootOrigins.get(key) ?? null,
      escapeResult.nonEscapingRoots.has(key), escaped.get(key) ?? []]) };
  work.charge('residentBytes', stableStringify(source).length * 2); work.checkpoint();
  const sourceDigest = stableDigest(source), owner = Object.freeze({ version: OBJECT_LIFETIME_VERSION, sourceDigest,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId, binaryId, functionId: ir.functionId });
  OWNERS.set(owner, { roots, escaped, origins: new Map([...roots.keys()].map(key => [key, escapeResult.rootOrigins.get(key)])),
    nonEscaping: new Set([...roots.keys()].filter(key => escapeResult.nonEscapingRoots.has(key))),
    world, assumptions, complete, entry: cfg.entryBlockId, exits, normalExitCoverage,
    callFree: ir.nodes.every(row => !row.call), summaryComplete: ownedSummary.status.completeness === 'complete',
    allocations: ownedSummary.allocations, frees: ownedSummary.frees });
  return owner;
}

export function describeCanonicalObjectLifetime(owner, targetInput, context, { world, assumptions } = {}) {
  const source = OWNERS.get(owner);
  if (!source || owner.worldId !== world?.id || owner.assumptionsId !== assumptions?.id) contractFail('object-lifetime-owner-unbound');
  const target = createPointsToTarget(targetInput), original = source.roots.get(target.rootKey);
  if (!original || !same(rootShape(original), rootShape(target))) contractFail('object-lifetime-target-not-owned');
  const records = source.escaped.get(target.rootKey) ?? [], origin = source.origins.get(target.rootKey) ?? classifyRootOrigin(original);
  const physicalStack = original.rootIdentity?.kind === 'semantic-state-root'
    && original.rootIdentity.functionId === owner.functionId
    && original.rootIdentity.variable?.physicalIdentity?.kind === 'register'
    && original.rootIdentity.variable.physicalIdentity.registerId === 'sp';
  const tls = provenSeparationAuthority(original) === 'root-descriptor' && original.separationClass === 'tls-like';
  const kind = tls ? 'tls' : origin === 'local-frame' || physicalStack ? 'stack' : origin === 'local-allocation' ? 'heap' : origin === 'global' ? 'global' : 'unknown';
  const cardinality = ['stack', 'heap', 'tls'].includes(kind) ? 'summary-many' : 'unknown';
  const destinations = records.map(row => ({ boundary: row.boundary, reason: row.reason, siteId: row.siteId, evidenceIds: row.evidenceIds }));
  const bounded = origin === 'local-frame' && source.complete && source.summaryComplete && source.callFree && source.normalExitCoverage
    && source.exits.length > 0 && source.nonEscaping.has(target.rootKey) && records.length === 0 && source.frees.length === 0;
  const epoch = createEntityId({ binaryId: owner.binaryId, kind: 'object-lifetime-epoch',
    identity: { sourceDigest: owner.sourceDigest, root: target.rootKey, context } });
  const begin = kind === 'stack' ? [source.entry] : kind === 'heap' && target.rootEntityId ? [target.rootEntityId] : [];
  const status = destinations.length ? 'escaping' : bounded ? 'bounded' : 'unknown';
  return deepFreeze({ schema: 'canonical-object-lifetime/v1', version: OBJECT_LIFETIME_VERSION,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId: owner.snapshotId, functionId: owner.functionId,
    sourceDigest: owner.sourceDigest, kind, cardinality,
    cardinalityMeaning: cardinality === 'summary-many' ? 'abstract-partition-may-denote-multiple-instances' : 'instance-count-unproved',
    allocationSite: kind === 'heap' ? target.rootEntityId : null,
    lifetime: { begin, end: bounded ? source.exits : [], epoch, status, scope: 'normal-function-activation; not-pointer-validity' },
    summaryLifetimeEffects: { allocations: source.allocations, frees: source.frees, targetBinding: 'unqualified' },
    escape: { destinations, upperComplete: source.complete },
    activation: kind === 'stack' ? { functionId: owner.functionId, entryBlockId: source.entry, context, recursiveInstances: 'may-be-many' } : null,
    thread: kind === 'tls' ? { model: world.environment.concurrency, selectedThread: null, instanceIdentity: 'unbound' } : null,
    remaining: [...(cardinality !== 'singleton-proven' ? ['object-instance-uniqueness-unproved'] : []),
      ...(status === 'unknown' ? ['lifetime-boundaries-unproved'] : []), ...(kind === 'tls' ? ['tls-thread-identity-unbound'] : []),
      ...(physicalStack && origin !== 'local-frame' ? ['incoming-stack-base-not-a-local-allocation-lifetime'] : []),
      ...(kind === 'heap' ? ['allocation-site-is-not-runtime-allocation-id', 'free-and-address-reuse-not-closed'] : [])],
    aliasAuthority: false, strongUpdateAuthority: false });
}
