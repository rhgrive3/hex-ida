import { createPassResult } from './contract.js';
export * from './pass-validation-core.js';

const VALIDATED_REWRITE_METADATA = new WeakMap();
const STATUSES = new Set(['equivalent', 'refuted', 'unknown', 'unsupported']);
const LIMITS = Object.freeze({ maxDepth:64, maxNodes:16384, maxArrayLength:8192, maxObjectKeys:4096 });

function fail(code) { throw new TypeError(code); }
function nonEmpty(value, code) { if (typeof value !== 'string' || value.length === 0) fail(code); return value; }

function cloneOwned(value, state = { depth:0, nodes:0, active:new WeakSet() }) {
  state.nodes += 1;
  if (state.nodes > LIMITS.maxNodes || state.depth > LIMITS.maxDepth) fail('phase8-rewrite-metadata-limit');
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('phase8-rewrite-metadata-nonfinite-number'); return value; }
  if (typeof value === 'undefined') return undefined;
  if (typeof value !== 'object') fail('phase8-rewrite-metadata-unsupported-value');
  if (state.active.has(value)) fail('phase8-rewrite-metadata-cycle');
  state.active.add(value); state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (value.length > LIMITS.maxArrayLength) fail('phase8-rewrite-metadata-limit');
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !Object.hasOwn(d, 'value')) fail('phase8-rewrite-metadata-accessor');
        out.push(cloneOwned(d.value, state));
      }
      return Object.freeze(out);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail('phase8-rewrite-metadata-noncanonical-object');
    const keys = Reflect.ownKeys(value);
    if (keys.length > LIMITS.maxObjectKeys || keys.some((key) => typeof key !== 'string')) fail('phase8-rewrite-metadata-noncanonical-object');
    const out = {};
    for (const key of keys.sort()) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !Object.hasOwn(d, 'value')) fail('phase8-rewrite-metadata-accessor');
      out[key] = cloneOwned(d.value, state);
    }
    return Object.freeze(out);
  } finally { state.depth -= 1; state.active.delete(value); }
}

function validationRecord(value) {
  if (typeof value === 'string') {
    if (!STATUSES.has(value)) fail(`phase8-pass-transform-validation-unknown:${value}`);
    return Object.freeze({ validation:value });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('phase8-pass-transform-validation-invalid');
  const validation = nonEmpty(value.validation, 'phase8-pass-transform-validation-required');
  if (!STATUSES.has(validation)) fail(`phase8-pass-transform-validation-unknown:${validation}`);
  if (validation === 'equivalent') {
    return Object.freeze({
      validation,
      equivalenceProofId:nonEmpty(value.equivalenceProofId, 'phase8-pass-transform-validation-proof-required'),
      verifier:nonEmpty(value.verifier, 'phase8-pass-transform-validation-verifier-required'),
      verdictSource:value.verdictSource == null ? null : nonEmpty(value.verdictSource, 'phase8-pass-transform-validation-verdict-source-required'),
      solverStatus:value.solverStatus == null ? null : nonEmpty(value.solverStatus, 'phase8-pass-transform-validation-solver-status-required'),
      completeness:value.completeness == null ? null : cloneOwned(value.completeness),
      queryHash:nonEmpty(value.queryHash, 'phase8-pass-transform-validation-query-hash-required'),
    });
  }
  return Object.freeze({
    validation,
    reason:value.reason == null ? null : nonEmpty(value.reason, 'phase8-pass-transform-validation-reason-required'),
    verifier:value.verifier == null ? null : nonEmpty(value.verifier, 'phase8-pass-transform-validation-verifier-required'),
    solverStatus:value.solverStatus == null ? null : nonEmpty(value.solverStatus, 'phase8-pass-transform-validation-solver-status-required'),
    counterexample:value.counterexample == null ? null : cloneOwned(value.counterexample),
  });
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function createValidatedPassResult(input = {}) {
  const rawTransforms = input.transforms ?? [];
  if (!Array.isArray(rawTransforms)) fail('phase8-pass-transforms-invalid');
  const baseTransforms = [];
  const extras = [];
  for (const raw of rawTransforms) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('phase8-pass-transform-invalid');
    baseTransforms.push({ kind:raw.kind, targets:raw.targets, proof:raw.proof, originRefs:raw.originRefs });
    const extra = {};
    if (Object.hasOwn(raw, 'rewrite')) extra.rewrite = cloneOwned(raw.rewrite);
    if (Object.hasOwn(raw, 'unvalidatedReason')) extra.unvalidatedReason = nonEmpty(raw.unvalidatedReason, 'phase8-pass-transform-unvalidated-reason-required');
    if (Object.hasOwn(raw, 'validation')) extra.validation = validationRecord(raw.validation);
    extras.push(Object.freeze(extra));
  }
  const result = createPassResult({ ...input, transforms:baseTransforms });
  const entries = result.transforms.map((transform, index) => Object.freeze({
    base:Object.freeze({ kind:transform.kind, targets:transform.targets, proof:transform.proof, originRefs:transform.originRefs }),
    extra:extras[index],
  }));
  VALIDATED_REWRITE_METADATA.set(result, Object.freeze(entries));
  return result;
}

export function validatedRewriteMetadataFor(result) { return VALIDATED_REWRITE_METADATA.get(result) ?? null; }

export function attachValidatedRewriteMetadata(result, metadata) {
  if (!Array.isArray(metadata) || metadata.length !== result.transforms.length) fail('phase8-rewrite-metadata-mismatch');
  const transforms = result.transforms.map((transform, index) => {
    const entry = metadata[index];
    if (!entry || entry.base.kind !== transform.kind || entry.base.proof !== transform.proof
      || !sameList(entry.base.targets, transform.targets) || !sameList(entry.base.originRefs, transform.originRefs)) fail('phase8-rewrite-metadata-mismatch');
    return Object.freeze({ ...transform, ...entry.extra });
  });
  return Object.freeze({ ...result, transforms:Object.freeze(transforms) });
}
