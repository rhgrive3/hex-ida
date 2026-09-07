import {
  ARTIFACT_STORE_VERSION,
  ArtifactCorruptionError,
  assertCanonicalArtifactDescriptor,
  createArtifactRecord,
  decodeArtifactPayload,
  encodeArtifactPayload,
} from './contracts.js';
import { ArtifactHotCache } from './hot-cache.js';
import { createArtifactBackend } from './backends.js';
import {
  artifactHotEntrySize,
  canonicalStoredRecord,
  normalizeStoredPayloadBytes,
  validateStoredArtifact,
} from './storage/integrity.js';

const INCOMPATIBLE_CODES = new Set([
  'artifact-record-schema-mismatch',
  'artifact-contract-version-mismatch',
  'artifact-payload-encoding-unsupported',
  'artifact-producer-version-mismatch',
  'artifact-semantic-schema-mismatch',
  'artifact-id-mismatch',
  'artifact-record-identity-mismatch',
  'artifact-storage-envelope-schema-mismatch',
]);
const UPSTREAM_VALID = 'valid';
const UPSTREAM_INVALID = 'invalid';
const UPSTREAM_BUDGET_EXHAUSTED = 'budget-exhausted';

function aborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbort(error, signal) {
  return error?.name === 'AbortError' || !!signal?.aborted;
}

function requireArtifactId(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('artifact-id-required');
  return value;
}

function snapshotCallableHooks(target, names, errorCode) {
  if (target == null) throw new TypeError(errorCode);
  const hooks = Object.create(null);
  try {
    for (const name of names) {
      const hook = target[name];
      if (typeof hook !== 'function') throw new TypeError(errorCode);
      hooks[name] = (...args) => Reflect.apply(hook, target, args);
    }
  } catch {
    throw new TypeError(errorCode);
  }
  return Object.freeze(hooks);
}

export class ArtifactStore {
  #backendHooks;
  #hotCacheHooks;

  constructor({ backend = createArtifactBackend(), hotCache = new ArtifactHotCache(), corruptionPolicy = 'delete' } = {}) {
    const backendHooks = snapshotCallableHooks(backend, ['getRaw', 'putAtomic', 'delete', 'capabilities', 'close'], 'artifact-backend-invalid');
    const hotCacheHooks = snapshotCallableHooks(hotCache, ['get', 'put', 'delete', 'clear', 'stats'], 'artifact-hot-cache-invalid');
    if (!['delete', 'retain'].includes(corruptionPolicy)) throw new TypeError('artifact-corruption-policy-invalid');
    this.backend = backend;
    this.hotCache = hotCache;
    this.#backendHooks = backendHooks;
    this.#hotCacheHooks = hotCacheHooks;
    this.corruptionPolicy = corruptionPolicy;
    this.mutations = new Map();
    this.epochs = new Map();
    this.metrics = {
      requests:0,
      reads:0,
      hotHits:0,
      persistentHits:0,
      memoryHits:0,
      misses:0,
      readBytes:0,
      corruptions:0,
      incompatibilities:0,
      validationFailures:0,
      serializationFailures:0,
      storageFailures:0,
      publishes:0,
      writes:0,
      duplicatePuts:0,
      publishBytes:0,
      writeBytes:0,
      cancelledPublishes:0,
      staleDependencyMisses:0,
      deletes:0,
      deleteMisses:0,
      mutationRetries:0,
    };
  }

  capabilities() {
    return Object.freeze({ storeVersion:ARTIFACT_STORE_VERSION, ...this.#backendHooks.capabilities() });
  }

  #backendSource() {
    return this.capabilities().persistent ? 'persistent' : 'memory';
  }

  #epoch(artifactId) {
    return this.epochs.get(requireArtifactId(artifactId)) || 0;
  }

  #bumpEpoch(artifactId) {
    const id = requireArtifactId(artifactId);
    this.epochs.set(id, this.#epoch(id) + 1);
  }

  async #waitForMutation(artifactId) {
    const active = this.mutations.get(requireArtifactId(artifactId));
    if (!active) return;
    try { await active; } catch { /* reads observe the resulting old/new state */ }
  }

  async #withMutation(artifactId, operation) {
    const id = requireArtifactId(artifactId);
    const previous = this.mutations.get(id);
    const priorSettled = previous ? previous.catch(() => {}) : Promise.resolve();
    const current = priorSettled.then(async () => {
      this.#bumpEpoch(id);
      try { return await operation(); }
      finally { this.#bumpEpoch(id); }
    });
    this.mutations.set(id, current);
    try { return await current; }
    finally { if (this.mutations.get(id) === current) this.mutations.delete(id); }
  }

  async get(descriptorOrId, options = {}) {
    const descriptor = typeof descriptorOrId === 'string' ? null : descriptorOrId;
    const artifactId = requireArtifactId(descriptor?.artifactId ?? descriptorOrId);
    aborted(options.signal);
    this.metrics.requests++;

    for (;;) {
      await this.#waitForMutation(artifactId);
      aborted(options.signal);
      const epoch = this.#epoch(artifactId);
      const cached = this.#hotCacheHooks.get(artifactId);
      if (cached) {
        try {
          const payloadBytes = normalizeStoredPayloadBytes(cached.payloadBytes);
          const record = canonicalStoredRecord(cached.record);
          const validated = validateStoredArtifact({ record, payload:payloadBytes }, {
            artifactId,
            descriptor,
            allowIncomplete:options.allowIncomplete,
          });
          const upstreamStatus = await this.#upstreamsValid(validated.record, options);
          if (upstreamStatus !== UPSTREAM_VALID) {
            if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
            if (upstreamStatus === UPSTREAM_BUDGET_EXHAUSTED) return this.#verificationBudgetMiss(artifactId, 'hot');
            return this.#staleDependency(artifactId, 'hot', validated.record, validated.payloadBytes);
          }
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          this.metrics.hotHits++;
          return { status:'hit', source:'hot', artifactId, record:validated.record, payload:validated.payload };
        } catch (error) {
          this.#hotCacheHooks.delete(artifactId);
          if (error instanceof ArtifactCorruptionError) {
            if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
            return this.#invalidResult(artifactId, error, 'hot', cached.record, cached.payloadBytes);
          }
          throw error;
        }
      }

      const source = this.#backendSource();
      let raw;
      try { this.metrics.reads++; raw = await this.#backendHooks.getRaw(artifactId); }
      catch (error) { this.metrics.storageFailures++; throw error; }
      aborted(options.signal);
      if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
      if (!raw) {
        this.metrics.misses++;
        return { status:'miss', source, artifactId, reason:'not-found' };
      }

      try {
        const validated = validateStoredArtifact(raw, {
          artifactId,
          descriptor,
          allowIncomplete:options.allowIncomplete,
        });
        this.metrics.readBytes += validated.payloadBytes.byteLength;
        const upstreamStatus = await this.#upstreamsValid(validated.record, options);
        if (upstreamStatus !== UPSTREAM_VALID) {
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          if (upstreamStatus === UPSTREAM_BUDGET_EXHAUSTED) return this.#verificationBudgetMiss(artifactId, source);
          return this.#staleDependency(artifactId, source, validated.record, validated.payloadBytes);
        }
        if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
        this.#hotCacheHooks.put(
          artifactId,
          { record:validated.record, payloadBytes:validated.payloadBytes },
          artifactHotEntrySize(validated.record, validated.payloadBytes),
        );
        if (source === 'persistent') this.metrics.persistentHits++;
        else this.metrics.memoryHits++;
        return { status:'hit', source, artifactId, record:validated.record, payload:validated.payload };
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) {
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          return this.#invalidResult(artifactId, error, source, raw.record, raw.payload);
        }
        throw error;
      }
    }
  }

  async #upstreamsValid(record, options, context = null) {
    if (options.verifyUpstreams === false) return UPSTREAM_VALID;
    const ctx = context || {
      activePath: new Set(),
      validated: new Set(),
      maxNodes: Number.isSafeInteger(options.maxNodes) && options.maxNodes >= 0 ? options.maxNodes : 10000,
      nodesVisited: 0,
    };
    const currentId = requireArtifactId(record.artifactId);
    if (ctx.activePath.has(currentId)) return UPSTREAM_INVALID;
    ctx.activePath.add(currentId);
    try {
      for (const upstreamId of record.upstreamArtifactIds || []) {
        aborted(options.signal);
        if (ctx.activePath.has(upstreamId)) return UPSTREAM_INVALID;
        if (ctx.validated.has(upstreamId)) continue;
        if (++ctx.nodesVisited > ctx.maxNodes) return UPSTREAM_BUDGET_EXHAUSTED;

        let raw;
        try { this.metrics.reads++; raw = await this.#backendHooks.getRaw(upstreamId); }
        catch (error) { this.metrics.storageFailures++; throw error; }
        if (!raw) return UPSTREAM_INVALID;
        try {
          const validated = validateStoredArtifact(raw, { artifactId:upstreamId });
          this.metrics.readBytes += validated.payloadBytes.byteLength;
          const upstreamStatus = await this.#upstreamsValid(validated.record, options, ctx);
          if (upstreamStatus !== UPSTREAM_VALID) return upstreamStatus;
          ctx.validated.add(upstreamId);
        } catch (error) {
          if (error instanceof ArtifactCorruptionError) {
            this.metrics.validationFailures++;
            return UPSTREAM_INVALID;
          }
          throw error;
        }
      }
      return UPSTREAM_VALID;
    } finally {
      ctx.activePath.delete(currentId);
    }
  }

  async #deleteObservedArtifact(artifactId, record, payloadBytes) {
    if (this.corruptionPolicy !== 'delete') return false;
    return this.#withMutation(artifactId, async () => {
      this.#hotCacheHooks.delete(artifactId);
      try {
        if (record && payloadBytes != null && typeof this.backend.deleteIfMatches === 'function') {
          return await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
        }
        return false;
      } catch (error) {
        this.metrics.storageFailures++;
        throw error;
      }
    });
  }

  #verificationBudgetMiss(artifactId, source) {
    this.metrics.misses++;
    return { status:'miss', source, artifactId, reason:'verification-budget-exhausted' };
  }

  async #staleDependency(artifactId, source, record, payloadBytes) {
    this.metrics.staleDependencyMisses++;
    this.metrics.misses++;
    this.#hotCacheHooks.delete(artifactId);
    await this.#deleteObservedArtifact(artifactId, record, payloadBytes);
    return { status:'miss', source, artifactId, reason:'missing-upstream' };
  }

  async #invalidResult(artifactId, error, source, record, payloadBytes) {
    this.metrics.validationFailures++;
    const incompatible = INCOMPATIBLE_CODES.has(error.code);
    if (incompatible) this.metrics.incompatibilities++;
    else this.metrics.corruptions++;
    this.#hotCacheHooks.delete(artifactId);
    await this.#deleteObservedArtifact(artifactId, record, payloadBytes);
    return {
      status:incompatible ? 'incompatible' : 'corrupt',
      source,
      artifactId,
      reason:error.code,
      error,
    };
  }

  async publish(descriptor, payload, options = {}) {
    if (!descriptor?.artifactId) throw new TypeError('artifact-descriptor-required');
    assertCanonicalArtifactDescriptor(descriptor);
    const artifactId = requireArtifactId(descriptor.artifactId);
    aborted(options.signal);

    let payloadBytes;
    let stagedPayload;
    let record;
    try {
      payloadBytes = encodeArtifactPayload(payload);
      stagedPayload = decodeArtifactPayload(payloadBytes);
      record = createArtifactRecord(descriptor, payloadBytes, {
        completeness:options.completeness ?? 'complete',
        creation:options.creation,
      });
    } catch (error) {
      this.metrics.serializationFailures++;
      throw error;
    }

    if (typeof options.validate === 'function') {
      try { await options.validate(stagedPayload, record, { signal:options.signal }); }
      catch (error) { this.metrics.validationFailures++; throw error; }
    }
    aborted(options.signal);

    return this.#withMutation(artifactId, async () => {
      aborted(options.signal);
      let writeResult;
      try {
        writeResult = await this.#backendHooks.putAtomic(record, payloadBytes, { signal:options.signal });
      } catch (error) {
        this.#hotCacheHooks.delete(artifactId);
        if (isAbort(error, options.signal)) this.metrics.cancelledPublishes++;
        else this.metrics.storageFailures++;
        throw error;
      }

      if (options.signal?.aborted) {
        this.metrics.cancelledPublishes++;
        this.#hotCacheHooks.delete(artifactId);
        if (!writeResult?.duplicate) {
          try {
            if (typeof this.backend.deleteIfMatches === 'function') await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
            else await this.#backendHooks.delete(artifactId);
          } catch { /* cancellation remains the primary result */ }
        }
        throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      let canonicalRecord;
      let canonicalPayloadBytes;
      let returnedPayload;
      try {
        canonicalRecord = canonicalStoredRecord(writeResult?.record ?? record);
        canonicalPayloadBytes = normalizeStoredPayloadBytes(writeResult?.payload ?? payloadBytes);
        const storedView = { record:canonicalRecord, payload:canonicalPayloadBytes };
        if (Object.hasOwn(writeResult || {}, 'storageEnvelopeSchemaVersion')) storedView.storageEnvelopeSchemaVersion = writeResult.storageEnvelopeSchemaVersion;
        if (Object.hasOwn(writeResult || {}, 'recordChecksum')) storedView.recordChecksum = writeResult.recordChecksum;
        const validated = validateStoredArtifact(
          storedView,
          { artifactId, descriptor, allowIncomplete:(options.completeness ?? 'complete') !== 'complete' },
        );
        canonicalRecord = validated.record;
        canonicalPayloadBytes = validated.payloadBytes;
        returnedPayload = validated.payload;
      } catch (error) {
        this.#hotCacheHooks.delete(artifactId);
        if (!writeResult?.duplicate) {
          try {
            if (typeof this.backend.deleteIfMatches === 'function') await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
            else await this.#backendHooks.delete(artifactId);
          } catch { /* preserve the original post-publication failure */ }
        }
        throw error;
      }

      this.#hotCacheHooks.put(
        artifactId,
        { record:canonicalRecord, payloadBytes:canonicalPayloadBytes },
        artifactHotEntrySize(canonicalRecord, canonicalPayloadBytes),
      );
      this.metrics.publishes++;
      this.metrics.publishBytes += canonicalPayloadBytes.byteLength;
      if (writeResult?.duplicate) this.metrics.duplicatePuts++;
      else {
        this.metrics.writes++;
        this.metrics.writeBytes += canonicalPayloadBytes.byteLength;
      }
      return {
        status:'published',
        artifactId,
        record:canonicalRecord,
        payload:returnedPayload,
        duplicate:!!writeResult?.duplicate,
      };
    });
  }

  async delete(artifactId) {
    const id = requireArtifactId(artifactId);
    return this.#withMutation(id, async () => {
      this.#hotCacheHooks.delete(id);
      let deleted;
      try { deleted = await this.#backendHooks.delete(id); }
      catch (error) { this.metrics.storageFailures++; throw error; }
      if (deleted) this.metrics.deletes++;
      else this.metrics.deleteMisses++;
      return deleted;
    });
  }

  evictHot(artifactId = null) {
    if (artifactId == null) {
      this.#hotCacheHooks.clear();
      return;
    }
    const id = requireArtifactId(artifactId);
    this.#bumpEpoch(id);
    this.#hotCacheHooks.delete(id, true);
    this.#bumpEpoch(id);
  }

  async close() {
    const pending = [...this.mutations.values()];
    if (pending.length) await Promise.allSettled(pending);
    this.#hotCacheHooks.clear();
    await this.#backendHooks.close();
  }

  stats() {
    return Object.freeze({
      storeVersion:ARTIFACT_STORE_VERSION,
      capabilities:this.capabilities(),
      hotCache:this.#hotCacheHooks.stats(),
      backend:this.backend.stats?.() ?? {},
      ...this.metrics,
    });
  }
}

export function createArtifactStore(options = {}) {
  const backend = options.backend ?? createArtifactBackend(options);
  const hotCache = options.hotCache ?? new ArtifactHotCache(options.hotCacheOptions);
  return new ArtifactStore({ backend, hotCache, corruptionPolicy:options.corruptionPolicy });
}