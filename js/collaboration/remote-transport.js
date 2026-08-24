import { stableStringify } from '../core/identity/index.js';
import { createRemoteCollaborationEnvelope } from './remote-authority.js';

export const REMOTE_CANONICAL_TRANSPORT_SCHEMA = 'hex-remote-canonical-transport/v1';
export const REMOTE_CANONICAL_RESPONSE_SCHEMA = 'hex-remote-canonical-transport-response/v1';
export const REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY = 'oracle:S2-P12-COLLAB-REMOTE:webcrypto-ed25519-aes-gcm-v1';

const textEncoder = new TextEncoder();

function required(value, code) {
  const text = String(value ?? '').trim();
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
  constructor({ endpoint, serverVerificationKey, sessionEncryptionKey, serverKeyId, fetchImpl = globalThis.fetch } = {}) {
    this.endpoint = required(endpoint, 'remote-transport-endpoint-required');
    if (!/^https:\/\//i.test(this.endpoint) && !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$)/i.test(this.endpoint)) {
      throw new TypeError('remote-transport-confidential-endpoint-required');
    }
    if (!serverVerificationKey || serverVerificationKey.type !== 'public' || serverVerificationKey.algorithm?.name !== 'Ed25519') throw new TypeError('remote-transport-ed25519-key-required');
    if (!sessionEncryptionKey || sessionEncryptionKey.type !== 'secret' || sessionEncryptionKey.algorithm?.name !== 'AES-GCM') throw new TypeError('remote-transport-aes-gcm-key-required');
    if (typeof fetchImpl !== 'function') throw new TypeError('remote-transport-fetch-required');
    this.serverVerificationKey = serverVerificationKey;
    this.sessionEncryptionKey = sessionEncryptionKey;
    this.serverKeyId = required(serverKeyId, 'remote-transport-server-key-id-required');
    this.fetchImpl = fetchImpl;
    this.verifierIdentity = REMOTE_CANONICAL_TRANSPORT_VERIFIER_IDENTITY;
    this.verifyTransportProof = (proof, envelope) => {
      const proofIdentity = String(proof?.proofIdentity || '');
      return proof?.authenticated === true
        && proof?.confidentiality === 'verified'
        && proof?.integrity === 'verified'
        && this.#verifiedBindings.get(proofIdentity) === stableStringify(remoteCanonicalTransportBinding(envelope));
    };
  }

  async authorizeEnvelope(input = {}) {
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
    const result = await response.json();
    if (result?.schemaVersion !== REMOTE_CANONICAL_RESPONSE_SCHEMA) throw new Error('remote-transport-response-schema-invalid');
    const signed = signedResponsePayload(result);
    if (signed.requestId !== requestId || signed.bindingDigest !== bindingDigest || signed.keyId !== this.serverKeyId) throw new Error('remote-transport-response-identity-mismatch');
    const signature = fromBase64(result.signature, 'remote-transport-response-signature-invalid');
    const verified = await subtle().verify({ name:'Ed25519' }, this.serverVerificationKey, signature, textEncoder.encode(stableStringify(signed)));
    if (!verified) throw new Error('remote-transport-response-signature-rejected');
    const proofIdentity = `remote-transport-proof:${await sha256(textEncoder.encode(`${stableStringify(signed)}:${base64(signature)}`))}`;
    this.#verifiedBindings.set(proofIdentity, canonicalBinding);
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
