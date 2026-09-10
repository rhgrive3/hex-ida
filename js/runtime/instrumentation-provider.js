import { DebugAdapterError } from '../debug/adapter.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { RuntimeEventNormalizer } from './events.js';
import { createInterventionRecord, InterventionLedger } from './evidence-bridge.js';
import { normalizeRuntimeModuleBinding } from './module-binding.js';

function moduleFields(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const module = payload.module && typeof payload.module === 'object' ? payload.module : payload;
  return module;
}

function requiredMethod(backend, method, capability) {
  if (typeof backend?.[method] !== 'function') throw new DebugAdapterError('unsupported', `instrumentation backend does not support ${capability || method}`);
  return backend[method].bind(backend);
}

function validateInterventionDraft(ledger, input) {
  // Executed occurrences must be distinguishable: the ledger allocates a
  // monotonic sequence when the draft omits one (#5327), so repeated
  // identical target/change operations derive distinct intervention ids.
  const record = createInterventionRecord({
    ...input,
    sequence: input.sequence == null ? ledger.nextSequence() : input.sequence,
  });
  for (const parent of record.parentInterventionIds) {
    if (!ledger.get(parent)) throw new DebugAdapterError('runtime-intervention-parent-missing', `intervention parent not found: ${parent}`);
  }
  return record;
}

function moduleKey(module, index) {
  return module?.bindingKey ?? module?.moduleKey ?? module?.id ?? module?.uuid ?? module?.name ?? `instrumentation-module:${index}`;
}

function normalizeProbeHandle(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new DebugAdapterError('runtime-invalid-probe-handle', 'probe handle must be a string, number, or bigint');
  }
  if (typeof value === 'string' && !value) throw new DebugAdapterError('runtime-invalid-probe-handle', 'probe handle must not be empty');
  return value;
}

function probeHandle(result) {
  return normalizeProbeHandle(result?.handle ?? result?.id ?? result?.probeId ?? null);
}

function eventProbeHandle(raw) {
  const source = raw && raw.type === 'event' && typeof raw.event === 'string'
    ? (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {})
    : raw;
  return normalizeProbeHandle(source?.probeHandle ?? source?.handle ?? source?.payload?.probeHandle ?? source?.payload?.handle ?? null);
}

function eventInterventionIds(raw) {
  const protocolEnvelope = raw && raw.type === 'event' && typeof raw.event === 'string';
  const source = protocolEnvelope
    ? (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {})
    : raw;
  return protocolEnvelope && raw.interventionIds != null
    ? raw.interventionIds
    : source?.interventionIds ?? null;
}

function materializeRuntimeValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') {
    if (typeof value === 'function') throw new DebugAdapterError('runtime-invalid-event', 'runtime event contains a function');
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof DataView) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const ownedBytes = Uint8Array.from(bytes);
    return new DataView(ownedBytes.buffer);
  }
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof Map) {
    const output = new Map();
    seen.set(value, output);
    for (const [key, item] of value) {
      output.set(materializeRuntimeValue(key, seen), materializeRuntimeValue(item, seen));
    }
    return output;
  }
  if (value instanceof Set) {
    const output = new Set();
    seen.set(value, output);
    for (const item of value) output.add(materializeRuntimeValue(item, seen));
    return output;
  }

  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (Array.isArray(value)) output.length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === 'length') continue;
    Object.defineProperty(output, key, {
      value: materializeRuntimeValue(value[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function materializeRuntimeEvent(raw) {
  try {
    return materializeRuntimeValue(raw);
  } catch (error) {
    if (error instanceof DebugAdapterError) throw error;
    throw new DebugAdapterError('runtime-invalid-event', `runtime event could not be materialized: ${String(error?.message || error)}`);
  }
}

export class InstrumentationProvider {
  constructor(backend, options = {}) {
    if (!backend || typeof backend !== 'object') throw new DebugAdapterError('instrumentation-backend-required', 'InstrumentationProvider requires a backend');
    this.backend = backend;
    this.options = options;
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `instrumentation:${backend.id ?? backend.kind ?? 'backend'}`,
      version: options.version ?? backend.version ?? '1',
      kind: 'instrumentation',
      facets: ['instrumentation'],
      capabilities: {
        probes: typeof backend.installProbe === 'function',
        intercept: typeof backend.intercept === 'function' || typeof backend.installProbe === 'function',
        replace: typeof backend.replace === 'function',
        memoryRead: typeof backend.readMemory === 'function',
        memoryWrite: typeof backend.writeMemory === 'function',
        objcRuntime: typeof backend.getObjCRuntimeInfo === 'function',
        swiftRuntime: typeof backend.getSwiftRuntimeInfo === 'function',
        mutationRequiresAuthorization: true,
        ...options.capabilities,
      },
    });
  }

  descriptor() { return this._descriptor; }

  async #authorizeMutation(kind, details, callOptions = {}) {
    const direct = kind === 'function-replacement' ? this.options.allowReplacement === true : kind === 'memory-write' ? this.options.allowMemoryWrite === true : false;
    if (direct) return true;
    if (typeof this.options.authorizeMutation !== 'function') return false;
    return (await this.options.authorizeMutation({ kind, providerId: this._descriptor.id, details, context: callOptions.authorizationContext ?? null })) === true;
  }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'instrumentation provider already has an open session');
    let session;
    let unsubscribe = null;
    let connectedBySession = false;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        if (connectedBySession && typeof this.backend.disconnect === 'function') await this.backend.disconnect();
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} }
        unsubscribe = null;
        if (this.activeSession === session) this.activeSession = null;
      },
    });
    const normalizer = new RuntimeEventNormalizer({
      runtimeSessionId: session.runtimeSessionId,
      providerId: session.providerId,
      providerVersion: session.providerVersion,
      sessionEpoch: session.epoch,
      processKey: session.target.processKey,
      observationMode: 'observed',
    }, this.options.events || {});
    const interventions = new InterventionLedger();
    const probes = new Map();

    const ingest = (raw) => {
      const ownedRaw = materializeRuntimeEvent(raw);
      if (typeof this.options.eventFilter === 'function' && this.options.eventFilter(ownedRaw) === false) return null;
      const handle = eventProbeHandle(ownedRaw);
      const interventionId = handle == null ? null : probes.get(handle) ?? null;
      const existingInterventionIds = eventInterventionIds(ownedRaw);
      const enrichedRaw = interventionId && (existingInterventionIds == null || Array.isArray(existingInterventionIds))
        ? {
            ...ownedRaw,
            interventionIds: [...new Set([...(existingInterventionIds ?? []), interventionId])],
          }
        : ownedRaw;
      const event = normalizer.push(enrichedRaw);
      if (!event) return null;
      const module = moduleFields(event);
      if (event.kind === 'module-load' && (module.runtimeBase ?? module.base) != null && (module.runtimeSize ?? module.size) != null) {
        const bindingKey = module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name;
        if (bindingKey && !session.modules.get(bindingKey)) {
          session.modules.load(normalizeRuntimeModuleBinding(module, {
            bindingKey,
            loadedSequence: event.sequence,
          }));
        }
      } else if (event.kind === 'module-unload') {
        const bindingKey = module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name;
        if (bindingKey) session.modules.unload(bindingKey, event.sequence);
      }
      return event;
    };

    // Claim provider ownership before the first await. A second open must not
    // race through while this session is still connecting or enumerating.
    this.activeSession = session;
    try {
      if (options.connect !== false && typeof this.backend.connect === 'function') {
        connectedBySession = true;
        await this.backend.connect(options.connectOptions || request);
      }
      if (typeof this.backend.onEvent === 'function') {
        const maybe = this.backend.onEvent(ingest);
        if (maybe != null && typeof maybe !== 'function') throw new DebugAdapterError('event-subscription', 'instrumentation backend onEvent must return an unsubscribe function');
        unsubscribe = maybe || null;
      }
      if (typeof this.backend.getModules === 'function') {
        const modules = await this.backend.getModules();
        if (!Array.isArray(modules)) throw new DebugAdapterError('runtime-invalid-modules', 'instrumentation backend getModules must return an array');
        for (let i = 0; i < modules.length; i++) {
          const module = modules[i] || {};
          if ((module.runtimeBase ?? module.base) == null || (module.runtimeSize ?? module.size) == null) continue;
          const bindingKey = moduleKey(module, i);
          session.modules.load(normalizeRuntimeModuleBinding(module, { bindingKey }));
        }
      }
    } catch (error) {
      session.setState('failed');
      try { await session.close(); } catch {}
      throw error;
    }

    const instrumentation = Object.freeze({
      capabilities: this._descriptor.capabilities,
      installProbe: async (spec, callOptions = {}) => {
        const install = requiredMethod(this.backend, 'installProbe', 'probe installation');
        const draft = validateInterventionDraft(interventions, {
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'probe-install',
          target: spec,
          requestedChange: { install: true },
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        const result = await install(spec, callOptions);
        const intervention = interventions.add({ ...draft, acknowledgedResult: result });
        const handle = probeHandle(result);
        if (handle != null) probes.set(handle, intervention.interventionId);
        return { result, intervention };
      },
      removeProbe: async (handle, callOptions = {}) => {
        const remove = requiredMethod(this.backend, 'removeProbe', 'probe removal');
        const normalizedHandle = normalizeProbeHandle(handle);
        if (normalizedHandle == null) throw new DebugAdapterError('runtime-invalid-probe-handle', 'probe handle is required');
        const parent = probes.get(normalizedHandle);
        const draft = validateInterventionDraft(interventions, {
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'probe-remove',
          target: { handle: normalizedHandle },
          requestedChange: { remove: true },
          parentInterventionIds: [...new Set([...(callOptions.parentInterventionIds ?? []), ...(parent ? [parent] : [])])],
        });
        const result = await remove(handle, callOptions);
        const intervention = interventions.add({ ...draft, acknowledgedResult: result });
        probes.delete(normalizedHandle);
        return { result, intervention };
      },
      intercept: async (spec, callOptions = {}) => {
        const install = typeof this.backend.intercept === 'function'
          ? this.backend.intercept.bind(this.backend)
          : requiredMethod(this.backend, 'installProbe', 'interception');
        const draft = validateInterventionDraft(interventions, {
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'interceptor-install',
          target: spec,
          requestedChange: { install: true },
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        const result = await install(spec, callOptions);
        const intervention = interventions.add({ ...draft, acknowledgedResult: result });
        const handle = probeHandle(result);
        if (handle != null) probes.set(handle, intervention.interventionId);
        return { result, intervention };
      },
      replace: async (target, replacement, callOptions = {}) => {
        const authorized = await this.#authorizeMutation('function-replacement', { target, replacement }, callOptions);
        if (!authorized) throw new DebugAdapterError('permission-denied', 'instrumentation replacement requires provider-authorized mutation capability');
        const replace = requiredMethod(this.backend, 'replace', 'function replacement');
        const draft = validateInterventionDraft(interventions, {
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'function-replacement',
          target,
          requestedChange: replacement,
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        const result = await replace(target, replacement, callOptions);
        const intervention = interventions.add({ ...draft, acknowledgedResult: result });
        return { result, intervention };
      },
      readMemory: async (...args) => requiredMethod(this.backend, 'readMemory', 'memory read')(...args),
      writeMemory: async (address, bytes, callOptions = {}) => {
        const authorized = await this.#authorizeMutation('memory-write', { address, byteLength: bytes?.byteLength ?? bytes?.length ?? null }, callOptions);
        if (!authorized) throw new DebugAdapterError('permission-denied', 'instrumentation memory write requires provider-authorized mutation capability');
        const write = requiredMethod(this.backend, 'writeMemory', 'memory write');
        const draft = validateInterventionDraft(interventions, {
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'memory-write',
          target: { address },
          requestedChange: { bytes },
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        const result = await write(address, bytes, callOptions);
        const intervention = interventions.add({ ...draft, acknowledgedResult: result });
        return { result, intervention };
      },
      getObjCRuntimeInfo: async (...args) => requiredMethod(this.backend, 'getObjCRuntimeInfo', 'Objective-C runtime metadata')(...args),
      getSwiftRuntimeInfo: async (...args) => requiredMethod(this.backend, 'getSwiftRuntimeInfo', 'Swift runtime metadata')(...args),
      events: Object.freeze({ ingest, flush: () => normalizer.flush() }),
      interventions,
      resolveAddress: (runtimeAddress, resolutionOptions = {}) => session.modules.resolve(runtimeAddress, resolutionOptions),
    });
    session.facets = Object.freeze({ instrumentation });
    session.setState('ready');
    this.activeSession = session;
    let epochTransitionPending = false;
    const commitEpoch = (reason) => {
      const committed = session.newEpoch(reason);
      normalizer.resetEpoch(committed);
      return committed;
    };
    session.newProviderEpoch = (reason = 'instrumentation-provider-epoch-changed') => {
      if (session.closed) throw new DebugAdapterError('runtime-session-closed', 'runtime provider session is closed');
      if (epochTransitionPending) throw new DebugAdapterError('runtime-epoch-transition-active', 'instrumentation provider epoch transition is already in progress');
      const next = session.epoch + 1;
      if (typeof this.backend.setEpoch !== 'function') return commitEpoch(reason);
      epochTransitionPending = true;
      let backendResult;
      try {
        backendResult = this.backend.setEpoch(next);
      } catch (err) {
        epochTransitionPending = false;
        throw err;
      }
      if (!backendResult || typeof backendResult.then !== 'function') {
        epochTransitionPending = false;
        return commitEpoch(reason);
      }
      return Promise.resolve(backendResult)
        .then(() => commitEpoch(reason))
        .finally(() => { epochTransitionPending = false; });
    };
    return session;
  }
}

export function createInstrumentationProvider(backend, options = {}) {
  return new InstrumentationProvider(backend, options);
}
