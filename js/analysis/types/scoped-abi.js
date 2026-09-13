/** Read-only ABI placement consistency, preserving the canonical ABI owner. */
import { canonicalAbiEvidence, canonicalAbiHiddenResult, abiResultInvalidState,
  abiPhysicalIntervalsValid, normalizeAbiPieces } from '../../targets/abi/evidence.js';
import { arm64RegisterOperand } from '../../targets/architecture/arm64/effects/addressing.js';
import { TypeConstraintGraph, TYPE_GRAPH_ANALYZER_VERSION } from './graph.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, contractFail } from '../../core/identity/structured.js';

export const SCOPED_ABI_PLACEMENT_SCHEMA = 'scoped-abi-placement-evidence/v1';
export const SCOPED_ABI_PLACEMENT_VERSION = '1.1.0';
const MAX_ARGUMENTS = 64, MAX_PIECES = 16;
const TYPE_LIMITS = Object.freeze({ maxConstraintsPerLayer: 64, maxComparisonsPerLayer: 1024,
  maxContradictionsPerLayer: 32, maxNodes: 128, maxEdges: 512, maxComponents: 128, maxIterationsPerComponent: 8 });

/** Adapt only the canonical ABI owner's hidden same-object stack marker.
 * General wire snapshots must continue to reject hidden properties/accessors.
 * Projection is synchronous, bounded and preserves actual mirror identity; a
 * copied scalar entry never gains the owner's same-object mirror exception.
 */
function snapshotAbiResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) contractFail('scoped-abi-result-record');
  const descriptors = Object.getOwnPropertyDescriptors(input), lists = new Map();
  for (const name of ['arguments', 'stackArguments']) {
    const descriptor = descriptors[name];
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) contractFail('scoped-abi-result-data-fields');
    const array = descriptor.value;
    if (!Array.isArray(array)) continue; // The canonical validator decides missing/invalid result shapes.
    if (Object.getPrototypeOf(array) !== Array.prototype || array.length > MAX_ARGUMENTS
      || Reflect.ownKeys(array).length !== array.length + 1) contractFail('scoped-abi-entry-budget-or-array');
    const entries = [];
    for (let index = 0; index < array.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(array, String(index));
      if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) contractFail('scoped-abi-entry-data-fields');
      entries.push(entry.value);
    }
    lists.set(name, entries);
  }
  const replacements = new Map();
  for (const entry of lists.get('arguments') ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const marker = Object.getOwnPropertyDescriptor(entry, 'canonicalStackMirror');
    if (!marker || marker.enumerable) continue;
    if (!Object.hasOwn(marker, 'value') || marker.value !== true
      || !(lists.get('stackArguments') ?? []).includes(entry)) contractFail('scoped-abi-hidden-mirror-invalid');
    const fields = Object.getOwnPropertyDescriptors(entry);
    fields.canonicalStackMirror = { value: true, enumerable: true };
    replacements.set(entry, Object.create(Object.getPrototypeOf(entry), fields));
  }
  for (const [name, entries] of lists) {
    descriptors[name] = { ...descriptors[name], value: entries.map(entry => replacements.get(entry) ?? entry) };
  }
  return snapshotContractData(Object.create(Object.getPrototypeOf(input), descriptors), {
    preserveAliases: true, allowUndefined: true, allowBigInt: true, maxBytes: 1048576, maxNodes: 32768,
  });
}

function physicalPiece(piece, index, logicalBitOffset = null) {
  const bits = exactInteger(piece.bits, 'scoped-abi-piece-bits', { min: 1, max: 1048576 });
  const bytes = exactInteger(piece.bytes, 'scoped-abi-piece-bytes', { min: 1, max: 131072 });
  if (bits > bytes * 8) contractFail('scoped-abi-piece-physical-width');
  const byteOffset = piece.byteOffset == null ? null : exactInteger(piece.byteOffset, 'scoped-abi-logical-offset', { max: 1048576 });
  const offset = logicalBitOffset ?? (byteOffset === null ? null : byteOffset * 8);
  if (offset === null) contractFail('scoped-abi-logical-offset-required');
  let destination;
  if (piece.reg != null) {
    if (piece.stackOffset != null) contractFail('scoped-abi-piece-mixed-storage');
    const name = exactString(piece.reg, 'scoped-abi-register', 64), descriptor = arm64RegisterOperand(name);
    if (!descriptor || descriptor.zero || descriptor.kind === 'sp' || bits > descriptor.bits) contractFail('scoped-abi-register-view-invalid');
    const physicalBitOffset = piece.physicalBitOffset == null ? 0 : exactInteger(piece.physicalBitOffset, 'scoped-abi-register-offset', { max: 127 });
    if (physicalBitOffset + bits > descriptor.bits) contractFail('scoped-abi-register-view-overflow');
    destination = { kind: 'register', register: name, physicalRegister: descriptor.physicalId,
      physicalBitOffset, physicalBits: descriptor.kind === 'vector' ? 128 : 64, viewBits: descriptor.bits };
  } else {
    const stackOffset = exactInteger(piece.stackOffset ?? piece.offset, 'scoped-abi-stack-offset', { max: 1048576 });
    destination = { kind: 'stack', offset: String(stackOffset), coordinate: 'canonical-abi-call-frame' };
  }
  return { index, logicalBitOffset: offset, bitSize: bits, physicalBytes: bytes,
    abiClass: piece.abiClass == null ? null : exactString(piece.abiClass, 'scoped-abi-class'), destination };
}

function placement(entry, index) {
  if (!entry || abiResultInvalidState(entry) || entry.possible === true || entry.mustUse === false || entry.exact === false) return {
    index, status: 'unresolved', reason: 'canonical-abi-placement-incomplete', pieces: [] };
  return declaredGeometry(entry, index);
}

/** Geometry alone conveys neither must-use nor prototype authority. */
function declaredGeometry(entry, index) {
  if (!entry || typeof entry !== 'object') return { index, status: 'unresolved', reason: 'canonical-entry-missing', pieces: [] };
  const rawPieces = entry.pieces ?? entry.parts;
  if (rawPieces != null) {
    if (!Array.isArray(rawPieces) || !rawPieces.length || rawPieces.length > MAX_PIECES) contractFail('scoped-abi-piece-count');
    const pieces = normalizeAbiPieces(entry, rawPieces);
    if (!pieces) return { index, status: 'inconsistent', reason: 'canonical-aggregate-piece-proof-invalid', pieces: [] };
    return { index, status: 'owner-declared', bits: entry.bits, bytes: entry.bytes,
      pieces: pieces.map((piece, i) => physicalPiece(piece, i)) };
  }
  if (entry.aggregate === true || Array.isArray(entry.regs) && entry.regs.length > 1) return {
    index, status: 'unresolved', reason: 'aggregate-layout-not-implied-by-register-list', pieces: [] };
  const reg = entry.reg ?? (entry.regs?.length === 1 ? entry.regs[0] : null);
  if (reg === null && entry.stackOffset == null && entry.offset == null) return {
    index, status: 'unresolved', reason: 'canonical-physical-location-unavailable', pieces: [] };
  if (!Number.isSafeInteger(entry.bits) || !Number.isSafeInteger(entry.bytes)) return {
    index, status: 'unresolved', reason: 'canonical-width-and-span-required', pieces: [] };
  return { index, status: 'owner-declared', bits: entry.bits, bytes: entry.bytes,
    pieces: [physicalPiece({ ...entry, reg }, 0, 0)] };
}

/** Detect physical x/w and SIMD subregister overlap using the existing ISA owner. */
function conflicts(placements, work) {
  const slots = new Map(), rows = [];
  for (const argument of placements) for (const piece of argument.pieces) {
    work.charge('workUnits');
    const destination = piece.destination;
    const key = destination.kind === 'stack' ? 'stack' : destination.physicalRegister;
    const start = destination.kind === 'stack' ? BigInt(destination.offset) * 8n : BigInt(destination.physicalBitOffset);
    const end = start + (destination.kind === 'stack' ? BigInt(piece.physicalBytes) * 8n : BigInt(piece.bitSize));
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push({ index: argument.index, piece: piece.index, start, end });
  }
  for (const [physicalStorage, spans] of slots) {
    spans.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a.index - b.index);
    // Bounded sweepline. Checking all active owners catches nested overlapping
    // spans, not only neighboring starts. At most 64 * 16 supplied pieces.
    let active = [];
    for (const span of spans) {
      work.charge('workUnits'); active = active.filter((candidate) => candidate.end > span.start);
      for (const prior of active) {
        work.charge('workUnits');
        if (rows.length >= 128) return { rows, truncated: true };
        rows.push({ physicalStorage, left: { argument: prior.index, piece: prior.piece },
          right: { argument: span.index, piece: span.piece }, reason: 'overlapping-physical-placement' });
      }
      active.push(span);
    }
  }
  return { rows, truncated: false };
}

export async function queryScopedAbiPlacement(request, { world, assumptions, snapshotId, work, getContext = null, allowPartialDeclarations = false } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  recordFields(request, ['functionId', 'kind', 'callSiteId'], 'scoped-abi-query-fields');
  const functionId = exactString(request.functionId, 'scoped-abi-function');
  const kind = exactEnum(request.kind, ['arguments', 'return'], 'scoped-abi-query-kind');
  const callSiteId = request.callSiteId == null ? null : exactString(request.callSiteId, 'scoped-abi-callsite');
  if (!getContext) return { status: 'unsupported', reason: 'canonical-abi-placement-owner-unbound', exact: false };
  const context = await work.await((signal) => getContext(functionId, { kind, callSiteId, world, assumptions, snapshotId, work, signal }));
  if (!context) return { status: 'unsupported', reason: 'canonical-abi-placement-unavailable', exact: false };
  if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('scoped-abi-current-owner-required');
  const binding = snapshotContractData(context.binding, { maxBytes: 32768 });
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId', 'kind', 'callSiteId',
    'producerArtifactId', 'ownerRevision'], 'scoped-abi-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.functionId !== functionId || binding.kind !== kind || binding.callSiteId !== callSiteId
    || !world.binarySet.some((member) => member.binaryId === binding.binaryId)) contractFail('scoped-abi-scope-mismatch');
  exactString(binding.producerArtifactId, 'scoped-abi-producer-artifact'); exactString(binding.ownerRevision, 'scoped-abi-owner-revision');
  // Preserve the ABI owner's same-object stack mirror. A normal wire clone
  // intentionally loses this authority and must be rejected by its validator.
  const raw = snapshotAbiResult(context.result);
  if (context.isCurrent() !== true) contractFail('scoped-abi-owner-changed');
  if (!canonicalAbiEvidence(raw) || raw.abiId !== world.profile.abi || raw.abiSemanticVersion !== world.profile.abiRevision
    || raw.invalidation.snapshotId !== snapshotId || raw.invalidation.functionId !== functionId
    || raw.invalidation.binaryId !== binding.binaryId) return {
    status: 'unsupported', reason: 'canonical-abi-identity-envelope-unqualified', exact: false };
  const ownerState = abiResultInvalidState(raw);
  if (ownerState === 'partial' && allowPartialDeclarations === true) {
    // Inspection ONLY: a missing prototype must neither hide the native
    // classifier's candidates nor permit those candidates to mint hard type
    // facts or a closed argument count. Ordinary qualified callers stay strict.
    const entries = kind === 'arguments' ? raw.arguments : raw.returnLocations ?? [];
    if (!Array.isArray(entries) || entries.length > MAX_ARGUMENTS) contractFail('scoped-abi-partial-entry-bound');
    work.charge('workUnits', entries.length + 1);
    const candidates = entries.map((entry, index) => {
      work.charge('workUnits', (entry?.pieces?.length ?? entry?.parts?.length ?? 1) + 1);
      const geometry = declaredGeometry(entry, index);
      return { index, status: 'unresolved', reason: 'prototype-and-arity-not-established', declaration: entry,
        pieces: [], candidatePieces: geometry.pieces, candidateStatus: geometry.status === 'owner-declared' ? 'described-only' : geometry.status,
        candidateReason: geometry.reason ?? null, staticExact: false, typeConstraintPublished: false };
    });
    const candidateConflicts = conflicts(candidates.map(row => ({ index: row.index, pieces: row.candidatePieces })), work);
    work.checkpoint(); if (context.isCurrent() !== true) contractFail('scoped-abi-owner-stale-before-publication');
    return deepFreeze({ schema: SCOPED_ABI_PLACEMENT_SCHEMA, version: SCOPED_ABI_PLACEMENT_VERSION,
      status: 'partial', reason: 'canonical-abi-partial', binding,
      canonicalOwner: { abiId: raw.abiId, abiSemanticVersion: raw.abiSemanticVersion,
        abiSemanticIdentity: raw.abiSemanticIdentity, registryDigest: raw.registryDigest },
      results: candidates, candidateConflicts, candidateAuthority: 'geometry-of-owner-declarations-only',
      hiddenResult: null, exact: false, argumentCountClosed: false,
      remaining: ['prototype-authority-not-established', 'physical-placement-unqualified', 'machine-call-behavior-not-independently-verified'] });
  }
  if (ownerState) return { status: 'unsupported', reason: `canonical-abi-${ownerState}`, exact: false };
  if ((raw.arguments?.length ?? 0) > MAX_ARGUMENTS || (raw.stackArguments?.length ?? 0) > MAX_ARGUMENTS
    || (raw.returnLocations?.length ?? 0) > MAX_ARGUMENTS) contractFail('scoped-abi-entry-budget');
  work.charge('workUnits');
  if (!abiPhysicalIntervalsValid(raw)) return { status: 'inconsistent', reason: 'canonical-abi-physical-proof-rejected', exact: false };
  let hiddenResult = null, placements;
  if (kind === 'return' && raw.indirect === true) {
    if (!canonicalAbiHiddenResult(raw, raw.hiddenResultPointer)) return { status: 'inconsistent', reason: 'hidden-result-proof-rejected', exact: false };
    const hidden = raw.hiddenResultPointer;
    const register = arm64RegisterOperand(hidden.input);
    if (!register || register.zero || register.bits !== hidden.pointerBits) contractFail('scoped-abi-hidden-result-register');
    hiddenResult = { location: 'register', input: hidden.input, physicalRegister: register.physicalId,
      pointerBits: hidden.pointerBits, resultLocation: raw.resultLocation, evidence: 'canonical-hidden-result-envelope', exact: false };
    placements = [];
  } else {
    const entries = kind === 'arguments' ? raw.arguments : raw.returnLocations ?? [raw];
    if (!Array.isArray(entries)) return { status: 'unsupported', reason: 'canonical-abi-entry-list-missing', exact: false };
    const indexes = new Set();
    placements = entries.map((entry, index) => {
      const argumentIndex = kind === 'arguments'
        ? exactInteger(entry?.index, 'scoped-abi-argument-index', { max: 4095 }) : index;
      if (indexes.has(argumentIndex)) contractFail('scoped-abi-duplicate-argument-index');
      indexes.add(argumentIndex);
      return placement(entry, argumentIndex);
    });
  }
  const collision = conflicts(placements, work);
  const graph = new TypeConstraintGraph({ snapshotId, limits: TYPE_LIMITS });
  const results = [];
  for (const entry of placements) {
    work.charge('workUnits');
    const entityId = createEntityId({ binaryId: binding.binaryId, kind: 'abi-physical-value-port',
      identity: { binding, index: entry.index, version: SCOPED_ABI_PLACEMENT_VERSION } });
    if (entry.status === 'owner-declared' && !collision.rows.some((row) => row.left.argument === entry.index || row.right.argument === entry.index)) {
      graph.addHardConstraint({ kind: 'abi-location', origin: 'abi-boundary', claim: { entityId, layer: 'abi',
        descriptor: { kind: 'physical-placement', widthBits: entry.bits, sizeBytes: entry.bytes, pieces: entry.pieces } },
        evidenceIds: [binding.producerArtifactId], providerVersion: raw.abiSemanticVersion,
        abiProfile: raw.abiId, buildIdentity: { snapshotId, binaryId: binding.binaryId, functionId } });
    }
    results.push({ ...entry, entityId, graph: graph.solveEntity(entityId, { signal: work.signal }), staticExact: false });
    await work.yieldIfNeeded();
  }
  work.checkpoint(); if (context.isCurrent() !== true) contractFail('scoped-abi-owner-stale-before-publication');
  const body = snapshotContractData({ schema: SCOPED_ABI_PLACEMENT_SCHEMA, version: SCOPED_ABI_PLACEMENT_VERSION,
    status: collision.rows.length ? 'inconsistent' : 'completed', binding,
    canonicalOwner: { abiId: raw.abiId, abiSemanticVersion: raw.abiSemanticVersion, abiSemanticIdentity: raw.abiSemanticIdentity,
      registryDigest: raw.registryDigest, typeGraphVersion: TYPE_GRAPH_ANALYZER_VERSION },
    results, hiddenResult, conflicts: collision, exact: false, scope: 'supplied-canonical-physical-declarations',
    remaining: ['prototype-authority-not-established', 'machine-call-behavior-not-independently-verified',
      'variadic-liveness-and-save-area-coverage', 'nominal-types-unrecovered'] }, { allowBigInt: true, maxNodes: 65536, maxBytes: 2097152 });
  return deepFreeze({ ...body, digest: stableDigest({ body, typed: lossyTypeWitness(body) }), cost: work.cost() });
}
