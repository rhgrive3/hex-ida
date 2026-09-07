import { stableDigest } from '../core/identity/index.js';

function required(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}

function colonFree(value) { return !value.includes(':'); }

function legacyProjectIdentity(value) {
  const parts = value.split(':');
  return parts.length === 3 && parts[0] === 'hex-project' && parts.slice(1).every(Boolean);
}

function legacyHash(value) {
  const parts = value.split(':');
  return (parts.length === 1 || parts.length === 2) && parts.every(Boolean);
}

function legacyBinaryIdentity(value) {
  const parts = value.split(':');
  if (parts[0] !== 'hex-binary') return false;
  let offset = 1;
  if (parts[offset] === 'hex-project') {
    if (!parts[offset + 1] || !parts[offset + 2]) return false;
    offset += 3;
  } else {
    if (!parts[offset]) return false;
    offset += 1;
  }
  const tail = parts.slice(offset);
  return (tail.length === 3 || tail.length === 4) && tail.every(Boolean);
}

function stableIdentity(prefix, parts, legacySafe = parts.every(colonFree)) {
  // Preserve only legacy tuples whose field boundaries remain unambiguous.
  // Anything else moves to a versioned length-framed representation.
  if (legacySafe) return `${prefix}:${parts.join(':')}`;
  const framed = parts.map((part) => `${part.length}:${part}`).join('');
  return `${prefix}:v2:${framed}`;
}

export function createProjectIdentity(input = {}) {
  const projectId = required(input.projectId ?? input.id, 'phase12-project-id-required');
  const binaryKey = required(input.binaryId ?? input.binaryKey, 'phase12-project-binary-id-required');
  return stableIdentity('hex-project', [projectId, binaryKey]);
}

export function createBinaryIdentity(input = {}) {
  const projectId = required(input.projectId, 'phase12-binary-project-id-required');
  const contentHash = required(input.contentHash ?? input.binaryHash, 'phase12-binary-content-hash-required');
  const format = required(input.format, 'phase12-binary-format-required');
  const architecture = required(input.architecture, 'phase12-binary-architecture-required');
  const legacySafe = (colonFree(projectId) || legacyProjectIdentity(projectId))
    && legacyHash(contentHash)
    && colonFree(format)
    && colonFree(architecture);
  return stableIdentity('hex-binary', [projectId, contentHash, format, architecture], legacySafe);
}

export function createEntityIdentity(input = {}) {
  const binaryId = required(input.binaryId, 'phase12-entity-binary-id-required');
  const kind = required(input.kind, 'phase12-entity-kind-required');
  const stableKey = required(input.stableKey ?? input.key, 'phase12-entity-stable-key-required');
  const legacySafe = (colonFree(binaryId) || legacyBinaryIdentity(binaryId))
    && colonFree(kind)
    && colonFree(stableKey);
  return stableIdentity('hex-entity', [binaryId, kind, stableKey], legacySafe);
}

export function createOperationIdentity(input = {}) {
  const projectId = required(input.projectId, 'phase12-operation-project-id-required');
  const operationId = required(input.operationId, 'phase12-operation-id-required');
  const legacySafe = (colonFree(projectId) || legacyProjectIdentity(projectId)) && colonFree(operationId);
  return stableIdentity('hex-operation', [projectId, operationId], legacySafe);
}

export function identityDigest(value) { return stableDigest(value); }

export function assertIdentityMatch(actual, expected, code = 'phase12-identity-mismatch') {
  if (String(actual ?? '') !== String(expected ?? '')) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return true;
}
