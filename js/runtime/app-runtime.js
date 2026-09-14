import { RuntimeAnalysisPlatform } from './index.js';
import { RuntimeProviderPlatform } from './provider-platform.js';

const states = new WeakMap();
const transitions = new WeakMap();
const MAX_IDENTITY_SOURCE_RETRIES = 3;
const providerStates = new WeakMap();

function currentFileToken(app) {
  return app?.store?.get?.('fileInfo') || null;
}
function strictSliceIndex(value) {
  if (value == null) return -1;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  if (typeof value !== 'string') return -1;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return -1;
  const index = Number(text);
  return Number.isSafeInteger(index) ? index : -1;
}
function architectureEvidence(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.toLowerCase() === 'unknown') return null;
  return text;
}
function activeArchitecture(app) {
  const info=currentFileToken(app);
  const index=strictSliceIndex(app?.store?.get?.('sliceIndex'));
  const slice=index>=0 ? info?.slices?.[index] : null;
  const detail=slice?.info || {};
  return architectureEvidence(app?.store?.get?.('capability')?.architecture)
    || architectureEvidence(app?.store?.get?.('architecture'))
    || architectureEvidence(slice?.capability?.architecture)
    || architectureEvidence(detail.architecture)
    || architectureEvidence(detail.cpuSub)
    || architectureEvidence(detail.cpu)
    || 'unknown';
}
function canonicalSliceUuid(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('runtime-slice-uuid-invalid');
  return value;
}
function activeSliceIdentity(app) {
  const info=currentFileToken(app);
  const index=strictSliceIndex(app?.store?.get?.('sliceIndex'));
  const slice=index>=0 ? info?.slices?.[index] : null;
  const detail=slice?.info || {};
  const arch=activeArchitecture(app);
  const uuid=canonicalSliceUuid(detail.uuid);
  return `slice:${index}:${uuid ?? '-'}:${arch}`;
}

function providerSourceState(app) {
  const info = currentFileToken(app), backend = app?.backend ?? null;
  return { info, backend, file: backend?.file ?? app?.store?.get?.('file') ?? null,
    slice: activeSliceIdentity(app), index: app?.store?.get?.('sliceIndex') ?? null,
    generation: backend?.gen ?? null, transportEpoch: backend?.transportEpoch ?? null,
    binaryId: backend?.binaryId ?? null, hash: info?.hash ?? null, sha256: info?.sha256 ?? null };
}

/** Bind an existing provider facade to this source. No provider/session is
 * created or selected and no byte hashing, streaming, or replay is performed. */
export function bindRuntimeProviderPlatformForApp(app, platform) {
  if (!app || !(platform instanceof RuntimeProviderPlatform)) throw new TypeError('runtime-provider-platform-required');
  const source = providerSourceState(app);
  if (!source.info && !source.file) throw new TypeError('runtime-provider-app-source-required');
  providerStates.set(app, { platform, source });
  return platform;
}

export function existingRuntimeProviderPlatformForApp(app) {
  const bound = app && providerStates.get(app);
  if (!bound) return null;
  const now = providerSourceState(app);
  if (Object.keys(bound.source).some(key => bound.source[key] !== now[key])) {
    providerStates.delete(app);
    return null;
  }
  return bound.platform;
}
function localSandboxSupportsArchitecture(architecture) {
  if (typeof architecture !== 'string') return false;
  const arch=architecture.trim().toLowerCase();
  return arch === 'arm64' || arch === 'arm64e' || arch === 'aarch64';
}
function validContentHash(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function scalarSourceValue(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

function sourceInfoFingerprint(info) {
  if (info == null) return null;
  if (typeof info !== 'object') return scalarSourceValue(info);
  const slices = Array.isArray(info.slices)
    ? info.slices.map((slice) => {
      const detail = slice?.info || {}, capability = slice?.capability || {};
      return [
        scalarSourceValue(slice?.offset), scalarSourceValue(slice?.size),
        scalarSourceValue(detail.uuid), scalarSourceValue(detail.architecture),
        scalarSourceValue(detail.cpuSub), scalarSourceValue(detail.cpu),
        scalarSourceValue(capability.architecture),
      ];
    })
    : null;
  try {
    return JSON.stringify([
      scalarSourceValue(info.name), scalarSourceValue(info.size), scalarSourceValue(info.format),
      scalarSourceValue(info.hash), scalarSourceValue(info.sha256), slices,
    ]);
  } catch {
    return null;
  }
}

function backendGeneration(backend) {
  return backend?.gen ?? backend?.generation ?? backend?.analysisEpoch ?? null;
}

function sourceFileOf(app, backend) {
  return backend?.file ?? app?.store?.get?.('file') ?? null;
}

function sourceBindingForApp(app) {
  const backend = app?.backend ?? null;
  const fileToken = currentFileToken(app);
  const tokenProbe = currentFileToken(app);
  return Object.freeze({
    fileToken,
    fileTokenStable: tokenProbe === fileToken,
    fileTokenFingerprint: sourceInfoFingerprint(fileToken),
    backend,
    file: sourceFileOf(app, backend),
    generation: backendGeneration(backend),
    transportEpoch: backend?.transportEpoch ?? null,
    sliceIndex: strictSliceIndex(app?.store?.get?.('sliceIndex')),
    sliceIdentity: activeSliceIdentity(app),
    projectHash: validContentHash(app?.project?.binaryHash),
  });
}

function sourceBindingIsCurrent(app, binding) {
  if (!binding) return false;
  const currentInfo = currentFileToken(app);
  if (binding.fileTokenStable && currentInfo !== binding.fileToken) return false;
  if (sourceInfoFingerprint(currentInfo) !== binding.fileTokenFingerprint) return false;
  const backend = app?.backend ?? null;
  if (backend !== binding.backend) return false;
  if (sourceFileOf(app, backend) !== binding.file) return false;
  if (backendGeneration(backend) !== binding.generation) return false;
  if ((backend?.transportEpoch ?? null) !== binding.transportEpoch) return false;
  if (strictSliceIndex(app?.store?.get?.('sliceIndex')) !== binding.sliceIndex) return false;
  if (validContentHash(app?.project?.binaryHash) !== binding.projectHash) return false;
  try {
    return activeSliceIdentity(app) === binding.sliceIdentity;
  } catch {
    return false;
  }
}

function staleRuntimeSourceError() {
  const error = new Error('runtime source binding changed during content hash');
  error.code = 'RUNTIME_SOURCE_CHANGED';
  error.stale = true;
  return error;
}

async function binaryHashOf(app, binding) {
  const info = binding.fileToken;
  const backend = binding.backend;
  const ensureContentHash = typeof backend?.ensureContentHash === 'function' ? backend.ensureContentHash : null;
  for (const candidate of [info?.hash, info?.sha256, binding.projectHash, backend?.contentHash]) {
    const existing=validContentHash(candidate);
    if(existing) return existing;
  }
  if (ensureContentHash) {
    try {
      const hash = await Reflect.apply(ensureContentHash, backend, []);
      if (!sourceBindingIsCurrent(app, binding)) throw staleRuntimeSourceError();
      return validContentHash(hash);
    } catch (error) {
      if (!sourceBindingIsCurrent(app, binding)) throw staleRuntimeSourceError();
      return null;
    }
  }
  return null;
}
function strictAddress(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try { return BigInt(value.trim()); } catch { return null; }
}
async function resolveRuntimeIdentityForApp(app) {
  let stale = null;
  for (let attempt = 0; attempt < MAX_IDENTITY_SOURCE_RETRIES; attempt += 1) {
    const source = sourceBindingForApp(app);
    try {
      const contentHash = await binaryHashOf(app, source);
      if (!sourceBindingIsCurrent(app, source)) throw staleRuntimeSourceError();
      const identity = {
        contentHash,
        sliceIdentity: source.sliceIdentity,
        key: `${contentHash || 'unhashed'}|${source.sliceIdentity}`,
      };
      return { identity, source };
    } catch (error) {
      if (!error?.stale) throw error;
      stale = error;
    }
  }
  throw stale || staleRuntimeSourceError();
}

export async function runtimeIdentityForApp(app) {
  return (await resolveRuntimeIdentityForApp(app)).identity;
}

/**
 * Build the narrow I/O surface consumed by the deterministic function sandbox.
 * This deliberately mirrors the proven emulator I/O path without exposing the
 * whole App object to runtime adapters.
 */
export function createAppRuntimeIO(app, source = null) {
  const binding = source || sourceBindingForApp(app);
  if (!sourceBindingIsCurrent(app, binding)) throw staleRuntimeSourceError();
  const backend = binding.backend;
  const symbols = app?.symbols;
  const architecture = activeArchitecture(app);
  const regions = (app?.store?.get?.('regions') || []).filter((r) => r.exec && r.size > 0n);
  const regionAt = (addr) => regions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.size) || null;
  const isCurrent = () => sourceBindingIsCurrent(app, binding);
  return {
    read: async (addr, len) => {
      if (!isCurrent() || typeof backend?.readAt !== 'function') return null;
      try {
        const result = await backend.readAt(addr, len);
        return isCurrent() && result && result.found ? result.bytes : null;
      } catch {
        return null;
      }
    },
    fetch: async (addr) => {
      if (!isCurrent()) return null;
      const region = regionAt(addr);
      if (!region) return null;
      // The local concrete sandbox is ARM64 today. Resolve architecture from
      // the same active-slice truth as the runtime identity and fail closed for
      // unknown or variable-width targets instead of defaulting to ARM64.
      if (!localSandboxSupportsArchitecture(architecture)) return null;
      const delta = addr - region.vmAddr;
      if (delta % 4n !== 0n) return null;
      const row = Number(delta / 4n);
      const chunk = Math.floor(row / 1024);
      if (typeof backend?.fetchChunk !== 'function') return null;
      const decoded = await backend.fetchChunk(region.id, chunk, true);
      if (!isCurrent()) return null;
      const index = row - chunk * 1024;
      return { mn: decoded.mn ? decoded.mn[index] : '', ops: decoded.ops ? decoded.ops[index] : '' };
    },
    isExecutable: (addr) => isCurrent() && !!regionAt(addr),
    symbolFor: (addr) => isCurrent() ? symbols?.nameAt?.(addr) || null : null,
    labelFor: (addr) => isCurrent() ? symbols?.label?.(addr) || null : null,
  };
}

async function disposeState(state) {
  const manager = state?.platform?.sessions;
  if (!manager) return;
  // Canonical dispose-all: an old platform owns up to maxSessions live
  // sessions. Closing only `current` orphans the other live session on the
  // old I/O/context. Prefer closeAll when the manager provides it.
  if (typeof manager.closeAll === 'function') {
    try { await manager.closeAll(); } catch { /* best effort */ }
    return;
  }
  const live = manager.sessions instanceof Map
    ? [...manager.sessions.values()]
    : (manager.current ? [manager.current] : []);
  const seen = new Set();
  for (const session of live) {
    const id = session?.id ?? session?.runtimeSessionId ?? null;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    try {
      if (id != null && typeof manager.close === 'function') await manager.close(id);
      else if (typeof manager.closeSession === 'function' && id != null) await manager.closeSession(id);
      else if (typeof session?.disconnect === 'function') await session.disconnect();
      else if (typeof session?.close === 'function') await session.close();
    } catch { /* best effort: one failure must not stop remaining cleanup */ }
  }
}

async function withRuntimeTransition(app, operation) {
  const previous = transitions.get(app) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  transitions.set(app, pending);
  try {
    return await pending;
  } finally {
    if (transitions.get(app) === pending) transitions.delete(app);
  }
}

export async function runtimePlatformForApp(app) {
  if (!app) throw new Error('runtime app is required');
  return withRuntimeTransition(app, async () => {
    let resolved = await resolveRuntimeIdentityForApp(app);
    let { identity, source } = resolved;
    if (!identity.contentHash) throw new Error('runtime binary identity is unavailable');
    let state = states.get(app);
    const stateSourceChanged = state?.source
      ? !sourceBindingIsCurrent(app, state.source)
      : state?.fileToken !== currentFileToken(app);
    if (state && (state.identityKey !== identity.key || stateSourceChanged)) {
      await disposeState(state);
      if (states.get(app) === state) states.delete(app);
      state = states.get(app) || null;
      resolved = await resolveRuntimeIdentityForApp(app);
      ({ identity, source } = resolved);
      if (!identity.contentHash) throw new Error('runtime binary identity is unavailable');
    }
    if (!state) {
      const platform = new RuntimeAnalysisPlatform({
        localIO: createAppRuntimeIO(app, source),
        sessions: { maxSessions: 2 },
        sliceIdentity: identity.sliceIdentity,
      });
      const candidate = { platform, fileToken:source.fileToken, identityKey:identity.key, identity, source };
      if (!candidate.platform.sessions.current) {
        await candidate.platform.startSession({ adapter:'local', binaryHash:identity.contentHash, connect:true });
      }
      if (!sourceBindingIsCurrent(app, source)) {
        await disposeState(candidate);
        throw staleRuntimeSourceError();
      }
      state = candidate;
      states.set(app, state);
    }
    if (!state.platform.sessions.current) {
      await state.platform.startSession({ adapter:'local', binaryHash:identity.contentHash, connect:true });
      if (!sourceBindingIsCurrent(app, state.source)) {
        if (states.get(app) === state) states.delete(app);
        await disposeState(state);
        throw staleRuntimeSourceError();
      }
    }
    return state.platform;
  });
}

export function runtimeEvidenceForApp(app, functionAddress = null) {
  const state = states.get(app);
  const sliceIdentity=activeSliceIdentity(app);
  const sourceCurrent = state?.source
    ? sourceBindingIsCurrent(app, state.source)
    : state?.fileToken === currentFileToken(app);
  if (!state || !sourceCurrent || state.identity?.sliceIdentity !== sliceIdentity) return [];
  const evidence = (Array.isArray(state.platform?.evidence) ? state.platform.evidence : []).filter((item)=>item?.sliceIdentity===sliceIdentity && item?.binaryHash===state.identity?.contentHash);
  if (functionAddress == null) return evidence.slice();
  const address = strictAddress(functionAddress);
  if (address == null) return [];
  return evidence.filter((item) => {
    const candidate = item?.function == null ? null : strictAddress(item.function);
    return candidate != null && candidate === address;
  });
}

export async function traceAppFunction(app, functionAddress, options = {}) {
  const platform = await runtimePlatformForApp(app);
  return platform.traceFunction(functionAddress, {
    ...options,
    maxSteps: options.maxSteps ?? 12000,
    timeoutMs: options.timeoutMs ?? 1500,
    limit: options.limit ?? 4096,
  });
}

export async function verifyAppHypothesis(app, hypothesis, options = {}) {
  const platform = await runtimePlatformForApp(app);
  return platform.verifyHypothesis(hypothesis, options);
}

export async function resetAppRuntime(app) {
  if (!app) return false;
  return withRuntimeTransition(app, async () => {
    const state = states.get(app);
    if (!state) return false;
    await disposeState(state);
    if (states.get(app) === state) states.delete(app);
    return true;
  });
}
