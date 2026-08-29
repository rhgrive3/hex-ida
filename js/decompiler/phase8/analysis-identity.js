/**
 * Canonical identity for Phase 8 analysis products.
 *
 * A scalar artifact is only useful for the exact Semantic IR/SSA snapshot that
 * produced it.  This module owns the small identity boundary shared by SCCP,
 * GVN and induction; consumers do not invent a second stale-result check.
 */

import { stableDigest } from '../../core/identity/index.js';

const REQUIRED_FIELDS = Object.freeze([
  'binaryId', 'functionId', 'snapshotId', 'semanticIrId', 'ssaId', 'analyzerVersion',
]);

function token(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (value == null) return null;
  try {
    return `id:${stableDigest(value)}`;
  } catch {
    return null;
  }
}

function valueShape(value) {
  if (value == null || typeof value !== 'object') return value ?? null;
  const definition = value.def;
  return {
    id: token(value.id),
    bits: value.bits ?? null,
    kind: value.kind ?? null,
    constant: value.const ?? null,
    definition: definition == null ? null : {
      op: definition.op ?? null,
      sub: definition.sub ?? null,
      block: definition.block ?? null,
      args: Array.isArray(definition.args)
        ? definition.args.map((argument) => token(argument?.value?.id ?? argument?.id)).sort()
        : [],
    },
  };
}

function irShape(ir) {
  if (ir == null || typeof ir !== 'object') return null;
  try {
    return {
      entry: token(ir.entry),
      origin: Array.isArray(ir.origin?.instructionIds) ? [...ir.origin.instructionIds].sort() : null,
      blocks: Array.isArray(ir.blocks) ? ir.blocks.map((block) => ({
        id: token(block?.id),
        index: block?.index ?? null,
        successors: Array.isArray(block?.succ) ? block.succ.map(token).sort() : [],
      })).sort((left, right) => String(left.index).localeCompare(String(right.index))) : [],
      values: Array.isArray(ir.values) ? ir.values.map(valueShape).sort((left, right) => String(left.id).localeCompare(String(right.id))) : [],
    };
  } catch {
    return null;
  }
}

function sourceIdentity(context, ir) {
  const candidates = [
    context?.analysisIdentity,
    context?.identity,
    context?.artifactIdentity,
    ir?.analysisIdentity,
    ir?.identity,
  ];
  return candidates.find((candidate) => candidate != null) ?? null;
}

function explicitlyMissingIdentity(context, ir) {
  return [context, ir].some((source) => ['analysisIdentity', 'identity', 'artifactIdentity'].some((key) => Object.hasOwn(source ?? {}, key)
    && source[key] == null));
}

function field(candidate, ...names) {
  for (const name of names) {
    const value = token(candidate?.[name]);
    if (value != null) return value;
  }
  return null;
}

function sameKnownSourceFields(identity, source) {
  if (source == null || typeof source !== 'object' || Array.isArray(source)) return true;
  for (const name of REQUIRED_FIELDS) {
    const observed = field(source, name, name === 'semanticIrId' ? 'semanticIRId' : name);
    if (observed != null && observed !== identity[name]) return false;
  }
  return true;
}

export function isValidatedAnalysisIdentity(identity) {
  if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) return false;
  return REQUIRED_FIELDS.every((name) => typeof identity[name] === 'string' && identity[name].trim().length > 0);
}

export function analysisIdentityMatches(observed, expected) {
  if (!isValidatedAnalysisIdentity(observed) || !isValidatedAnalysisIdentity(expected)) return false;
  return REQUIRED_FIELDS.every((name) => observed[name] === expected[name]);
}

/**
 * Resolve a validated identity from canonical IR metadata.  Existing fixtures
 * often carry no binary loader IDs, so the fallback is a deterministic digest
 * of the IR shape, never a wall-clock or architecture-name guess.
 */
export function canonicalAnalysisIdentity(context = {}) {
  const seededCfg = context?.analysis?.get?.('cfg') ?? null;
  const seededSsa = context?.analysis?.get?.('ssa') ?? null;
  const seededOrigins = context?.analysis?.get?.('origins') ?? null;
  const ir = context?.ir ?? (seededCfg != null || seededSsa != null ? {
    blocks: seededCfg?.blocks ?? [],
    entry: seededCfg?.entry ?? null,
    values: seededSsa?.values ?? [],
    origin: seededOrigins?.functionOrigin ?? null,
  } : null);
  // The vertical resolves this once against the canonical IR and passes the
  // result through its private context.  Recomputing the full shape digest in
  // SCCP, GVN and induction is needlessly expensive on the corpus hot path;
  // only accept the cache when it is tied to the exact same IR object.
  const cached = context?.__phase8CanonicalIdentity;
  if (cached?.ir != null && cached.ir === ir && cached.result != null) return cached.result;
  const source = sourceIdentity(context, ir);
  if (explicitlyMissingIdentity(context, ir)) return { identity: null, valid: false, reason: 'analysis identity is null' };
  if (source != null && (typeof source !== 'object' || Array.isArray(source))) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const shape = irShape(ir);
  if (shape == null) return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' };
  const shapeDigest = stableDigest(shape);
  const functionId = field(source, 'functionId') ?? field(ir, 'functionId') ?? `function:${shapeDigest}`;
  const binaryId = field(source, 'binaryId') ?? field(ir, 'binaryId') ?? `binary:${stableDigest({ functionId, shapeDigest })}`;
  const snapshotId = field(source, 'snapshotId') ?? field(ir, 'snapshotId') ?? `snapshot:${stableDigest({ binaryId, functionId, shapeDigest })}`;
  const semanticIrId = field(source, 'semanticIrId', 'semanticIRId') ?? field(ir, 'semanticIrId', 'semanticIRId')
    ?? `semantic-ir:${stableDigest({ snapshotId, functionId, shapeDigest })}`;
  const ssaId = field(source, 'ssaId') ?? field(ir, 'ssaId')
    ?? `ssa:${stableDigest({ semanticIrId, values: shape.values })}`;
  const analyzerVersion = field(source, 'analyzerVersion', 'semanticSchemaVersion')
    ?? field(ir, 'analyzerVersion', 'semanticSchemaVersion') ?? 'phase8-analysis-v1';
  const identity = Object.freeze({ binaryId, functionId, snapshotId, semanticIrId, ssaId, analyzerVersion });
  if (!isValidatedAnalysisIdentity(identity)) return { identity: null, valid: false, reason: 'analysis identity fields are invalid' };
  if (!sameKnownSourceFields(identity, source) || !sameKnownSourceFields(identity, ir?.analysisIdentity ?? ir?.identity)) {
    return { identity: null, valid: false, reason: 'analysis identity is stale for the Semantic IR' };
  }
  return { identity, valid: true, reason: null };
}

export { REQUIRED_FIELDS as ANALYSIS_IDENTITY_FIELDS };
