/** Bounded, content-checked exports of the canonical EvidenceGraph. */
import { EvidenceGraph, createEvidenceNode, createEvidenceEdge } from './index.js';
import { createEntityId, deepFreeze, stableStringify } from '../identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../identity/world.js';
import { snapshotContractData, exactString, exactInteger, stringSet, recordFields, compareIdentity, unsignedAddress, sha256Text, contractFail } from '../identity/structured.js';
import { assertScopedAnalysisWork, workStopStatus } from '../budgets/scoped-work.js';
import { scheduleProofDag } from './proof-dag.js';

export const CERTIFICATE_SLICE_SCHEMA = 'evidence-certificate-slice/v1';
export const CERTIFICATE_REPLAY_SCHEMA = 'evidence-certificate-replay/v1';
const MAX_SLICE_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_BYTES = 65536;
const INBOUND_CONTEXT = ['contradicts', 'supersedes'];

async function sha256(bytes, work) {
  if (!globalThis.crypto?.subtle) contractFail('certificate-sha256-unavailable');
  const digest = await work.await(() => globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
async function bodyHash(body, work) {
  const bytes = new TextEncoder().encode(stableStringify(body));
  if (bytes.length > MAX_SLICE_BYTES) contractFail('certificate-payload-budget');
  work.charge('residentBytes', bytes.length);
  return sha256(bytes, work);
}
function referenceIds(node) {
  if (node.family !== 'Claim') return [];
  return stringSet([...node.supportingEvidenceIds, ...node.contradictingEvidenceIds, ...node.confirmedByEvidenceIds]);
}
function rangeDescriptor(range, node, world) {
  const binaryId = range.binaryId ?? node.binaryId;
  if (!worldContains(world, binaryId)) return null;
  const start = unsignedAddress(range.start, { bits: 64 });
  const end = unsignedAddress(range.end, { bits: 64, allowEnd: true });
  if (BigInt(end) <= BigInt(start)) contractFail('certificate-byte-range-empty-or-reversed');
  return { binaryId, start, end };
}

/** Export is provenance/byte integrity; graph traversal alone is NOT proof. */
export async function exportEvidenceCertificate({ graph, roots, world, assumptions, work, readRange = null, includeBytes = false } = {}) {
  if (!(graph instanceof EvidenceGraph)) contractFail('certificate-canonical-graph-required');
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  if (typeof includeBytes !== 'boolean') contractFail('certificate-include-bytes');
  const rootIds = stringSet(roots, 'certificate-roots', 128);
  if (!rootIds.length) contractFail('certificate-roots-empty');
  const revision = graph.revision;
  const pending = rootIds.slice(), queued = new Set(rootIds), nodes = [], edges = new Map(), ranges = new Map(), frontier = [];
  let head = 0, status = 'completed';
  const unchanged = () => { if (graph.revision !== revision) throw Object.assign(new Error('evidence-graph-mutated'), { code: 'certificate-stale' }); };
  try {
    await graph.prepareEdgeIndex(work, { maxEdges: Math.min(262144, work.limits.edges) });
    unchanged();
    while (head < pending.length) {
      work.charge('nodes'); work.charge('workUnits');
      const id = pending[head++];
      const node = graph.getNode(id);
      if (!node) { frontier.push({ kind: 'missing-evidence', id }); continue; }
      if (node.binaryId !== null && !worldContains(world, node.binaryId)) {
        frontier.push({ kind: 'foreign-binary-evidence', id }); continue;
      }
      // Per-node bounded clone rejects hostile payloads before accumulation.
      const detached = snapshotContractData(node, { maxBytes: 256 * 1024, maxNodes: 8192 });
      const size = new TextEncoder().encode(stableStringify(detached)).length;
      work.charge('residentBytes', size); nodes.push(detached);
      const enqueue = (target) => {
        if (queued.has(target)) return;
        work.charge('queueOperations'); work.charge('residentBytes', 96 + target.length * 2);
        queued.add(target); pending.push(target);
      };
      for (const target of referenceIds(node)) enqueue(target);
      for (const direction of ['outgoing', 'incoming']) {
        let offset = 0, mode = null;
        do {
          const page = graph.edgePage(id, { direction, offset, mode, limit: 128, maxScanned: 512,
            types: direction === 'incoming' ? INBOUND_CONTEXT : null, expectedRevision: revision, signal: work.signal });
          if (page.status === 'stale') throw Object.assign(new Error('evidence-graph-mutated'), { code: 'certificate-stale' });
          work.charge('workUnits', page.scanned); mode = page.mode;
          for (const edge of page.edges) {
            const key = stableStringify(edge);
            if (!edges.has(key)) { work.charge('edges'); work.charge('residentBytes', 96 + key.length * 2); edges.set(key, edge); }
            enqueue(direction === 'outgoing' ? edge.to : edge.from);
          }
          offset = page.nextOffset;
          await work.yieldIfNeeded(); unchanged();
        } while (offset !== null);
      }
      for (const rawRange of node.origin?.byteRanges ?? []) {
        const range = rangeDescriptor(rawRange, node, world);
        if (!range) { frontier.push({ kind: 'unbound-byte-range', id }); continue; }
        const key = stableStringify(range);
        if (!ranges.has(key)) {
          work.charge('workUnits'); work.charge('residentBytes', 256);
          ranges.set(key, { ...range, evidenceIds: [node.id], sha256: null });
        } else ranges.get(key).evidenceIds.push(node.id);
      }
      if (!(node.origin?.byteRanges?.length) && node.family === 'BinaryEvidence') frontier.push({ kind: 'binary-evidence-without-file-range', id });
      await work.yieldIfNeeded(); unchanged();
    }
    for (const range of ranges.values()) {
      range.evidenceIds = stringSet(range.evidenceIds);
      if (typeof readRange !== 'function') { frontier.push({ kind: 'byte-reader-unavailable', range }); continue; }
      const length = BigInt(range.end) - BigInt(range.start);
      if (length > BigInt(MAX_RANGE_BYTES)) { frontier.push({ kind: 'byte-range-too-large', range }); continue; }
      work.charge('bytesRead', Number(length)); work.charge('residentBytes', Number(length));
      const response = await work.await((signal) => readRange({ binaryId: range.binaryId, offset: range.start, length: Number(length), worldId: world.id }, { signal }));
      unchanged();
      // Bind the exact build/world/range, never accept bare bytes from a provider.
      if (response?.worldId !== world.id || response?.binaryId !== range.binaryId || response?.offset !== range.start
        || !(response?.bytes instanceof Uint8Array) || response.bytes.byteLength !== Number(length)) {
        frontier.push({ kind: 'byte-read-binding-rejected', range }); continue;
      }
      const bytes = response.bytes.slice();
      range.sha256 = await sha256(bytes, work);
      if (includeBytes) range.hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
      unchanged();
    }
  } catch (error) {
    const stopped = workStopStatus(error, work.signal);
    if (error?.code === 'certificate-stale') status = 'stale';
    else if (stopped) status = stopped;
    else throw error;
    frontier.push({ kind: status, pendingEvidenceIds: pending.slice(head), reason: String(error?.message ?? status) });
  }
  // A stopped or changed graph cannot issue a publishable certificate or hash.
  if (status !== 'completed' || graph.revision !== revision) {
    return deepFreeze({ status: status === 'completed' ? 'stale' : status, certificate: null,
      partial: { nodeIds: nodes.map((node) => node.id), edgeCount: edges.size, rangeCount: ranges.size }, frontier, cost: work.cost() });
  }
  const body = snapshotContractData({ schema: CERTIFICATE_SLICE_SCHEMA, worldId: world.id, assumptionsId: assumptions.id,
    graphRevision: revision, roots: rootIds, nodes: nodes.sort((a, b) => compareIdentity(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => compareIdentity(stableStringify(a), stableStringify(b))),
    byteRanges: [...ranges.values()].sort((a, b) => compareIdentity(stableStringify(a), stableStringify(b))),
    frontier, proofStatus: 'not-checked', graphClosed: frontier.length === 0 }, { maxBytes: MAX_SLICE_BYTES });
  let digest;
  try { digest = await bodyHash(body, work); work.checkpoint(); unchanged(); }
  catch (error) {
    const stopped = workStopStatus(error, work.signal);
    if (!stopped && error?.code !== 'certificate-stale') throw error;
    return deepFreeze({ status: stopped ?? 'stale', certificate: null, frontier: [{ kind: stopped ?? 'stale' }], cost: work.cost() });
  }
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: CERTIFICATE_SLICE_SCHEMA, identity: { bodyHash: digest, worldId: world.id, assumptionsId: assumptions.id } });
  return deepFreeze({ status: 'completed', certificate: { ...body, id, contentSha256: digest }, frontier, cost: work.cost() });
}

/** A host-controlled collection of small proposition checkers; never an RPC argument. */
export class CertificateCheckerRegistry {
  #checkers = new Map(); #revision = 0;
  get revision() { return this.#revision; }
  #advanceRevision() {
    if (this.#revision >= Number.MAX_SAFE_INTEGER) contractFail('certificate-checker-revision-exhausted');
    this.#revision++;
  }
  register({ id, version, semanticKind, check, level = 'derivation-checked', execution = 'host-call' }) {
    exactString(id, 'certificate-checker-id'); exactString(version, 'certificate-checker-version'); exactString(semanticKind, 'certificate-checker-kind');
    if (!['source-binding-checked', 'derivation-checked', 'independent-proof-checked'].includes(level)
      || !['host-call', 'local-bounded'].includes(execution) || typeof check !== 'function') contractFail('certificate-checker-contract');
    if (this.#checkers.has(semanticKind) || this.#checkers.size >= 256) contractFail('certificate-checker-duplicate-or-budget');
    const entry = Object.freeze({ id, version, semanticKind, level, execution, check });
    this.#advanceRevision(); this.#checkers.set(semanticKind, entry);
    return () => {
      if (this.#checkers.get(semanticKind) === entry) {
        this.#advanceRevision(); this.#checkers.delete(semanticKind);
      }
    };
  }
  descriptor(semanticKind) {
    const entry = this.#checkers.get(semanticKind);
    return entry ? Object.freeze({ id: entry.id, version: entry.version, semanticKind: entry.semanticKind, level: entry.level }) : null;
  }
  async check(node, context, work) {
    assertScopedAnalysisWork(work);
    const entry = this.#checkers.get(node.semanticKind);
    if (!entry) return { status: 'unsupported', reason: 'proposition-checker-unavailable' };
    // Only first-party bounded in-memory checks opt out of external-call
    // accounting. Work/deadline/cancellation and membership fences still apply.
    work.charge('workUnits');
    const result = await work.await((signal) => entry.check(node, { ...context, signal }), { chargeCall: entry.execution !== 'local-bounded' });
    if (this.#checkers.get(node.semanticKind) !== entry) return { status: 'unknown', reason: 'checker-unregistered-during-replay' };
    const bound = result?.worldId === context.world.id && result?.assumptionsId === context.assumptions.id
      && result?.nodeId === node.id && result?.propositionChecked === true;
    if (!bound || !['verified', 'rejected', 'unknown'].includes(result?.status)) return { status: 'unknown', reason: 'checker-result-unbound' };
    return { status: result.status, checker: this.descriptor(node.semanticKind), reason: result.reason ?? null,
      ...(result.detail == null ? {} : { detail: snapshotContractData(result.detail, { maxBytes: 8192, maxNodes: 256 }) }) };
  }
}

/** Integrity, byte binding and semantic replay are separate result axes. */
export async function replayEvidenceCertificate(input, { world, assumptions, work, readRange = null, resolveCanonicalNode = null, checkers = null, stopOnRejection = false, canonicalResolverExecution = 'host-call' } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  if (!['host-call', 'local-bounded'].includes(canonicalResolverExecution)) contractFail('certificate-resolver-execution');
  if (checkers !== null && !(checkers instanceof CertificateCheckerRegistry)) contractFail('certificate-checker-registry');
  const cert = snapshotContractData(input, { maxBytes: MAX_SLICE_BYTES });
  recordFields(cert, ['schema', 'worldId', 'assumptionsId', 'graphRevision', 'roots', 'nodes', 'edges', 'byteRanges', 'frontier', 'proofStatus', 'graphClosed', 'id', 'contentSha256'], 'certificate-fields');
  if (cert.schema !== CERTIFICATE_SLICE_SCHEMA || cert.worldId !== world.id || cert.assumptionsId !== assumptions.id) contractFail('certificate-binding');
  sha256Text(cert.contentSha256); exactString(cert.id, 'certificate-id');
  exactInteger(cert.graphRevision, 'certificate-graph-revision');
  const roots = stringSet(cert.roots, 'certificate-roots', 128);
  if (!roots.length || !Array.isArray(cert.nodes) || !Array.isArray(cert.edges) || !Array.isArray(cert.byteRanges) || !Array.isArray(cert.frontier)) contractFail('certificate-shape');
  if (cert.nodes.length > work.limits.nodes || cert.edges.length > work.limits.edges) contractFail('certificate-replay-budget');
  const { id, contentSha256, ...body } = cert;
  const checkerRevision = checkers instanceof CertificateCheckerRegistry ? checkers.revision : null;
  const assertCheckerMembership = () => {
    if (checkerRevision !== null && checkers.revision !== checkerRevision) contractFail('certificate-checker-membership-changed');
  };
  const rejected = [], unknown = [], nodeResults = [];
  let integrity = 'not-checked', status = 'completed', byteBinding = 'not-checked';
  try {
    const digest = await bodyHash(body, work);
    const expectedId = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: CERTIFICATE_SLICE_SCHEMA, identity: { bodyHash: digest, worldId: world.id, assumptionsId: assumptions.id } });
    if (digest !== contentSha256 || id !== expectedId) return deepFreeze({ schema: CERTIFICATE_REPLAY_SCHEMA, status: 'rejected', integrity: 'rejected', semantic: 'unknown', reason: 'certificate-content-mismatch', cost: work.cost() });
    integrity = 'verified';
    const nodes = new Map(), premiseEdges = new Set(), verifiedRanges = [];
    for (const inputNode of cert.nodes) {
      work.charge('nodes'); work.charge('workUnits');
      const node = createEvidenceNode(inputNode);
      if (nodes.has(node.id) || stableStringify(node) !== stableStringify(inputNode)) contractFail('certificate-node-noncanonical');
      if (node.binaryId !== null && !worldContains(world, node.binaryId)) contractFail('certificate-node-foreign-world');
      nodes.set(node.id, node);
      await work.yieldIfNeeded();
    }
    for (const root of roots) if (!nodes.has(root)) unknown.push({ id: root, reason: 'root-not-exported' });
    for (const edgeInput of cert.edges) {
      work.charge('edges'); work.charge('workUnits');
      const edge = createEvidenceEdge(edgeInput);
      if (stableStringify(edge) !== stableStringify(edgeInput)) contractFail('certificate-edge-noncanonical');
      if (edge.type === 'derived-from') premiseEdges.add(stableStringify([edge.from, edge.to]));
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) unknown.push({ id: edge.from, reason: 'edge-target-not-exported' });
    }
    let boundRanges = 0;
    for (const range of cert.byteRanges) {
      work.charge('workUnits');
      recordFields(range, ['binaryId', 'start', 'end', 'evidenceIds', 'sha256', 'hex'], 'certificate-range-fields');
      const binaryId = exactString(range.binaryId, 'certificate-range-binary');
      if (!worldContains(world, binaryId)) contractFail('certificate-range-foreign-world');
      const start = unsignedAddress(range.start), end = unsignedAddress(range.end, { allowEnd: true });
      const length = BigInt(end) - BigInt(start);
      if (length <= 0n) contractFail('certificate-range-empty-or-reversed');
      if (range.sha256 === null || typeof readRange !== 'function' || length > BigInt(MAX_RANGE_BYTES)) {
        unknown.push({ reason: 'byte-range-unverified', binaryId, start, end }); continue;
      }
      sha256Text(range.sha256);
      work.charge('bytesRead', Number(length)); work.charge('residentBytes', Number(length));
      const result = await work.await((signal) => readRange({ worldId: world.id, binaryId, offset: start, length: Number(length) }, { signal }));
      if (result?.worldId !== world.id || result?.binaryId !== binaryId || result?.offset !== start
        || !(result?.bytes instanceof Uint8Array) || result.bytes.length !== Number(length)) {
        rejected.push({ reason: 'byte-range-binding-mismatch', binaryId, start }); continue;
      }
      const boundBytes = result.bytes.slice();
      const digest = await sha256(boundBytes, work);
      if (digest !== range.sha256) rejected.push({ reason: 'byte-content-mismatch', binaryId, start });
      else if (range.hex !== undefined && range.hex !== [...boundBytes].map((n) => n.toString(16).padStart(2, '0')).join('')) rejected.push({ reason: 'embedded-byte-content-mismatch', binaryId, start });
      else {
        boundRanges++;
        work.charge('residentBytes', boundBytes.length);
        verifiedRanges.push({ binaryId, start, end, evidenceIds: new Set(stringSet(range.evidenceIds)), bytes: boundBytes });
      }
    }
    byteBinding = cert.byteRanges.length > 0 && boundRanges === cert.byteRanges.length ? 'verified' : 'partial';
    // A current-source contradiction is already decisive. A bounded consumer
    // may stop here rather than spend its remaining budget checking unrelated
    // nodes and lose the rejection before its quarantine fence runs.
    if (stopOnRejection === true && rejected.length) return deepFreeze({ schema: CERTIFICATE_REPLAY_SCHEMA,
      worldId: world.id, assumptionsId: assumptions.id, certificateId: cert.id, status: 'completed',
      integrity, byteBinding, semantic: 'rejected', nodeResults, rejected, unknown, cost: work.cost() });
    const topology = scheduleProofDag(nodes, cert.edges, { work }), checkedResults = new Map();
    // A cyclic SCC and every dependent are blocked before any checker runs.
    // Loop induction is an acyclic rule with independently checked initiation
    // and preservation, never an exception permitting evidence self-reference.
    for (const nodeId of topology.blocked) {
      const result = { nodeId, binding: 'unknown', status: 'rejected', reason: 'cyclic-derivation-dependency',
        checker: checkers?.descriptor(nodes.get(nodeId).semanticKind) ?? null };
      nodeResults.push(result); checkedResults.set(nodeId, result);
      rejected.push({ id: nodeId, reason: result.reason });
    }
    const orderedNodes = topology.order.map(id => nodes.get(id));
    for (const node of orderedNodes) {
      work.charge('workUnits');
      let binding = 'unknown';
      if (typeof resolveCanonicalNode === 'function') {
        const original = await work.await((signal) => resolveCanonicalNode(node.id, { world, assumptions, signal }), { chargeCall: canonicalResolverExecution !== 'local-bounded' });
        if (original?.worldId === world.id && stableStringify(original.node) === stableStringify(node)) binding = 'verified';
        else if (original?.worldId === world.id && original.node) binding = 'rejected';
      }
      const result = topology.missing.has(node.id)
        ? { status: 'unknown', reason: 'derivation-premise-not-exported', checker: checkers?.descriptor(node.semanticKind) ?? null }
        : checkers instanceof CertificateCheckerRegistry
        ? await checkers.check(node, { world, assumptions, certificate: cert, getNode: (id) => nodes.get(id) ?? null,
          hasPremise: (from, to) => premiseEdges.has(stableStringify([from, to])),
          getCheckedPremise: (from, to) => {
            work.charge('workUnits');
            if (!premiseEdges.has(stableStringify([from, to]))) return null;
            const checked = checkedResults.get(to);
            return checked?.binding === 'verified' && checked.status === 'verified' ? checked : null;
          },
          // A checker receives only exact ranges whose current bytes were read,
          // world-bound and hashed above. Embedded JSON bytes confer no authority.
          getVerifiedBytes: (evidenceId, binaryId, start, length) => {
            work.checkpoint();
            if (typeof start !== 'string' || !Number.isSafeInteger(length) || length < 1 || length > MAX_RANGE_BYTES) return null;
            const canonicalStart = unsignedAddress(start);
            for (const range of verifiedRanges) {
              work.charge('workUnits');
              if (range.binaryId === binaryId && range.start === canonicalStart && range.bytes.length === length && range.evidenceIds.has(evidenceId)) {
                work.charge('residentBytes', length); return range.bytes.slice();
              }
            }
            return null;
          } }, work)
        : { status: 'unsupported', reason: 'proposition-checker-unavailable' };
      assertCheckerMembership();
      const checked = { nodeId: node.id, binding, ...result };
      nodeResults.push(checked); checkedResults.set(node.id, checked);
      if (binding === 'rejected' || result.status === 'rejected') rejected.push({ id: node.id, reason: 'canonical-node-or-proposition-mismatch' });
      if (binding !== 'verified' || result.status !== 'verified') unknown.push({ id: node.id, reason: 'node-not-fully-replayed' });
      await work.yieldIfNeeded();
    }
    if (cert.frontier.length || cert.graphClosed !== true) unknown.push({ reason: 'certificate-has-open-frontier' });
  } catch (error) {
    const stopped = workStopStatus(error, work.signal);
    if (!stopped) throw error;
    status = stopped; unknown.push({ reason: stopped });
  }
  // Even all graph nodes matching current storage is not a semantic proof. All
  // roots need a semantic checker, no frontier, byte binding, and complete replay.
  assertCheckerMembership();
  const strongRoots = roots.every((root) => nodeResults.some((node) => node.nodeId === root && node.status === 'verified'
    && ['derivation-checked', 'independent-proof-checked'].includes(node.checker?.level)));
  const semantic = rejected.length ? 'rejected' : status === 'completed' && strongRoots && !unknown.length && byteBinding === 'verified' ? 'verified' : 'unknown';
  const checkedDerivations = nodeResults.filter(node => node.binding === 'verified' && node.status === 'verified'
    && ['derivation-checked', 'independent-proof-checked'].includes(node.checker?.level)).map(node => node.nodeId);
  const uncheckedDerivations = nodeResults.filter(node => (node.binding !== 'verified' || node.status !== 'verified')
    && ['derivation-checked', 'independent-proof-checked'].includes(node.checker?.level)).map(node => node.nodeId);
  const rejectedDerivations = nodeResults.filter(node => node.status === 'rejected'
    && ['derivation-checked', 'independent-proof-checked'].includes(node.checker?.level)).map(node => node.nodeId);
  const derivation = { status: rejectedDerivations.length ? 'rejected' : semantic === 'verified' ? 'checked'
    : checkedDerivations.length ? 'partially-checked' : uncheckedDerivations.length ? 'unknown' : 'unsupported',
    checkedNodeIds: checkedDerivations, uncheckedNodeIds: uncheckedDerivations, rejectedNodeIds: rejectedDerivations, rootsChecked: strongRoots,
    authority: 'per-node-scopes-only; not-whole-query-acceptance' };
  return deepFreeze({ schema: CERTIFICATE_REPLAY_SCHEMA, certificateId: id, worldId: world.id, assumptionsId: assumptions.id,
    status, integrity, byteBinding, semantic, derivation, nodeResults, rejected, unknown, cost: work.cost() });
}
