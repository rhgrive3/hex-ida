import { DebugAdapterError } from '../debug/adapter.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { RuntimeEventNormalizer } from './events.js';
import { createInterventionRecord, InterventionLedger } from './evidence-bridge.js';
import { normalizeRuntimeModuleBinding } from './module-binding.js';

function requiredMethod(backend, method, capability) {
  if (typeof backend?.[method] !== 'function') throw new DebugAdapterError('unsupported', `instrumentation backend does not support ${capability || method}`);
  return backend[method].bind(backend);
}

function validateInterventionDraft(ledger, input) {
  const record = createInterventionRecord(input);
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
  return normalizeProbeHandle(raw?.probeHandle ?? raw?.handle ?? raw?.payload?.probeHandle ?? raw?.payload?.handle ?? null);
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
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} }
        unsubscribe = null;
        try { if (typeof this.backend.disconnect === 'function') await this.backend.disconnect(); }
        finally { if (this.activeSession === session) this.activeSession = null; }
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
      if (typeof this.options.eventFilter === 'function' && this.options.eventFilter(raw) === false) return null;
      const handle = eventProbeHandle(raw);
      const interventionId = handle == null ? null : probes.get(handle) ?? null;
      if (!interventionId) return normalizer.push(raw);
      const existing = Array.isArray(raw?.interventionIds) ? raw.interventionIds : [];
      return normalizer.push({ ...raw, interventionIds: [...new Set([...existing, interventionId])] });
    };

    try {
      if (options.connect !== false && typeof this.backend.connect === 'function') await this.backend.connect(options.connectOptions || request);
      if (typeof this.backend.onEvent === 'function') {
        const maybe = this.backend.onEvent(ingest);
        if (maybe != null && typeof maybe !== 'function') throw new DebugAdapterError('event-subscription', 'instrumentation backend onEvent must return an unsubscribe function');
        unsubscribe = maybe || null;
      }
      if (typeof this.backend.getModules === 'function') {
        const modules = await this.backend.getModules();
        for (let i = 0; i < (Array.isArray(modules) ? modules.length : 0); i++) {
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
    session.newProviderEpoch = (reason = 'instrumentation-provider-epoch-changed') => {
      const next = session.newEpoch(reason);
      normalizer.resetEpoch(next);
      if (typeof this.backend.setEpoch === 'function') this.backend.setEpoch(next);
      return next;
    };
    return session;
  }
}

export function createInstrumentationProvider(backend, options = {}) {
  return new InstrumentationProvider(backend, options);
}