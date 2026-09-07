import {
  PlatformPluginRegistry as CorePlatformPluginRegistry,
  PluginCompatibilityError,
} from './plugin-api-core.js';

function validateExplicitPositiveInteger(value, name) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function snapshotRecord(value, overrides = {}) {
  if (!value || typeof value !== 'object') return value;
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    let item;
    try {
      item = Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : value[key];
    } catch {
      throw new TypeError('plugin option snapshot invalid');
    }
    Object.defineProperty(out, key, {
      value: item,
      enumerable: descriptor.enumerable,
      writable: true,
      configurable: true,
    });
  }
  for (const [key, item] of Reflect.ownKeys(overrides).map((key) => [key, overrides[key]])) {
    Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function invocationFailure(registry, type, id, method, error) {
  const failure = {
    type,
    id,
    method,
    error: error?.message || String(error),
    at: Date.now(),
  };
  registry.failures.push(failure);
  if (registry.failures.length > 100) registry.failures.shift();
  return { ok: false, error: failure.error, isolated: true, timeout: false };
}

function createInvocationLease(context) {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error('plugin invocation is no longer active');
  };

  const guardBudget = (budget) => {
    if (!budget || (typeof budget !== 'object' && typeof budget !== 'function')) return budget;
    return new Proxy(budget, {
      get(target, property) {
        assertActive();
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          assertActive();
          const result = Reflect.apply(value, target, args);
          return property === 'scope' ? guardBudget(result) : result;
        };
      },
    });
  };

  const guarded = {
    ...context,
    resourceBudget: guardBudget(context?.resourceBudget),
  };

  if (typeof context?.read === 'function') {
    guarded.read = async (...args) => {
      assertActive();
      const value = await context.read(...args);
      assertActive();
      return value;
    };
  }

  if (typeof context?.reportProgress === 'function') {
    guarded.reportProgress = (...args) => {
      assertActive();
      return context.reportProgress(...args);
    };
  }

  return {
    context: guarded,
    revoke() { active = false; },
  };
}

export class PlatformPluginRegistry extends CorePlatformPluginRegistry {
  constructor(options = {}) {
    // Snapshot the explicit authority once before delegating. The core
    // constructor must not get a second chance to read a stateful getter and
    // silently replace a validated value with its fallback.
    const timeoutMs = options?.timeoutMs;
    validateExplicitPositiveInteger(timeoutMs, 'plugin timeoutMs');
    super({ timeoutMs });
  }

  #guardRegistration(type, id, register) {
    const dispose = register();
    const record = this.entries.get(type)?.get(id);
    return () => {
      if (record && this.entries.get(type)?.get(id) === record) dispose();
    };
  }

  registerFormat(id, contribution) {
    return this.#guardRegistration('format', id, () => super.registerFormat(id, contribution));
  }

  registerArchitecture(id, contribution) {
    return this.#guardRegistration('architecture', id, () => super.registerArchitecture(id, contribution));
  }

  registerKnowledgeProvider(id, contribution) {
    return this.#guardRegistration('knowledgeProvider', id, () => super.registerKnowledgeProvider(id, contribution));
  }

  registerSignatureProvider(id, contribution) {
    return this.#guardRegistration('signatureProvider', id, () => super.registerSignatureProvider(id, contribution));
  }

  registerRecognitionProvider(id, contribution) {
    return this.#guardRegistration('recognitionProvider', id, () => super.registerRecognitionProvider(id, contribution));
  }

  registerViewContribution(id, contribution) {
    return this.#guardRegistration('viewContribution', id, () => super.registerViewContribution(id, contribution));
  }

  registerGoalProvider(id, contribution) {
    return this.#guardRegistration('goalProvider', id, () => super.registerGoalProvider(id, contribution));
  }

  registerPlugin(rawManifest, implementations = {}) {
    super.registerPlugin(rawManifest, implementations);
    const pluginRecord = [...this.plugins.values()].at(-1);
    const registered = (pluginRecord?.manifest?.contributions || []).map((contribution) => ({
      type: contribution.type,
      id: contribution.id,
      record: this.entries.get(contribution.type)?.get(contribution.id),
    }));

    return () => {
      for (const { type, id, record } of registered) {
        const bucket = this.entries.get(type);
        if (record && bucket?.get(id) === record) bucket.delete(id);
      }
      if (pluginRecord && this.plugins.get(pluginRecord.id) === pluginRecord) {
        this.plugins.delete(pluginRecord.id);
      }
    };
  }

  async invoke(type, id, method, context = {}, ...args) {
    const policySource = context?.pluginPolicy || context?.pluginPermissions || {};
    const policy = snapshotRecord(policySource, {
      binaryRead: policySource?.binaryRead,
      readBinary: policySource?.readBinary,
      readRanges: policySource?.readRanges,
      ranges: policySource?.ranges,
      maxReadBytes: policySource?.maxReadBytes,
      maxTotalReadBytes: policySource?.maxTotalReadBytes,
    });
    const hasRawOptions = args.length > 0
      && args.at(-1)
      && typeof args.at(-1) === 'object'
      && !Array.isArray(args.at(-1));
    const rawOptions = hasRawOptions ? args.at(-1) : {};
    const optionSnapshot = hasRawOptions
      ? snapshotRecord(rawOptions, { timeoutMs: rawOptions.timeoutMs })
      : {};
    try {
      validateExplicitPositiveInteger(policy.maxReadBytes, 'plugin maxReadBytes');
      validateExplicitPositiveInteger(policy.maxTotalReadBytes, 'plugin maxTotalReadBytes');
      validateExplicitPositiveInteger(optionSnapshot.timeoutMs, 'plugin timeoutMs');
    } catch (error) {
      return invocationFailure(this, type, id, method, error);
    }

    // Pass only owned snapshots to the core. The invocation lease still
    // revokes host-facing capabilities after timeout/abort, while the
    // snapshots prevent a second read from caller-owned authority objects.
    const contextSnapshot = {
      binary: context?.binary,
      capability: context?.capability,
      project: context?.project,
      read: context?.read,
      pluginPolicy: policy,
      resourceBudget: context?.resourceBudget,
      reportProgress: context?.reportProgress,
    };
    const normalizedArgs = args.slice();
    if (hasRawOptions) normalizedArgs[normalizedArgs.length - 1] = optionSnapshot;
    const lease = createInvocationLease(contextSnapshot);
    try {
      return await super.invoke(type, id, method, lease.context, ...normalizedArgs);
    } finally {
      lease.revoke();
    }
  }
}

export const platformPlugins = new PlatformPluginRegistry();
export const registerFormat = (...args) => platformPlugins.registerFormat(...args);
export const registerArchitecture = (...args) => platformPlugins.registerArchitecture(...args);
export const registerAnalyzer = (...args) => platformPlugins.registerAnalyzer(...args);
export const registerKnowledgeProvider = (...args) => platformPlugins.registerKnowledgeProvider(...args);
export const registerSignatureProvider = (...args) => platformPlugins.registerSignatureProvider(...args);
export const registerRecognitionProvider = (...args) => platformPlugins.registerRecognitionProvider(...args);
export const registerViewContribution = (...args) => platformPlugins.registerViewContribution(...args);
export const registerGoalProvider = (...args) => platformPlugins.registerGoalProvider(...args);
export { PluginCompatibilityError };
