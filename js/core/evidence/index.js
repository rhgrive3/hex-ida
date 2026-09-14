import { deepFreeze, jsonSafe, stableStringify } from '../identity/index.js';
import { createOriginSet } from '../identity/origin.js';

export const EVIDENCE_NODE_FAMILIES = Object.freeze([
  'BinaryEvidence',
  'DecodeEvidence',
  'SemanticEvidence',
  'DataflowEvidence',
  'TypeEvidence',
  'ControlFlowEvidence',
  'SignatureEvidence',
  'KnowledgeEvidence',
  'SymbolicEvidence',
  'RuntimeEvidence',
  'UserEvidence',
  'Claim',
]);

export const EVIDENCE_EDGE_FAMILIES = Object.freeze([
  'derived-from',
  'supports',
  'contradicts',
  'refines',
  'observed-at',
  'originates-from',
  'verified-by',
  'matched-by',
  'supersedes',
]);

export const EVIDENCE_VERDICTS = Object.freeze([
  'confirmed',
  'supported',
  'unverified',
  'contradicted',
  'unknown',
]);

export const EVIDENCE_COMPLETENESS = Object.freeze([
  'complete',
  'bounded',
  'partial',
  'truncated',
  'unsupported',
]);

function fail(code) { throw new TypeError(code); }
function required(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function optionalString(value, code) {
  if (value == null) return null;
  if (typeof value !== 'string') fail(code);
  return value;
}
function stringArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string') fail(code);
    const text = item.trim();
    if (!text) fail(code);
    normalized.push(text);
  }
  return [...new Set(normalized)].sort();
}
function safeArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return value;
}
function numericPrimitive(value, code) {
  if (typeof value !== 'number' && typeof value !== 'string') fail(code);
  if (typeof value === 'string' && !value.trim()) fail(code);
  const n = Number(value);
  if (!Number.isFinite(n)) fail(code);
  return n;
}
function confidence(value) {
  if (value == null) return null;
  const n = numericPrimitive(value, 'evidence-invalid-confidence');
  if (n < 0 || n > 1) fail('evidence-invalid-confidence');
  return n;
}
function enumValue(value, allowed, fallback, code) {
  if (value != null && typeof value !== 'string') fail(code);
  const normalized = value == null ? fallback : value;
  if (!allowed.includes(normalized)) fail(code);
  return normalized;
}

export function createEvidenceNode(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-node');
  const family = enumValue(input.family, EVIDENCE_NODE_FAMILIES, null, 'evidence-invalid-family');
  if (family === 'Claim') return createClaimNode(input);
  const node = {
    id: required(input.id, 'evidence-id-required'),
    family,
    binaryId: input.binaryId == null ? null : required(input.binaryId, 'evidence-invalid-binary-id'),
    targetEntityIds: stringArray(input.targetEntityIds, 'evidence-invalid-targets'),
    semanticKind: optionalString(input.semanticKind, 'evidence-invalid-semantic-kind'),
    completeness: enumValue(input.completeness, EVIDENCE_COMPLETENESS, 'partial', 'evidence-invalid-completeness'),
    confidence: confidence(input.confidence),
    deterministic: input.deterministic === true,
    origin: createOriginSet(input.origin ?? {}),
    payload: jsonSafe(input.payload ?? {}),
    createdAt: optionalString(input.createdAt, 'evidence-invalid-created-at'),
  };
  return deepFreeze(node);
}

export function createClaimNode(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-claim');
  const supportingEvidenceIds = stringArray(input.supportingEvidenceIds, 'evidence-invalid-support-ids');
  const contradictingEvidenceIds = stringArray(input.contradictingEvidenceIds, 'evidence-invalid-contradiction-ids');
  const confirmedByEvidenceIds = stringArray(input.confirmedByEvidenceIds, 'evidence-invalid-confirmation-ids');
  const requestedVerdict = enumValue(input.verdict, EVIDENCE_VERDICTS, 'unknown', 'evidence-invalid-verdict');
  let verdict = requestedVerdict;
  if (contradictingEvidenceIds.length || requestedVerdict === 'contradicted') verdict = 'contradicted';
  else if (requestedVerdict === 'confirmed') verdict = supportingEvidenceIds.length || confirmedByEvidenceIds.length ? 'supported' : 'unverified';
  else if (requestedVerdict === 'supported' && !supportingEvidenceIds.length) verdict = 'unverified';
  const targetEntityIds = stringArray(input.targetEntityIds, 'evidence-invalid-targets');
  const scope = input.scope == null ? null : jsonSafe(input.scope);
  if (!targetEntityIds.length && scope == null) fail('evidence-claim-target-required');
  const semanticKind = required(input.semanticKind, 'evidence-claim-semantic-kind-required');
  return deepFreeze({
    id: required(input.id, 'evidence-id-required'),
    family: 'Claim',
    binaryId: input.binaryId == null ? null : required(input.binaryId, 'evidence-invalid-binary-id'),
    targetEntityIds,
    scope,
    semanticKind,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    confirmedByEvidenceIds,
    assumptions: jsonSafe(safeArray(input.assumptions, 'evidence-invalid-assumptions')),
    completeness: enumValue(input.completeness, EVIDENCE_COMPLETENESS, 'partial', 'evidence-invalid-completeness'),
    verdict,
    confidence: confidence(input.confidence),
    origin: createOriginSet(input.origin ?? {}),
    payload: jsonSafe(input.payload ?? {}),
    createdAt: optionalString(input.createdAt, 'evidence-invalid-created-at'),
  });
}

export function createEvidenceEdge(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('evidence-invalid-edge');
  return deepFreeze({
    type: enumValue(input.type, EVIDENCE_EDGE_FAMILIES, null, 'evidence-invalid-edge-family'),
    from: required(input.from, 'evidence-edge-from-required'),
    to: required(input.to, 'evidence-edge-to-required'),
    metadata: jsonSafe(input.metadata ?? {}),
  });
}

function equalValue(a, b) { return stableStringify(a) === stableStringify(b); }

export function isEvidenceApplicableToClaim(evidence, claim) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (!claim || typeof claim !== 'object') return false;
  if (evidence.binaryId != null && claim.binaryId != null && evidence.binaryId !== claim.binaryId) return false;
  if (claim.scope != null) {
    const evidenceScope = evidence.scope !== undefined ? evidence.scope : evidence.payload?.scope;
    if (evidenceScope == null || !equalValue(evidenceScope, claim.scope)) return false;
  }
  const claimTargets = Array.isArray(claim.targetEntityIds) ? claim.targetEntityIds : [];
  if (claimTargets.length) {
    const evidenceTargets = Array.isArray(evidence.targetEntityIds) ? evidence.targetEntityIds : [];
    if (!evidenceTargets.length) return true;
    return evidenceTargets.some((id) => claimTargets.includes(id));
  }
  return true;
}

export function canConfirmClaim(evidence, claim) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (evidence.deterministic !== true) return false;
  if (evidence.completeness === 'unsupported' || evidence.completeness === 'truncated' || evidence.completeness === 'partial') {
    return false;
  }
  if (!isEvidenceApplicableToClaim(evidence, claim)) return false;
  return true;
}

export class EvidenceGraph {
  #nodes = new Map();
  #edges = [];
  #edgeKeys = new Set();
  #revision = 0;
  #outgoingIndex = null;
  #incomingIndex = null;
  #maxNodes = 500_000;
  #maxEdges = 1_000_000;

  constructor(initial = {}, { maxNodes = 500_000, maxEdges = 1_000_000, signal = null } = {}) {
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) fail('evidence-invalid-graph');
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) fail('evidence-invalid-max-nodes');
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) fail('evidence-invalid-max-edges');
    this.#maxNodes = maxNodes;
    this.#maxEdges = maxEdges;
    const nodes = safeArray(initial.nodes, 'evidence-invalid-nodes');
    const edges = safeArray(initial.edges, 'evidence-invalid-edges');
    for (let i = 0; i < nodes.length; i++) {
      if (i % 1000 === 0 && signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      this.addNode(nodes[i]);
    }
    for (let i = 0; i < edges.length; i++) {
      if (i % 1000 === 0 && signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      this.addEdge(edges[i]);
    }
  }

  addNode(input) {
    const node = createEvidenceNode(input);
    if (this.#nodes.size >= this.#maxNodes && !this.#nodes.has(node.id)) {
      fail('evidence-graph-node-budget-exceeded');
    }
    const existing = this.#nodes.get(node.id);
    if (existing) {
      if (!equalValue(existing, node)) fail('evidence-id-conflict');
      return existing;
    }
    this.#nodes.set(node.id, node);
    this.#revision++;
    return node;
  }

  addEdge(input) {
    const edge = createEvidenceEdge(input);
    const key = stableStringify(edge);
    if (!this.#edgeKeys.has(key)) {
      if (this.#edges.length >= this.#maxEdges) fail('evidence-graph-edge-budget-exceeded');
      this.#edgeKeys.add(key);
      const edgeIndex = this.#edges.length;
      this.#edges.push(edge);
      if (this.#outgoingIndex) {
        this.#indexEdge(this.#outgoingIndex, edge.from, edgeIndex);
        this.#indexEdge(this.#incomingIndex, edge.to, edgeIndex);
      }
      this.#revision++;
    }
    return edge;
  }

  get revision() { return this.#revision; }
  get nodeCount() { return this.#nodes.size; }
  get edgeCount() { return this.#edges.length; }

  #indexEdge(index, id, position) {
    const positions = index.get(id);
    if (positions) positions.push(position);
    else index.set(id, [position]);
  }

  /** Optional disposable index, inside the canonical EvidenceGraph owner. */
  async prepareEdgeIndex(work, { maxEdges = 262144 } = {}) {
    if (!work || typeof work.charge !== 'function' || typeof work.yieldIfNeeded !== 'function') fail('evidence-index-work-required');
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 0 || maxEdges > 1000000) fail('evidence-index-budget-invalid');
    work.checkpoint();
    if (this.#outgoingIndex) return Object.freeze({ status:'ready', revision:this.#revision });
    if (this.#edges.length > maxEdges) return Object.freeze({ status:'unsupported', reason:'evidence-index-edge-budget' });
    const revision = this.#revision;
    const outgoing = new Map(), incoming = new Map();
    for (let index = 0; index < this.#edges.length; index++) {
      work.charge('workUnits'); work.charge('residentBytes', 96);
      const edge = this.#edges[index];
      this.#indexEdge(outgoing, edge.from, index); this.#indexEdge(incoming, edge.to, index);
      await work.yieldIfNeeded();
      if (revision !== this.#revision) return Object.freeze({ status:'stale', reason:'evidence-graph-mutated' });
    }
    work.checkpoint();
    if (revision !== this.#revision) return Object.freeze({ status:'stale', reason:'evidence-graph-mutated' });
    this.#outgoingIndex = outgoing; this.#incomingIndex = incoming;
    return Object.freeze({ status:'ready', revision });
  }

  /**
   * Cursor offset refers to the reported mode (global edge array or adjacency).
   * Filtering has a scan cap: an empty page with nextOffset is NOT absence.
   */
  edgePage(id, { direction = 'outgoing', offset = 0, limit = 256, maxScanned = 4096,
    types = null, expectedRevision = null, mode = null, signal = null } = {}) {
    const nodeId = required(id, 'evidence-id-required');
    if (!['outgoing', 'incoming'].includes(direction)) fail('evidence-page-direction');
    for (const [name, value, maximum] of [['offset', offset, Number.MAX_SAFE_INTEGER], ['limit', limit, 4096], ['max-scanned', maxScanned, 65536]]) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (name === 'offset' ? 0 : 1) || value > maximum) fail(`evidence-page-${name}`);
    }
    if (expectedRevision !== null && expectedRevision !== this.#revision) return Object.freeze({ status:'stale', revision:this.#revision, edges:[], nextOffset:null, scanned:0, complete:false });
    let filter = null;
    if (types !== null) {
      if (!Array.isArray(types) || types.length > EVIDENCE_EDGE_FAMILIES.length || types.some((type) => !EVIDENCE_EDGE_FAMILIES.includes(type))) fail('evidence-page-types');
      filter = new Set(types);
    }
    const index = direction === 'outgoing' ? this.#outgoingIndex : this.#incomingIndex;
    const selectedMode = mode ?? (index ? 'adjacency' : 'linear');
    if (!['linear', 'adjacency'].includes(selectedMode) || (selectedMode === 'adjacency' && !index)) fail('evidence-page-index-mode');
    const positions = selectedMode === 'adjacency' ? index.get(nodeId) ?? [] : null;
    const length = positions ? positions.length : this.#edges.length;
    if (offset > length) fail('evidence-page-offset-out-of-range');
    const edges = [];
    let cursor = offset, scanned = 0;
    while (cursor < length && edges.length < limit && scanned < maxScanned) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const edge = this.#edges[positions ? positions[cursor] : cursor]; cursor++; scanned++;
      if ((direction === 'outgoing' ? edge.from : edge.to) !== nodeId || (filter && !filter.has(edge.type))) continue;
      edges.push(edge);
    }
    return Object.freeze({ status:'ready', revision:this.#revision, mode:selectedMode, edges:Object.freeze(edges),
      nextOffset:cursor < length ? cursor : null, scanned, complete:cursor >= length });
  }

  discardEdgeIndex() { this.#outgoingIndex = null; this.#incomingIndex = null; }

  getNode(id) { return this.#nodes.get(required(id, 'evidence-id-required')) || null; }
  hasNode(id) { return this.#nodes.has(required(id, 'evidence-id-required')); }
  allNodes() { return Array.from(this.#nodes.values()); }
  allEdges() { return this.#edges.slice(); }

  unresolvedReferences() {
    const missing = new Set();
    for (const edge of this.#edges) {
      if (!this.#nodes.has(edge.from)) missing.add(edge.from);
      if (!this.#nodes.has(edge.to)) missing.add(edge.to);
    }
    for (const node of this.#nodes.values()) {
      if (node.family !== 'Claim') continue;
      for (const id of [...node.supportingEvidenceIds, ...node.contradictingEvidenceIds, ...node.confirmedByEvidenceIds]) {
        if (!this.#nodes.has(id)) missing.add(id);
      }
    }
    return Array.from(missing).sort();
  }

  evaluateClaim(id) {
    const claimId = required(id, 'evidence-id-required');
    const claim = this.getNode(claimId);
    if (!claim || claim.family !== 'Claim') {
      return deepFreeze({ verdict: 'unknown', claimId, supportingEvidenceIds: [], contradictingEvidenceIds: [], confirmedByEvidenceIds: [], missingEvidenceIds: [claimId] });
    }
    const supporting = new Set(claim.supportingEvidenceIds);
    const contradicting = new Set(claim.contradictingEvidenceIds);
    const confirmedBy = new Set(claim.confirmedByEvidenceIds);
    const relevantEdges = this.#outgoingIndex
      ? (this.#outgoingIndex.get(claim.id) ?? []).map((index) => this.#edges[index]) : this.#edges;
    for (const edge of relevantEdges) {
      if (edge.from !== claim.id) continue;
      if (edge.type === 'supports') supporting.add(edge.to);
      else if (edge.type === 'contradicts') contradicting.add(edge.to);
      else if (edge.type === 'verified-by') confirmedBy.add(edge.to);
    }
    const missingEvidenceIds = new Set();
    for (const evidenceId of [...supporting, ...contradicting, ...confirmedBy]) {
      if (!this.#nodes.has(evidenceId)) missingEvidenceIds.add(evidenceId);
    }
    const existingContradictionIds = [...contradicting].filter((evidenceId) => this.#nodes.has(evidenceId));
    const knownContradictions = existingContradictionIds.filter((evidenceId) => {
      const node = this.#nodes.get(evidenceId);
      return node && isEvidenceApplicableToClaim(node, claim);
    });
    const knownSupport = [...supporting].filter((evidenceId) => {
      const node = this.#nodes.get(evidenceId);
      return node && isEvidenceApplicableToClaim(node, claim);
    });
    const deterministicConfirmations = [...confirmedBy].filter((evidenceId) => {
      const node = this.#nodes.get(evidenceId);
      return canConfirmClaim(node, claim);
    });
    let verdict = claim.verdict;
    if (knownContradictions.length) verdict = 'contradicted';
    else if (deterministicConfirmations.length) verdict = 'confirmed';
    else if (knownSupport.length) verdict = 'supported';
    else if (supporting.size || confirmedBy.size || claim.verdict === 'unverified') verdict = 'unverified';
    else verdict = 'unknown';
    return deepFreeze({
      verdict,
      claimId: claim.id,
      supportingEvidenceIds: Array.from(supporting).sort(),
      contradictingEvidenceIds: Array.from(contradicting).sort(),
      confirmedByEvidenceIds: Array.from(confirmedBy).sort(),
      missingEvidenceIds: Array.from(missingEvidenceIds).sort(),
      completeness: claim.completeness,
    });
  }

  toJSON() {
    return {
      schemaVersion: 1,
      nodes: this.allNodes().map((node) => jsonSafe(node)),
      edges: this.allEdges().map((edge) => jsonSafe(edge)),
    };
  }

  static fromJSON(value, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('evidence-invalid-graph');
    if (value.schemaVersion != null && numericPrimitive(value.schemaVersion, 'evidence-schema-mismatch') !== 1) fail('evidence-schema-mismatch');
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) fail('evidence-invalid-graph');
    return new EvidenceGraph({ nodes: value.nodes, edges: value.edges }, options);
  }
}
