import { DebugAdapterError } from "../debug/adapter.js";

function canonicalIdentity(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasProvenRuntimeStaticIdentity(module) {
  const identityEvidenceIds = module?.identityEvidenceIds;
  const hasCanonicalIdentityEvidence = Array.isArray(identityEvidenceIds) &&
    identityEvidenceIds.length > 0 &&
    identityEvidenceIds.every((id) => typeof id === "string" && id.trim().length > 0);
  const binaryId = module?.binaryId;
  const sliceId = module?.sliceId;
  const imageId = module?.imageId;
  const identityState = module?.identityState;
  const hasCanonicalStaticIdentity = canonicalIdentity(binaryId) &&
    (sliceId == null || canonicalIdentity(sliceId)) &&
    (imageId == null || canonicalIdentity(imageId));
  return hasCanonicalStaticIdentity && (
    identityState === "exact" ||
    identityState === "resolved" ||
    hasCanonicalIdentityEvidence
  );
}

export function normalizeRuntimeModuleBinding(module, { bindingKey: explicitKey, loadedSequence } = {}) {
  const rawKey = explicitKey ?? module?.bindingKey ?? module?.key;
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) {
    throw new DebugAdapterError("runtime-invalid-module-binding-key", "runtime module binding key is required");
  }

  const runtimeBase = module?.runtimeBase ?? module?.base;
  const runtimeSize = module?.runtimeSize ?? module?.size;
  const staticBase = module?.staticBase ?? module?.imageBase ?? null;
  const pathHint = module?.pathHint ?? module?.path ?? module?.name ?? null;
  const buildIdentity = module?.buildIdentity ?? module?.uuid ?? null;

  const identityRead = {
    binaryId: module?.binaryId,
    sliceId: module?.sliceId,
    imageId: module?.imageId,
    identityState: module?.identityState,
    identityEvidenceIds: module?.identityEvidenceIds,
  };
  const identityEvidenceIds = Object.freeze(Array.isArray(identityRead.identityEvidenceIds)
    ? [...identityRead.identityEvidenceIds]
    : []);

  const trusted = hasProvenRuntimeStaticIdentity(identityRead);
  const binaryId = trusted ? (identityRead.binaryId ?? null) : null;
  const sliceId = trusted ? (identityRead.sliceId ?? null) : null;
  const imageId = trusted ? (identityRead.imageId ?? null) : null;
  const identityState = trusted ? (identityRead.identityState ?? "resolved") : "unresolved";

  const result = {
    bindingKey: key,
    runtimeBase,
    runtimeSize,
    staticBase,
    pathHint,
    binaryId,
    sliceId,
    imageId,
    buildIdentity,
    identityState,
    identityEvidenceIds,
  };
  if (loadedSequence !== undefined) {
    result.loadedSequence = loadedSequence;
  }
  return Object.freeze(result);
}
