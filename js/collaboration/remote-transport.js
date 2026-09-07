import { stableStringify } from '../core/identity/index.js';
import { createRemoteCollaborationEnvelope } from './remote-authority.js';

export const REMOTE_CANONICAL_TRANSPORT_SCHEMA = 'hex-remote-canonical-transport/v1';
export const REMOTE_CANONICAL_RESPONSE_SCHEMA = 'hex-remote-canonical-transport-response/v1';
export const REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY = 'oracle:S2-P12-COLLAB-REMOTE:webcrypto-ed25519-aes-gcm-v1';

const textEncoder = new TextEncoder();
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_VERIFIED_BINDINGS = 256;
const DEFAULT_MAX_VERIFIED_BINDING_BYTES = 4 * 1024 * 1024;

function required(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}
function bytes(value, code) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(code);
}
function base64(value) {
  const data = bytes(value, 'remote-transport-bytes-required');
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value, code) {
  let binary;
  try { binary = atob(required(value, code)); } catch { throw new TypeError(code); }
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
  return output;
}
function hex(value) { return [...bytes(value, 'remote-transport-bytes-required')].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new TypeError('remote-transport-webcrypto-required');
  return value;
}
async function sha256(value) { return hex(await subtle().digest('SHA-256', bytes(value, 'remote-transport-digest-input-required'))); }

function declaredResponseLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readBoundedResponseText(response, maxBytes) {
  const declared = declaredResponseLength(response);
  if (declared != null && declared > maxBytes) throw new Error('remote-transport-response-budget-exceeded');
  if (typeof response.body?.getReader !== 'function') {
    const text = await response.text();
    if (textEncoder.encode(text).byteLength > maxBytes) throw new Error('remote-transport-response-budget-exceeded');
    return text;
  }
  const reader = response.body.getReader();
  const received = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : textEncoder.encode(String(value));
    total += chunk.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { }
      throw new Error('remote-transport-response-budget-exceeded');
    }
    received.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of received) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

async function readBoundedResponseJson(response, maxBytes) {
  const text = await readBoundedResponseText(response, maxBytes);
  try { return JSON.parse(text); } catch { throw new Error('remote-transport-response-json-invalid'); }
}

export function remoteCanonicalTransportBinding(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new TypeError('remote-transport-envelope-required');
  return Object.freeze({
    schemaVersion:REMOTE_CANONICAL_TRANSPORT_SCHEMA,
    envelopeSchemaVersion:envelope.schemaVersion,
    operationSchemaVersion:envelope.operationSchemaVersion,
    projectIdentity:envelope.projectIdentity,
    binaryIdentity:envelope.binaryIdentity ?? null,
    sessionIdentity:envelope.sessionIdentity,
    actorIdentity:envelope.actorIdentity,
    deviceIdentity:envelope.deviceIdentity,
    messageId:envelope.messageId,
    sequence:envelope.sequence,
    operations:envelope.operations,
    egress:envelope.egress,
  });
}

function signedResponsePayload(response) {
  return {
    schemaVersion:REMOTE_CANONICAL_RESPONSE_SCHEMA,
    requestId:required(response.requestId, 'remote-transport-response-request-id-required'),
    bindingDigest:required(response.bindingDigest, 'remote-transport-response-binding-digest-required'),
    keyId:required(response.keyId, 'remote-transport-response-key-id-required'),
  };
}

export class RemoteCanonicalHttpTransport {
  #verifiedBindings = new Map();
  #verifiedBindingBytes = 0;
  #maxVerifiedBindings;
  #maxVerifiedBindingBytes;
  #disposed = false;

  constructor({
    endpoint,
    serverVerificationKey,
    sessionEncryptionKey,
    serverKeyId,
    fetchImpl = globalThis.fetch,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxVerifiedBindings = DEFAULT_MAX_VERIFIED_BINDINGS,
    maxVerifiedBindingBytes = DEFAULT_MAX_VERIFIED_BINDING_BYTES,
  } = {}) {
    this.endpoint = required(endpoint, 'remote-transport-endpoint-required');
    if (!/^https:\/\//i.test(this.endpoint) && !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$)/i.test(this.endpoint)) {
      throw new TypeError('remote-transport-confidential-endpoint-required');
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError('remote-transport-response-budget-invalid');
    if (!Number.isSafeInteger(maxVerifiedBindings) || maxVerifiedBindings < 1) throw new TypeError('remote-transport-proof-cache-count-invalid');
    if (!Number.isSafeInteger(maxVerifiedBindingBytes) || maxVerifiedBindingBytes < 1) throw new TypeError('remote-transport-proof-cache-bytes-invalid');
    if (!serverVerificationKey || serverVerificationKey.type !== 'public' || serverVerificationKey.algorithm?.name !== 'Ed25519') throw new TypeError('remote-transport-ed25519-key-required');
    if (!sessionEncryptionKey || sessionEncryptionKey.type !== 'secret' || sessionEncryptionKey.algorithm?.name !== 'AES-GCM') throw new TypeError('remote-transport-aes-gcm-key-required');
    if (typeof fetchImpl !== 'function') throw new TypeError('remote-transport-fetch-required');
    this.serverVerificationKey = serverVerificationKey;
    this.sessionEncryptionKey = sessionEncryptionKey;
    this.serverKeyId = required(serverKeyId, 'remote-transport-server-key-id-required');
    this.fetchImpl = fetchImpl;
    this.maxResponseBytes = maxResponseBytes;
    this.#maxVerifiedBindings = maxVerifiedBindings;
    this.#maxVerifiedBindingBytes = maxVerifiedBindingBytes;
    this.verifierIdentity = REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY;
    this.verifyTransportProof = (proof, envelope) => {
      if (this.#disposed
        || proof?.authenticated !== true
        || proof?.confidentiality !== 'verified'
        || proof?.integrity !== 'verified') return false;
      const proofIdentity = String(proof?.proofIdentity || '');
      const entry = this.#verifiedBindings.get(proofIdentity);
      if (!entry || entry.binding !== stableStringify(remoteCanonicalTransportBinding(envelope))) return false;
      this.#verifiedBindings.delete(proofIdentity);
      this.#verifiedBindings.set(proofIdentity, entry);
      return true;
    };
  }

  #rememberVerifiedBinding(proofIdentity, canonicalBinding) {
    const retainedBytes = textEncoder.encode(proofIdentity).byteLength + textEncoder.encode(canonicalBinding).byteLength;
    if (retainedBytes > this.#maxVerifiedBindingBytes) throw new Error('remote-transport-proof-binding-budget-exceeded');
    const previous = this.#verifiedBindings.get(proofIdentity);
    if (previous) {
      this.#verifiedBindingBytes -= previous.bytes;
      this.#verifiedBindings.delete(proofIdentity);
    }
    this.#verifiedBindings.set(proofIdentity, { binding:canonicalBinding, bytes:retainedBytes });
    this.#verifiedBindingBytes += retainedBytes;
    while (this.#verifiedBindings.size > this.#maxVerifiedBindings || this.#verifiedBindingBytes > this.#maxVerifiedBindingBytes) {
      const oldest = this.#verifiedBindings.entries().next().value;
      if (!oldest) break;
      this.#verifiedBindings.delete(oldest[0]);
      this.#verifiedBindingBytes -= oldest[1].bytes;
    }
  }

  dispose() {
    this.#disposed = true;
    this.#verifiedBindings.clear();
    this.#verifiedBindingBytes = 0;
  }

  async authorizeEnvelope(input = {}) {
    if (this.#disposed) throw new Error('remote-transport-disposed');
    const provisional = createRemoteCollaborationEnvelope({ ...input, transportProof:{ authenticated:false, confidentiality:'unverified', integrity:'unverified' } });
    if (provisional.egress?.userAuthorized !== true) throw new Error('remote-transport-egress-authorization-required');
    if (provisional.egress?.rawBinaryBytes === true) throw new Error('remote-transport-raw-binary-egress-forbidden');
    if (provisional.egress?.derivedDataOnly !== true) throw new Error('remote-transport-derived-data-only-required');
    const binding = remoteCanonicalTransportBinding(provisional);
    const canonicalBinding = stableStringify(binding);
    const plaintext = textEncoder.encode(canonicalBinding);
    const bindingDigest = await sha256(plaintext);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const aad = textEncoder.encode(`${REMOTE_CANONICAL_TRANSPORT_SCHEMA}:${this.serverKeyId}`);
    const ciphertext = new Uint8Array(await subtle().encrypt({ name:'AES-GCM', iv, additionalData:aad, tagLength:128 }, this.sessionEncryptionKey, plaintext));
    const requestId = `remote-request:${await sha256(ciphertext)}`;
    const response = await this.fetchImpl(this.endpoint, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ schemaVersion:REMOTE_CANONICAL_TRANSPORT_SCHEMA, requestId, bindingDigest, keyId:this.serverKeyId, iv:base64(iv), ciphertext:base64(ciphertext) }),
    });
    if (!response || response.ok !== true) throw new Error(`remote-transport-http-rejected:${response?.status ?? 'unavailable'}`);
    const result = await readBoundedResponseJson(response, this.maxResponseBytes);
    if (result?.schemaVersion !== REMOTE_CANONICAL_RESPONSE_SCHEMA) throw new Error('remote-transport-response-schema-invalid');
    const signed = signedResponsePayload(result);
    if (signed.requestId !== requestId || signed.bindingDigest !== bindingDigest || signed.keyId !== this.serverKeyId) throw new Error('remote-transport-response-identity-mismatch');
    const signature = fromBase64(result.signature, 'remote-transport-response-signature-invalid');
    const verified = await subtle().verify({ name:'Ed25519' }, this.serverVerificationKey, signature, textEncoder.encode(stableStringify(signed)));
    if (!verified) throw new Error('remote-transport-response-signature-rejected');
    if (this.#disposed) throw new Error('remote-transport-disposed');
    const proofIdentity = `remote-transport-proof:${await sha256(textEncoder.encode(`${stableStringify(signed)}:${base64(signature)}`))}`;
    if (this.#disposed) throw new Error('remote-transport-disposed');
    this.#rememberVerifiedBinding(proofIdentity, canonicalBinding);
    return createRemoteCollaborationEnvelope({
      ...input,
      transportProof:{ authenticated:true, confidentiality:'verified', integrity:'verified', proofIdentity },
    });
  }

  async send(envelope) {
    if (!this.verifyTransportProof(envelope?.transportProof, envelope)) throw new Error('remote-transport-unverified-envelope');
    return Object.freeze({ status:'verified-and-authorized-for-channel-send', envelopeId:envelope.envelopeId });
  }
}
