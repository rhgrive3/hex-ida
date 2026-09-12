import { createEvidenceNode, EvidenceGraph } from './index.js';
import { createOriginSet } from '../identity/origin.js';

/* #5277: family authority reads only primitive-string provenance. Template
   interpolation laundered structured (Array/Object/boolean/number) source
   fields into canonical family tokens; malformed provenance must fall back to
   the default family instead. */
function familyToken(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function familyFor(record = {}) {
  const text = `${familyToken(record.sourceTool || record.source)} ${familyToken(record.kind)}`;
  if (text.includes('runtime') || record.source === 'runtime') return 'RuntimeEvidence';
  if (text.includes('symbolic') || text.includes('solver')) return 'SymbolicEvidence';
  if (text.includes('signature') || text.includes('fingerprint')) return 'SignatureEvidence';
  if (text.includes('type')) return 'TypeEvidence';
  if (text.includes('cfg') || text.includes('branch') || text.includes('control')) return 'ControlFlowEvidence';
  if (text.includes('dataflow') || text.includes('alias') || text.includes('reaching')) return 'DataflowEvidence';
  if (text.includes('decode') || text.includes('instruction')) return 'DecodeEvidence';
  if (text.includes('knowledge') || text.includes('external')) return 'KnowledgeEvidence';
  if (text.includes('binary') || text.includes('loader')) return 'BinaryEvidence';
  return 'SemanticEvidence';
}

function targetIds(record = {}) {
  return [record.entityId, record.functionId, record.instructionId].filter((value) => value != null);
}

export function legacyAiEvidenceToCanonical(record = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('evidence-compat-invalid-ai-record');
  return createEvidenceNode({
    id: record.id ?? '',
    family: familyFor(record),
    binaryId: record.binaryId ?? record.binaryHash ?? null,
    targetEntityIds: targetIds(record),
    semanticKind: record.kind ?? 'legacy-ai-evidence',
    completeness: record.completeness ?? 'partial',
    confidence: Number.isFinite(record.confidence) ? record.confidence : null,
    deterministic: record.status === 'verified',
    origin: createOriginSet({
      instructionIds: record.instructionId == null ? [] : [record.instructionId],
      parentEntityIds: targetIds(record),
    }),
    payload: {
      legacySystem: 'ai-evidence-store',
      kind: record.kind ?? null,
      status: record.status ?? 'unknown',
      title: record.title ?? null,
      sourceTool: record.sourceTool ?? null,
      sourceId: record.sourceId ?? null,
      sourceRef: record.sourceRef ?? null,
      sourceBinding: record.sourceBinding ?? null,
      address: record.address ?? null,
      functionAddress: record.functionAddress ?? null,
      functionName: record.functionName ?? null,
      summary: record.summary ?? null,
      navigation: record.navigation ?? null,
      sourceData: record.sourceData ?? null,
      entityId: record.entityId ?? null,
      functionId: record.functionId ?? null,
      instructionId: record.instructionId ?? null,
      binaryId: record.binaryId ?? null,
      binaryHash: record.binaryHash ?? null,
    },
    createdAt: record.timestamp ?? null,
  });
}

export function runtimeEvidenceToCanonical(record = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('evidence-compat-invalid-runtime-record');
  return createEvidenceNode({
    id: record.id ?? '',
    family: 'RuntimeEvidence',
    binaryId: record.binaryId ?? record.binaryHash ?? null,
    targetEntityIds: targetIds(record),
    semanticKind: record.kind ?? 'runtime-observation',
    completeness: record.completeness ?? (record.observationComplete === false ? 'truncated' : 'partial'),
    confidence: Number.isFinite(record.confidence) ? record.confidence : null,
    deterministic: false,
    origin: createOriginSet({ parentEntityIds: targetIds(record) }),
    payload: {
      legacySystem: 'runtime-evidence',
      verdict: record.verdict ?? 'unknown',
      backend: record.backend ?? null,
      binaryHash: record.binaryHash ?? null,
      sliceIdentity: record.sliceIdentity ?? null,
      function: record.function ?? null,
      address: record.address ?? null,
      input: record.input ?? null,
      initialState: record.initialState ?? null,
      observedState: record.observedState ?? null,
      branchPath: record.branchPath ?? [],
      sessionId: record.sessionId ?? null,
      reproducibility: record.reproducibility ?? null,
      provenance: record.provenance ?? null,
    },
    createdAt: record.timestamp ?? null,
  });
}

export function evidenceStoreToCanonicalGraph(store) {
  const records = store && typeof store.all === 'function' ? store.all() : [];
  return new EvidenceGraph({ nodes: records.map(legacyAiEvidenceToCanonical) });
}

export function legacyEvidenceToCanonicalGraph({ aiEvidence = [], runtimeEvidence = [] } = {}) {
  const graph = new EvidenceGraph();
  for (const record of aiEvidence) graph.addNode(legacyAiEvidenceToCanonical(record));
  for (const record of runtimeEvidence) graph.addNode(runtimeEvidenceToCanonical(record));
  return graph;
}

export function canonicalEvidenceToLegacyAi(node) {
  const canonical = createEvidenceNode(node);
  if (canonical.family === 'Claim') throw new TypeError('evidence-compat-claim-not-ai-record');
  const payload = canonical.payload || {};
  // Canonical deterministic authority owns the verified boundary. Legacy payload
  // status may preserve weaker labels, but must never mint or suppress it.
  const payloadStatus = ['verified', 'supported', 'hypothesis', 'unknown'].includes(payload.status)
    ? payload.status
    : null;
  const status = canonical.deterministic === true
    ? 'verified'
    : (payloadStatus === 'verified' ? 'supported' : (payloadStatus ?? 'supported'));

  const out = {
    id: canonical.id,
    kind: payload.kind ?? canonical.semanticKind ?? 'observation',
    status,
    title: payload.title ?? canonical.semanticKind ?? canonical.family,
    sourceTool: payload.sourceTool ?? 'core-evidence',
  };

  if (payload.sourceId != null) out.sourceId = payload.sourceId;
  if (payload.sourceRef != null) out.sourceRef = payload.sourceRef;
  if (payload.sourceBinding != null) out.sourceBinding = payload.sourceBinding;
  if (payload.address != null) out.address = payload.address;
  if (payload.functionAddress != null) out.functionAddress = payload.functionAddress;
  if (payload.functionName != null) out.functionName = payload.functionName;
  if (payload.summary != null) out.summary = payload.summary;
  if (payload.sourceData != null) out.sourceData = payload.sourceData;
  if (payload.navigation != null) out.navigation = payload.navigation;
  if (payload.entityId != null) out.entityId = payload.entityId;
  if (payload.functionId != null) out.functionId = payload.functionId;
  if (payload.instructionId != null) out.instructionId = payload.instructionId;
  // Canonical binary binding is authoritative at the node level. A legacy
  // record may duplicate binaryId/binaryHash in its payload, but a canonical
  // node created through the core API carries only the top-level field —
  // dropping it would lose the binary scope on conversion (#5782).
  if (canonical.binaryId != null) out.binaryId = canonical.binaryId;
  else if (payload.binaryId != null) out.binaryId = payload.binaryId;
  if (payload.binaryHash != null) out.binaryHash = payload.binaryHash;
  if (canonical.completeness != null) out.completeness = canonical.completeness;
  if (canonical.confidence != null) out.confidence = canonical.confidence;
  if (canonical.createdAt != null) out.timestamp = canonical.createdAt;

  return out;
}
