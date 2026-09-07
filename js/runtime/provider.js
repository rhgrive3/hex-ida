import { deepFreeze } from '../core/identity/index.js';
import { DebugAdapterError } from '../debug/adapter.js';
import {
  RuntimeModuleBindingTable,
  createRuntimeProviderSessionId,
  createRuntimeTargetBinding,
} from './provider-identity.js';
import { normalizeRuntimeModuleBinding } from './module-binding.js';

export const RUNTIME_FACETS = Object.freeze(['debugger', 'instrumentation', 'trace', 'emulator']);
export const RUNTIME_SESSION_STATES = Object.freeze(['opening', 'ready', 'running', 'paused', 'degraded', 'disconnected', 'closing', 'closed', 'failed']);

function required(value, code, message) {
  if (typeof value !== 'string') throw new DebugAdapterError(code, message || code);
  const text = value.trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function normalizeFacetNames(value) {
  if (value == null) return Object.freeze([]);
  const isArray = Array.isArray(value);
  if (!isArray) {
    if (typeof value !== 'object') {
      throw new DebugAdapterError('runtime-invalid-facet', 'runtime facets must be an array or plain object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DebugAdapterError('runtime-invalid-facet', 'runtime facets must be an array or plain object');
    }
  }
  const source = isArray ? value : Object.keys(value).filter((key) => value[key] === true);
  for (const facet of source) {
    if (typeof facet !== 'string') throw new DebugAdapterError('runtime-invalid-facet', 'runtime facet names must be strings');
  }
  const out = [...new Set(source)];
  for (const facet of out) if (!RUNTIME_FACETS.includes(facet)) throw new DebugAdapterError('runtime-invalid-facet', `unsupported runtime facet: ${facet}`);
  return Object.freeze(out.sort());
}

function ownedClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(ownedClone);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, { value: ownedClone(item), enumerable: true, configurable: true, writable: true });
  }
  return out;
}

export function createRuntimeProviderDescriptor(input = {}) {
  return deepFreeze({
    id: required(input.id, 'runtime-provider-id-required', 'runtime provider id is required'),
    version: required(input.version ?? '1', 'runtime-provider-version-required', 'runtime provider version must be a non-empty string'),
    kind: required(input.kind ?? 'generic', 'runtime-provider-kind-required', 'runtime provider kind must be a non-empty string'),
    facets: normalizeFacetNames(input.facets),
    capabilities: input.capabilities && typeof input.capabilities === 'object' ? ownedClone(input.capabilities) : {},
  });
}

export class RuntimeProviderSession {
  constructor({ provider, request = {}, target, facets = {}, close }) {
    this.provider = provider;
    const descriptor = provider.descriptor();
    this.providerId = descriptor.id;
    this.providerVersion = descriptor.version;
    this.runtimeSessionId = createRuntimeProviderSessionId({
      binaryId: request.binaryId ?? request.binaryHash,
      providerId: this.providerId,
      targetIdentity: request.targetIdentity ?? request.target ?? { processKey: request.processKey ?? 'default' },
      sessionNonce: request.sessionNonce ?? request.startedAt ?? `${Date.now()}:${Math.random()}`,
    });
    this.target = createRuntimeTargetBinding({
      processKey: request.processKey,
      platform: request.platform,
      architecture: request.architecture,
      primaryBinaryId: request.binaryId ?? request.binaryHash,
      primarySliceId: request.sliceId,
      startedAt: request.startedAt,
      bindingEvidenceIds: request.bindingEvidenceIds,
      ...target,
      runtimeSessionId: this.runtimeSessionId,
      providerId: this.providerId,
      providerVersion: this.providerVersion,
    });
    this.facets = Object.freeze({ ...facets });
    this.modules = new RuntimeModuleBindingTable(this.runtimeSessionId);
    this.state = 'opening';
    this.epoch = 1;
    this.closed = false;
    this.controllers = new Set();
    this._close = typeof close === 'function' ? close : null;
  }

  setState(next) {
    if (typeof next !== 'string') throw new DebugAdapterError('runtime-invalid-session-state', 'runtime session state must be a string');
    const state = next;
    if (!RUNTIME_SESSION_STATES.includes(state)) throw new DebugAdapterError('runtime-invalid-session-state', `invalid runtime session state: ${state}`);
    if (this.closed && state !== 'closed') throw new DebugAdapterError('runtime-session-closed', 'cannot transition a closed runtime provider session');
    this.state = state;
    return state;
  }

  controller() {
    if (this.closed) throw new DebugAdapterError('runtime-session-closed', 'runtime provider session is closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    controller.signal.addEventListener('abort', () => this.controllers.delete(controller), { once: true });
    return controller;
  }

  releaseController(controller) { this.controllers.delete(controller); }

  cancelAll(reason = 'cancelled') {
    for (const controller of [...this.controllers]) controller.abort(reason);
    this.controllers.clear();
  }

  newEpoch(reason = 'runtime-session-epoch-changed') {
    if (this.closed) throw new DebugAdapterError('runtime-session-closed', 'runtime provider session is closed');
    this.epoch++;
    this.cancelAll(reason);
    return this.epoch;
  }

  async close() {
    if (this.closed) return;
    this.setState('closing');
    this.cancelAll('runtime-session-closing');
    try { if (this._close) await this._close(this); }
    finally {
      this.closed = true;
      this.state = 'closed';
    }
  }
}

export class RuntimeProviderRegistry {
  constructor() {
    this.providers = new Map();
    this._descriptors = new Map();
  }

  register(provider) {
    if (!provider || typeof provider.descriptor !== 'function' || typeof provider.openSession !== 'function') {
      throw new DebugAdapterError('runtime-invalid-provider', 'runtime provider requires descriptor() and openSession()');
    }
    const descriptor = createRuntimeProviderDescriptor(provider.descriptor());
    if (this.providers.has(descriptor.id)) throw new DebugAdapterError('runtime-duplicate-provider', `runtime provider already registered: ${descriptor.id}`);
    this.providers.set(descriptor.id, provider);
    this._descriptors.set(descriptor.id, descriptor);
    return provider;
  }

  unregister(id) {
    const removed = this.providers.delete(id);
    if (removed) this._descriptors.delete(id);
    return removed;
  }

  get(id) { return this.providers.get(id) || null; }
  list() { return Object.freeze([...this._descriptors.values()]); }

  async openSession(providerId, request = {}, options = {}) {
    const provider = this.get(providerId);
    const descriptor = this._descriptors.get(providerId);
    if (!provider || !descriptor) throw new DebugAdapterError('runtime-provider-not-found', `runtime provider not found: ${providerId}`);
    const session = await provider.openSession(request, options);
    if (!(session instanceof RuntimeProviderSession)) throw new DebugAdapterError('runtime-invalid-session', 'runtime provider returned an invalid session');
    if (
      session.providerId !== descriptor.id
      || session.providerVersion !== descriptor.version
      || session.target?.providerId !== descriptor.id
      || session.target?.providerVersion !== descriptor.version
    ) {
      try { await session.close(); } catch {}
      throw new DebugAdapterError('runtime-provider-descriptor-drift', `runtime provider descriptor changed after registration: ${providerId}`);
    }
    return session;
  }
}

function adapterFacetNames(adapter) {
  const facets = new Set(['debugger']);
  if (adapter?.kind === 'frida' || adapter?.capabilities?.objcRuntime === true || adapter?.capabilities?.swiftRuntime === true) facets.add('instrumentation');
  if (adapter?.kind === 'replay' || adapter?.capabilities?.replay === true || adapter?.capabilities?.traceFunction === true) facets.add('trace');
  if (adapter?.kind === 'emulator' || adapter?.kind === 'local' || adapter?.kind === 'sandbox') facets.add('emulator');
  return [...facets];
}

function debuggerFacet(adapter, session) {
  return Object.freeze({
    adapter,
    capabilities: adapter.capabilities,
    attach: (...args) => adapter.attach(...args),
    launch: (...args) => adapter.launch(...args),
    pause: (...args) => adapter.pause(...args),
    resume: (...args) => adapter.resume(...args),
    stepInto: (...args) => adapter.stepInto(...args),
    stepOver: (...args) => adapter.stepOver(...args),
    stepOut: (...args) => adapter.stepOut(...args),
    setBreakpoint: (...args) => adapter.setBreakpoint(...args),
    removeBreakpoint: (...args) => adapter.removeBreakpoint(...args),
    listBreakpoints: (...args) => adapter.listBreakpoints(...args),
    readRegisters: (...args) => adapter.readRegisters(...args),
    writeRegister: async (...args) => {
      const result = await adapter.writeRegister(...args);
      return { result, intervention: { kind: 'register-write', runtimeSessionId: session.runtimeSessionId } };
    },
    readMemory: (...args) => adapter.readMemory(...args),
    writeMemory: async (...args) => {
      const result = await adapter.writeMemory(...args);
      return { result, intervention: { kind: 'memory-write', runtimeSessionId: session.runtimeSessionId } };
    },
    getThreads: (...args) => adapter.getThreads(...args),
    getModules: (...args) => adapter.getModules(...args),
    getBacktrace: (...args) => adapter.getBacktrace(...args),
    evaluate: (...args) => adapter.evaluate(...args),
  });
}

function traceFacet(adapter) {
  return Object.freeze({
    capabilities: adapter.capabilities,
    trace: (...args) => adapter.trace(...args),
    replay: (...args) => adapter.replay(...args),
  });
}

function instrumentationFacet(adapter, session) {
  return Object.freeze({
    compatibility: true,
    capabilities: adapter.capabilities,
    trace: (...args) => adapter.trace(...args),
    getObjCRuntimeInfo: (...args) => adapter.getObjCRuntimeInfo(...args),
    getSwiftRuntimeInfo: (...args) => adapter.getSwiftRuntimeInfo(...args),
    interventionContext: () => ({ runtimeSessionId: session.runtimeSessionId }),
  });
}

function emulatorFacet(adapter) {
  return Object.freeze({ compatibility: true, capabilities: adapter.capabilities, launch: (...args) => adapter.launch(...args), resume: (...args) => adapter.resume(...args) });
}

export class DebugAdapterRuntimeProvider {
  constructor(adapter, options = {}) {
    if (!adapter) throw new DebugAdapterError('adapter', 'DebugAdapterRuntimeProvider requires an adapter');
    this.adapter = adapter;
    this.options = options;
    this.activeSession = null;
    this.sessionEpoch = 0;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `adapter:${adapter.id}`,
      version: options.version ?? '1',
      kind: options.kind ?? adapter.kind,
      facets: adapterFacetNames(adapter),
      capabilities: adapter.capabilities,
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('adapter-in-use', 'debug adapter compatibility provider supports one live session');
    const adapterEpoch = this.adapter?.epoch;
    const nextSessionEpoch = Math.max(
      this.sessionEpoch + 1,
      Number.isSafeInteger(adapterEpoch) && adapterEpoch >= 0 ? adapterEpoch + 1 : 1,
    );
    let session;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        try { if (this.adapter.connected) await this.adapter.disconnect(); }
        finally { if (this.activeSession === session) this.activeSession = null; }
      },
    });
    session.epoch = nextSessionEpoch;
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(session.epoch);
    this.sessionEpoch = session.epoch;
    const facets = {};
    if (this._descriptor.facets.includes('debugger')) facets.debugger = debuggerFacet(this.adapter, session);
    if (this._descriptor.facets.includes('instrumentation')) facets.instrumentation = instrumentationFacet(this.adapter, session);
    if (this._descriptor.facets.includes('trace')) facets.trace = traceFacet(this.adapter);
    if (this._descriptor.facets.includes('emulator')) facets.emulator = emulatorFacet(this.adapter);
    session.facets = Object.freeze(facets);
    this.activeSession = session;

    try {
      if (options.connect !== false && !this.adapter.connected) await this.adapter.connect(options.connectOptions || {});
      if (this.adapter.capabilities?.modules && typeof this.adapter.getModules === 'function') {
        const modules = await this.adapter.getModules();
        if (!Array.isArray(modules)) throw new DebugAdapterError('runtime-invalid-modules', 'debug adapter getModules must return an array');
        for (let i = 0; i < modules.length; i++) {
          const module = modules[i] || {};
          if (module.base == null || module.size == null) continue;
          const bindingKey = module.id ?? module.uuid ?? module.name ?? `module:${i}`;
          session.modules.load(normalizeRuntimeModuleBinding(module, { bindingKey }));
        }
      }
      session.setState('ready');
      return session;
    } catch (error) {
      session.setState('failed');
      try { await session.close(); } catch {}
      throw error;
    }
  }
}

export function wrapDebugAdapterAsRuntimeProvider(adapter, options = {}) {
  return new DebugAdapterRuntimeProvider(adapter, options);
}
