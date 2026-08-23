import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { PatchSet } from '../patch.js';

export const REBUILD_PLAN_VERSION = 'hex-rebuild-plan-v1';
export const REBUILD_LEVELS = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);

function required(value, code) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(code); return text; }
function explicitBigInt(value, code) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new TypeError(code); return BigInt(value); }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && value.trim()) return BigInt(value);
  throw new TypeError(code);
}
function bytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); if (Array.isArray(value)) return Uint8Array.from(value); throw new TypeError('rebuild-bytes-required'); }
function hashBytes(value) { return `bytes:${stableDigest(Array.from(bytes(value)))}`; }
function clone(value) { if (typeof structuredClone === 'function') return structuredClone(value); if (Array.isArray(value)) return value.map(clone); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])); return value; }
function sortedStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function impactValidators(impact) {
  const validators = new Set(['source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence']);
  if (impact?.layoutMoving) validators.add('layout');
  if (impact?.relocations) validators.add('relocations');
  if (impact?.branchRanges) validators.add('branch-ranges');
  if (impact?.unwind) validators.add('unwind');
  if (impact?.importsExports) validators.add('imports-exports');
  if (impact?.signature) validators.add('signature-consequence');
  return [...validators].sort();
}

export function createRebuildPlan(input = {}) {
  const binaryId = required(input.binaryId, 'rebuild-binary-id-required');
  const sourceHash = required(input.sourceHash, 'rebuild-source-hash-required');
  const loaderVersion = required(input.loaderVersion || 'n/a', 'rebuild-loader-version-required');
  if (!Array.isArray(input.operations)) throw new TypeError('rebuild-operations-required');
  const operations = input.operations.map((operation) => {
    const offset = explicitBigInt(operation.offset ?? operation.fileOffset, 'rebuild-operation-offset-invalid');
    const before = bytes(operation.before || []), after = bytes(operation.after || []);
    if (offset < 0n || !before.length || before.length !== after.length) throw new TypeError('rebuild-operation-same-size-precondition-required');
    return { id: String(operation.id || `operation:${stableDigest({ offset: offset.toString(), before: Array.from(before), after: Array.from(after) })}`), offset: offset.toString(), before: Array.from(before), after: Array.from(after), address: operation.address == null ? null : String(operation.address), provenance: clone(operation.provenance || { source: 'local-patch' }) };
  }).sort((a, b) => BigInt(a.offset) < BigInt(b.offset) ? -1 : BigInt(a.offset) > BigInt(b.offset) ? 1 : a.id.localeCompare(b.id));
  for (let i = 1; i < operations.length; i++) { const previous = operations[i - 1], current = operations[i]; if (BigInt(current.offset) < BigInt(previous.offset) + BigInt(previous.before.length)) throw new TypeError('rebuild-overlapping-operations'); }
  const impact = { sourceRanges: clone(input.impact?.sourceRanges || operations.map((operation) => ({ offset: operation.offset, length: operation.before.length }))), sections: clone(input.impact?.sections || []), layoutMoving: input.impact?.layoutMoving === true, relocations: input.impact?.relocations === true, branchRanges: input.impact?.branchRanges === true, unwind: input.impact?.unwind === true, importsExports: input.impact?.importsExports === true, signature: input.impact?.signature === true };
  const plan = { schemaVersion: REBUILD_PLAN_VERSION, planId: null, binaryId, sourceHash, loaderVersion, operations, expectedOriginalState: clone(input.expectedOriginalState || { sourceHash }), layoutEffects: clone(input.layoutEffects || { sizeChange: false }), relocationEffects: clone(input.relocationEffects || {}), branchRangeEffects: clone(input.branchRangeEffects || {}), unwindEffects: clone(input.unwindEffects || {}), signatureEffects: clone(input.signatureEffects || {}), impact, unresolvedRisks: sortedStrings(input.unresolvedRisks), requiredValidators: impactValidators(impact), authority: 'L3-explicit-proposal', publication: 'not-published' };
  plan.planId = `rebuild-plan:${stableDigest(plan)}`;
  return deepFreeze(plan);
}

export function adaptPatchSetToRebuildPlan(patchSet, input = {}) {
  if (!(patchSet instanceof PatchSet) && !patchSet?.list) throw new TypeError('PatchSet required');
  const operations = patchSet.list().map((item) => ({ id: `patch:${item.offset.toString()}`, offset: item.offset, before: item.before, after: item.after, address: item.addr, provenance: { source: 'PatchSet' } }));
  return createRebuildPlan({ ...input, operations });
}

async function sourceBytes(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return bytes(source);
}

export async function materializeRebuildPlan(plan, source, options = {}) {
  if (!plan || plan.schemaVersion !== REBUILD_PLAN_VERSION) throw new TypeError('rebuild-plan-schema-invalid');
  const original = await sourceBytes(source);
  if (options.signal?.aborted) return { status: 'cancelled', reason: 'cancelled-before-materialization', planId: plan.planId };
  if (plan.sourceHash && plan.sourceHash !== hashBytes(original) && options.allowSourceHashMismatch !== true) return { status: 'rejected', reason: 'source-identity-mismatch', planId: plan.planId, expected: plan.sourceHash, observed: hashBytes(original) };
  const output = original.slice();
  const touched = [];
  for (const operation of plan.operations) {
    if (options.signal?.aborted) return { status: 'cancelled', reason: 'cancelled-during-materialization', planId: plan.planId };
    const offset = Number(BigInt(operation.offset));
    const before = Uint8Array.from(operation.before), after = Uint8Array.from(operation.after);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + before.length > original.length) return { status: 'rejected', reason: 'operation-out-of-range', operationId: operation.id, planId: plan.planId };
    for (let i = 0; i < before.length; i++) if (original[offset + i] !== before[i]) return { status: 'rejected', reason: 'expected-original-state-mismatch', operationId: operation.id, planId: plan.planId };
    output.set(after, offset); touched.push({ offset, length: after.length });
  }
  return { status: 'materialized', planId: plan.planId, sourceHash: hashBytes(original), outputHash: hashBytes(output), bytes: output, touched, temporary: true, publication: 'not-published' };
}

function unchangedRegions(original, output, touched) {
  const ranges = [...touched].sort((a, b) => a.offset - b.offset); let cursor = 0;
  for (const range of ranges) { for (let i = cursor; i < range.offset; i++) if (original[i] !== output[i]) return false; cursor = range.offset + range.length; }
  for (let i = cursor; i < original.length; i++) if (original[i] !== output[i]) return false;
  return true;
}

function validatorResult(validator, status, reason = null) {
  return { validator, status, ...(reason ? { reason } : {}) };
}

async function runValidatorOracle(name, output, plan, materialized, options) {
  const oracle = options.validators?.[name];
  if (typeof oracle !== 'function') return validatorResult(name, 'unavailable', 'validator-oracle-unavailable');
  try {
    const result = await oracle(output, { plan, materialized });
    if (result === true || result?.ok === true || result?.status === 'passed' || result?.status === 'valid') return validatorResult(name, 'passed');
    return validatorResult(name, 'failed', result?.reason || 'validator-rejected-output');
  } catch (error) {
    return validatorResult(name, 'failed', error?.message || String(error));
  }
}

export async function validateRebuildOutput(plan, materialized, options = {}) {
  if (!materialized || materialized.status !== 'materialized') return { status: 'invalid', reason: 'materialization-not-complete', planId: plan?.planId || null };
  const output = materialized.bytes;
  const required = Array.isArray(plan?.requiredValidators) ? plan.requiredValidators : [];
  const results = new Map();

  const sourcePreconditionPassed = materialized.planId === plan.planId
    && typeof materialized.sourceHash === 'string'
    && materialized.sourceHash === plan.sourceHash;
  results.set('source-precondition', validatorResult('source-precondition', sourcePreconditionPassed ? 'passed' : 'failed', sourcePreconditionPassed ? null : 'materialized-source-precondition-unproven'));

  let structurePassed = false;
  try {
    const outputBytes = bytes(output);
    const touched = Array.isArray(materialized.touched) ? materialized.touched : null;
    structurePassed = !!touched && hashBytes(outputBytes) === materialized.outputHash
      && touched.every((range) => Number.isSafeInteger(range?.offset) && Number.isSafeInteger(range?.length) && range.offset >= 0 && range.length >= 0 && range.offset <= outputBytes.length && range.length <= outputBytes.length - range.offset);
  } catch {}
  results.set('structure', validatorResult('structure', structurePassed ? 'passed' : 'failed', structurePassed ? null : 'materialized-structure-invalid'));

  if (options.original != null) {
    try {
      const original = await sourceBytes(options.original);
      const passed = unchangedRegions(original, output, materialized.touched || []);
      results.set('unchanged-regions', validatorResult('unchanged-regions', passed ? 'passed' : 'failed', passed ? null : 'promised-unchanged-region-differed'));
    } catch (error) {
      results.set('unchanged-regions', validatorResult('unchanged-regions', 'failed', error?.message || String(error)));
    }
  } else {
    results.set('unchanged-regions', validatorResult('unchanged-regions', 'unavailable', 'original-source-unavailable'));
  }

  if (typeof options.loaderReparse === 'function') {
    try {
      const result = await options.loaderReparse(output);
      const passed = result?.status !== 'unsupported' && result?.ok !== false;
      results.set('loader-reparse', validatorResult('loader-reparse', passed ? 'passed' : 'failed', passed ? null : (result?.reason || 'loader-rejected-output')));
    } catch (error) {
      results.set('loader-reparse', validatorResult('loader-reparse', 'failed', error?.message || String(error)));
    }
  } else {
    results.set('loader-reparse', validatorResult('loader-reparse', 'unavailable', 'loader-reparse-oracle-unavailable'));
  }

  for (const validator of required) {
    if (results.has(validator)) continue;
    results.set(validator, await runValidatorOracle(validator, output, plan, materialized, options));
  }

  let independentDifferential = 'unavailable';
  if (typeof options.independentOracle === 'function') {
    try {
      const result = await options.independentOracle(output);
      independentDifferential = result?.ok === false || result?.status === 'rejected' ? 'failed' : 'executed';
      if (independentDifferential === 'failed') results.set('independent-differential', validatorResult('independent-differential', 'failed', result?.reason || 'independent-oracle-rejected-output'));
    } catch (error) {
      independentDifferential = 'failed';
      results.set('independent-differential', validatorResult('independent-differential', 'failed', error?.message || String(error)));
    }
  }

  const validators = required.map((validator) => results.get(validator) || validatorResult(validator, 'unavailable', 'validator-not-run'));
  const failures = validators.filter((entry) => entry.status !== 'passed').map((entry) => ({ validator: entry.validator, reason: entry.reason || `validator-${entry.status}` }));
  const valid = validators.length === required.length && validators.every((entry) => entry.status === 'passed');
  return {
    status: valid ? 'valid' : 'invalid',
    planId: plan.planId,
    outputHash: materialized.outputHash,
    validators,
    failures,
    signatureConsequences: { status: plan.impact.signature ? 'changed-or-unknown' : 'unchanged-by-declared-operation' },
    independentDifferential,
  };
}

export async function publishRebuildOutput(materialized, validation, options = {}) {
  if (!materialized || materialized.status !== 'materialized') return { status: 'rejected', reason: 'materialization-not-complete' };
  if (!validation || validation.status !== 'valid') return { status: 'rejected', reason: 'validation-not-green' };
  if (typeof options.promote !== 'function') return { status: 'not-published', reason: 'explicit-promotion-required', outputHash: materialized.outputHash };
  const promoted = await options.promote(materialized.bytes, validation);
  return { status: 'published', outputHash: materialized.outputHash, result: promoted };
}

export function rebuildSupportTruth({ format, operation, architecture, relocationClass, validatorCoverage, proof } = {}) {
  const dimensions = { format: format || null, operation: operation || null, architecture: architecture || null, relocationClass: relocationClass || null, validatorCoverage: validatorCoverage || [] };
  const proven = proof?.exactHead === true && proof?.loaderReparse === true && proof?.preconditions === true && proof?.evidence === true;
  return Object.freeze({ ...dimensions, status: proven ? 'supported-for-exact-profile' : 'unsupported', partial: !proven, authority: 'L3-plan-only' });
}
