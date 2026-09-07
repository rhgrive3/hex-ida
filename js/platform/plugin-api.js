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

export class PlatformPluginRegistry extends CorePlatformPluginRegistry {
  constructor(options = {}) {
    // Snapshot the explicit authority once before delegating. The core
    // constructor must not get a second chance to read a stateful getter and
    // silently replace a validated value with its fallback.
    const timeoutMs = options?.timeoutMs;
    validateExplicitPositiveInteger(timeoutMs, 'plugin timeoutMs');
    super({ timeoutMs });
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
    const hasRawOptions = args.length > 0 && args.at(-1) && typeof args.at(-1) === 'object';
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

    // Pass only the owned snapshots to the core. This keeps its existing
    // permission, budget and timeout semantics while preventing a second read
    // from caller-owned policy/options objects.
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
    return super.invoke(type, id, method, contextSnapshot, ...normalizedArgs);
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
