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

export class PlatformPluginRegistry extends CorePlatformPluginRegistry {
  constructor(options = {}) {
    validateExplicitPositiveInteger(options?.timeoutMs, 'plugin timeoutMs');
    super(options);
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
    try {
      const policy = context?.pluginPolicy || context?.pluginPermissions || {};
      validateExplicitPositiveInteger(policy.maxReadBytes, 'plugin maxReadBytes');
      validateExplicitPositiveInteger(policy.maxTotalReadBytes, 'plugin maxTotalReadBytes');
      const rawOptions = args.at(-1) && typeof args.at(-1) === 'object' ? args.at(-1) : {};
      validateExplicitPositiveInteger(rawOptions.timeoutMs, 'plugin timeoutMs');
    } catch (error) {
      return invocationFailure(this, type, id, method, error);
    }
    return super.invoke(type, id, method, context, ...args);
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
