import { deepFreeze, jsonSafe } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const MANAGED_VALIDATION_STATUS = Object.freeze(['valid', 'invalid', 'partial', 'unsupported']);
const STATUS_SET = new Set(MANAGED_VALIDATION_STATUS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

export function createManagedValidationReport(input) {
  input = object(input, 'managed-validation-report-invalid');
  const targetId = nonEmpty(input.targetId ?? input.methodId ?? input.moduleId, 'managed-validation-target-id-required');
  const profileId = input.profileId == null ? null : nonEmpty(input.profileId, 'managed-validation-profile-id-invalid');
  const status = input.status === undefined ? 'valid' : nonEmpty(input.status, 'managed-validation-status-required');
  if (!STATUS_SET.has(status)) fail('managed-validation-invalid-status');

  const errors = array(input.errors ?? [], 'managed-validation-invalid-errors');
  const warnings = array(input.warnings ?? [], 'managed-validation-invalid-warnings');
  const verifierFacts = array(input.verifierFacts ?? [], 'managed-validation-invalid-facts');

  const completeness = {
    structural: input.completeness?.structural ?? (status === 'invalid' ? 'partial' : 'complete'),
    specValidation: input.completeness?.specValidation ?? (status === 'invalid' ? 'failed' : 'valid'),
    semanticEffect: input.completeness?.semanticEffect ?? 'complete',
    resolution: input.completeness?.resolution ?? 'complete',
  };

  return deepFreeze({
    // Validation report identity binds what was validated to the validation
    // context: target + profile + status. Reports that differ in profile or
    // outcome are different validation facts and must never share an id
    // (#5294).
    id: `val-rep:${targetId}:${profileId ?? '-'}:${status}`,
    targetId,
    profileId,
    status,
    completeness: deepFreeze(completeness),
    errors: deepFreeze(errors.map((e) => jsonSafe(e))),
    warnings: deepFreeze(warnings.map((w) => jsonSafe(w))),
    verifierFacts: deepFreeze(verifierFacts.map((f) => jsonSafe(f))),
    origin: createOriginSet(input.origin ?? { parentEntityIds: [targetId] }),
  });
}

export function validateManagedValidationReport(report) {
  if (!report || typeof report !== 'object') fail('managed-validation-report-invalid');
  const validTargetId = typeof report.targetId === 'string' && Boolean(report.targetId.trim());
  const validStatus = typeof report.status === 'string' && STATUS_SET.has(report.status);
  const validProfileId = report.profileId == null
    || (typeof report.profileId === 'string' && Boolean(report.profileId.trim()));
  if (!validTargetId || !validStatus || !validProfileId) fail('managed-validation-report-incomplete');
  return true;
}
