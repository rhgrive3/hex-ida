const ARCHITECTURES = new Map();

export function canonicalArchitectureId(value) {
  /* #2788: architecture identity selects decoder/effects capability. Only real
     strings may become a canonical id; arrays/objects with toString() must not
     collide with a registered plugin identity. */
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}
export function normalizeArchitecturePositiveInteger(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive integer`);
  }
  return value;
}

function normalizeArchitectureHook(value, name, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function normalizeArchitectureSemanticVersion(value) {
  if (value == null) return '1';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('architecture semanticVersion must be a non-empty string');
  }
  return value;
}

export class ArchitecturePluginV2 {
  constructor(definition = {}) {
    const id = canonicalArchitectureId(definition.id);
    if (!id) throw new TypeError('architecture id is required');
    this.id = id;
    this.semanticVersion = normalizeArchitectureSemanticVersion(definition.semanticVersion);
    this.modes = normalizeArchitectureHook(definition.modes, 'modes', () => Object.freeze([]));
    this.registerFile = normalizeArchitectureHook(definition.registerFile, 'registerFile', () => Object.freeze([]));
    this.physicalAddressSpaces = normalizeArchitectureHook(definition.physicalAddressSpaces, 'physicalAddressSpaces', () => Object.freeze(['register','memory','code','unique']));
    this.decode = normalizeArchitectureHook(definition.decode, 'decode');
    this.decodeProvider = definition.decodeProvider || null;
    this.liftExact = normalizeArchitectureHook(definition.liftExact, 'liftExact');
    this.classifyControlFlow = normalizeArchitectureHook(definition.classifyControlFlow, 'classifyControlFlow', () => null);
    this.directControlTarget = normalizeArchitectureHook(definition.directControlTarget, 'directControlTarget', () => null);
    this.assemble = normalizeArchitectureHook(definition.assemble, 'assemble');
    this.validateEncoding = normalizeArchitectureHook(definition.validateEncoding, 'validateEncoding');
    this.supportedMemoryEndianness = Object.freeze([...new Set(
      (Array.isArray(definition.supportedMemoryEndianness) ? definition.supportedMemoryEndianness : [])
        .map((value) => canonicalArchitectureId(value)).filter(Boolean)
    )]);
    this.supportedInstructionEndianness = Object.freeze([...new Set(
      (Array.isArray(definition.supportedInstructionEndianness) ? definition.supportedInstructionEndianness : [])
        .map((value) => canonicalArchitectureId(value)).filter(Boolean)
    )]);
    this.instructionAlignment = normalizeArchitecturePositiveInteger(definition.instructionAlignment ?? 1, 'instructionAlignment');
    this.fixedInstructionSize = normalizeArchitecturePositiveInteger(definition.fixedInstructionSize, 'fixedInstructionSize', { nullable:true });
    this.viewerCompatible = !!definition.viewerCompatible;
    this.capabilities = Object.freeze({
      decode: definition.capabilities?.decode || (this.decode ? 'native' : this.decodeProvider ? 'external' : 'unsupported'),
      exactEffects: definition.capabilities?.exactEffects || (this.liftExact ? 'available' : 'unsupported'),
      semanticAnalysis: definition.capabilities?.semanticAnalysis || 'unsupported',
    });
    Object.freeze(this);
  }
}

export function registerArchitecturePlugin(definition, { replace = false } = {}) {
  const plugin = definition instanceof ArchitecturePluginV2 ? definition : new ArchitecturePluginV2(definition);
  if (ARCHITECTURES.has(plugin.id) && !replace) throw new Error(`architecture already registered: ${plugin.id}`);
  ARCHITECTURES.set(plugin.id, plugin);
  return plugin;
}

export function architecturePluginV2(id) {
  return ARCHITECTURES.get(canonicalArchitectureId(id)) || ARCHITECTURES.get('unknown') || null;
}

export function architecturePluginsV2() { return Object.freeze(Array.from(ARCHITECTURES.values())); }
