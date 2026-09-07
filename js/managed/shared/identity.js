import { deepFreeze, stableStringify } from '../../core/identity/index.js';

function fail(code) { throw new TypeError(code); }
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function nonNegativeInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

// Token/name components explicitly accept numeric indices; parent identities do not.
function nameOrIndex(value, code) {
  return typeof value === 'number' ? String(nonNegativeInteger(value, code)) : nonEmpty(value, code);
}

export function createManagedImageId(binaryId, memberId = null) {
  const bin = nonEmpty(binaryId, 'managed-identity-binary-id-required');
  return memberId != null ? `managed-image:${bin}:${nonEmpty(memberId, 'managed-identity-member-id-required')}` : `managed-image:${bin}`;
}

export function createManagedModuleId(imageId, moduleNameOrIndex) {
  const img = nonEmpty(imageId, 'managed-identity-image-id-required');
  const mod = nameOrIndex(moduleNameOrIndex, 'managed-identity-module-id-required');
  return `managed-mod:${img}:${mod}`;
}

export function createManagedTypeId(moduleId, typeTokenOrName) {
  const mod = nonEmpty(moduleId, 'managed-identity-module-id-required');
  const typ = nameOrIndex(typeTokenOrName, 'managed-identity-type-id-required');
  return `managed-type:${mod}:${typ}`;
}

export function createManagedMethodId(typeIdOrModuleId, methodTokenOrIndex, signature = null) {
  const parent = nonEmpty(typeIdOrModuleId, 'managed-identity-parent-id-required');
  const meth = nameOrIndex(methodTokenOrIndex, 'managed-identity-method-id-required');
  return signature != null ? `managed-method:${parent}:${meth}:${nonEmpty(signature, 'managed-identity-signature-required')}` : `managed-method:${parent}:${meth}`;
}

export function createManagedFieldId(typeId, fieldTokenOrName) {
  const typ = nonEmpty(typeId, 'managed-identity-type-id-required');
  const fld = nameOrIndex(fieldTokenOrName, 'managed-identity-field-id-required');
  return `managed-field:${typ}:${fld}`;
}

export function createVMOperationId(methodId, bytecodeOffset, sequence = 0) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  const seq = nonNegativeInteger(sequence, 'managed-identity-sequence-required');
  return `vm-op:${meth}:0x${off.toString(16)}:${seq}`;
}

export function createVMValueId(methodId, opId, slotIndexOrName) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const op = nonEmpty(opId, 'managed-identity-op-id-required');
  const slot = nameOrIndex(slotIndexOrName, 'managed-identity-slot-required');
  return `vm-val:${meth}:${op}:${slot}`;
}

export function createVMFrameStateId(methodId, bytecodeOffset) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  return `vm-frame:${meth}:0x${off.toString(16)}`;
}

export function createManagedCallSiteId(methodId, bytecodeOffset, callIndex = 0) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const off = nonNegativeInteger(bytecodeOffset, 'managed-identity-offset-required');
  const idx = nonNegativeInteger(callIndex, 'managed-identity-call-index-required');
  return `managed-call:${meth}:0x${off.toString(16)}:${idx}`;
}

export function createManagedExceptionRegionId(methodId, handlerIndex) {
  const meth = nonEmpty(methodId, 'managed-identity-method-id-required');
  const idx = nonNegativeInteger(handlerIndex, 'managed-identity-handler-index-required');
  return `managed-exc:${meth}:${idx}`;
}

export function createManagedTargetProfileId(frontendId, formatVersion, vmSpecEdition) {
  const front = nonEmpty(frontendId, 'managed-identity-frontend-id-required');
  const fmt = nameOrIndex(formatVersion, 'managed-identity-format-version-required');
  const spec = nameOrIndex(vmSpecEdition, 'managed-identity-spec-edition-required');
  return `managed-profile:${front}:${fmt}:${spec}`;
}
