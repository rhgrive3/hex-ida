import { stableDigest } from '../../core/identity/index.js';

const ABI_PLUGINS = new Map();
const ABI_REGISTRY_BINDINGS = new WeakMap();
const APPLE_ARM64E_PLATFORMS = new Set([
  'apple', 'darwin', 'macos', 'macosx', 'ios', 'ios-simulator', 'ipados',
  'tvos', 'watchos', 'visionos',
]);

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }
function frozenArray(value) { return Object.freeze(Array.isArray(value) ? value.slice() : []); }

function canonicalCallingConvention(value) {
  return canonicalId(value).replace(/^__/, '');
}

function claimedCallingConventions(plugin) {
  try {
    return frozenArray(plugin?.callingConventions?.())
      .map(canonicalCallingConvention)
      .filter(Boolean);
  } catch {
    return Object.freeze([]);
  }
}

export class ABIPlugin {
  constructor(definition = {}) {
    const id = canonicalId(definition.id);
    if (!id) throw new TypeError('ABI id is required');
    const architectureId = canonicalId(definition.architectureId);
    if (!architectureId) throw new TypeError(`ABI ${id} architectureId is required`);

    this.id = id;
    this.semanticVersion = String(definition.semanticVersion || '1');
    this.semanticIdentity = String(definition.semanticIdentity || `${id}@${this.semanticVersion}`);
    this.architectureId = architectureId;
    this.platformPredicate = typeof definition.platformPredicate === 'function'
      ? definition.platformPredicate
      : (() => true);
    this.callingConventions = definition.callingConventions || (() => frozenArray([]));
    this.classifyArguments = definition.classifyArguments || (() => ({
      srcs: [], arguments: [], stackArguments: [], stackArgsUnknown: true,
      stackArgsMayContainPointers: true, evidence: 'unsupported-abi', unsupported: true,
    }));
    this.classifyCallReturn = definition.classifyCallReturn || (() => null);
    this.classifyFunctionReturn = definition.classifyFunctionReturn || (() => null);
    this.classifyEntryRegister = definition.classifyEntryRegister || (() => ({ kind:'incoming-register-state' }));
    this.callerSaved = definition.callerSaved || (() => frozenArray([]));
    this.calleeSaved = definition.calleeSaved || (() => frozenArray([]));
    this.stackRules = definition.stackRules || (() => Object.freeze({ unknown:true }));
    this.redZone = definition.redZone || (() => null);
    this.syscallABI = definition.syscallABI || null;
    this.unwindRules = definition.unwindRules || (() => Object.freeze({ unknown:true }));
    this.defaultUnknownCallEffects = definition.defaultUnknownCallEffects || (() => Object.freeze({
      registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true,
    }));
    this.supported = definition.supported !== false;
    Object.freeze(this);
  }
}

function registryDescriptor(plugin) {
  return {
    id:plugin?.id ?? null,
    semanticVersion:plugin?.semanticVersion ?? null,
    semanticIdentity:plugin?.semanticIdentity ?? null,
    architectureId:plugin?.architectureId ?? null,
    supported:plugin?.supported !== false,
    callingConventions:claimedCallingConventions(plugin),
  };
}

export function abiPluginRegistryDigest(plugin) {
  const binding = plugin && typeof plugin === 'object' ? ABI_REGISTRY_BINDINGS.get(plugin) : null;
  return binding?.digest ?? null;
}

/*
 * Registry membership is object identity, not a matching set of public fields.
 * A plugin-like object can copy an id/version/classifier and still be a
 * different implementation, so only the exact frozen object registered here
 * may cross the canonical ABI boundary.
 */
export function isRegisteredABIPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return false;
  const binding = ABI_REGISTRY_BINDINGS.get(plugin);
  return !!binding && ABI_PLUGINS.get(binding.id) === plugin
    && binding.digest === `abi-registry:${stableDigest(registryDescriptor(plugin))}`;
}

export function registerABIPlugin(definition, { replace = false } = {}) {
  const plugin = definition instanceof ABIPlugin ? definition : new ABIPlugin(definition);
  // A duplicate object may not silently steal publication.  An explicit
  // replacement is allowed for registry lifecycle tooling, but it makes the
  // previous object non-canonical immediately: isRegisteredABIPlugin() checks
  // the map's exact object identity as well as each object's digest.
  if (ABI_PLUGINS.has(plugin.id) && !replace) {
    throw new Error(`ABI already registered: ${plugin.id}`);
  }
  ABI_PLUGINS.set(plugin.id, plugin);
  ABI_REGISTRY_BINDINGS.set(plugin, {
    id:plugin.id,
    digest:`abi-registry:${stableDigest(registryDescriptor(plugin))}`,
  });
  return plugin;
}

export function abiPlugin(id) {
  return ABI_PLUGINS.get(canonicalId(id)) || ABI_PLUGINS.get('unknown') || null;
}

export function abiPlugins() { return Object.freeze(Array.from(ABI_PLUGINS.values())); }

export function abiPluginClaimsCallingConvention(plugin, callingConvention = null) {
  const requested = canonicalCallingConvention(callingConvention);
  if (!requested) return true;
  const claims = claimedCallingConventions(plugin);
  return claims.some((claim) => claim === requested);
}

export function findABIPlugin({ id = null, architecture = null, platform = null, callingConvention = null } = {}) {
  if (id) {
    const explicit = abiPlugin(id);
    if (!explicit || explicit.id === 'unknown') return explicit;
    return abiPluginClaimsCallingConvention(explicit, callingConvention) ? explicit : abiPlugin('unknown');
  }
  const arch = canonicalId(architecture);
  const platformId = canonicalId(platform);
  // arm64e is not enough to choose an ABI.  In particular, silently treating
  // an architecture-only arm64e target as AAPCS64 would invent register and
  // aggregate placement facts for non-Apple binaries.
  if (arch === 'arm64e' && !APPLE_ARM64E_PLATFORMS.has(platformId)) return abiPlugin('unknown');
  // An architecture name is not an ABI identity. Require either an explicit
  // registered calling convention or a platform-qualified architecture before
  // selecting a profile; otherwise arm64/x86_64/riscv64 would silently pick a
  // registry default.
  if (!arch || (!platformId && !callingConvention)) return abiPlugin('unknown');
  for (const plugin of ABI_PLUGINS.values()) {
    if (!plugin.supported || plugin.id === 'unknown') continue;
    if (arch && plugin.architectureId !== arch && !(arch === 'arm64e' && plugin.architectureId === 'arm64')) continue;
    let matches = false;
    try { matches = plugin.platformPredicate({ architecture:arch, platform:platformId }); } catch { matches = false; }
    if (!matches) continue;
    if (!abiPluginClaimsCallingConvention(plugin, callingConvention)) continue;
    return plugin;
  }
  return abiPlugin('unknown');
}
