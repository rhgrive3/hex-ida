from pathlib import Path

path = Path('js/analysis/alias/canonical-address-v2-core.js')
source = path.read_text()

def replace_once(old, new):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one canonical replacement, got {count}: {old[:80]!r}')
    source = source.replace(old, new, 1)

replace_once(
    "const ROOT_KINDS = new Set(GENERIC_ROOT_DESCRIPTOR_KINDS);\nconst MAX_DERIVATION_DEPTH = 128;\n",
    """const ROOT_KINDS = new Set(GENERIC_ROOT_DESCRIPTOR_KINDS);
const MAX_DERIVATION_DEPTH = 128;
const INVALID_ROOT_DESCRIPTOR = Symbol('invalid-root-descriptor');

function identityString(value, { trim = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return trim ? value.trim() : value;
}

function allIdentityStrings(values) {
  return Array.isArray(values) && values.every((value) => identityString(value) != null);
}

function identityGraphIsValid(ir, options) {
  if (identityString(ir.functionId) == null) return false;
  const values = Array.isArray(ir.values) ? ir.values : [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const blocks = Array.isArray(ir.blocks) ? ir.blocks : [];
  const valueIds = new Set();
  for (const value of values) {
    const id = identityString(value?.id);
    if (id == null || valueIds.has(id)) return false;
    valueIds.add(id);
    if (value.definitionNodeId != null && identityString(value.definitionNodeId) == null) return false;
    if (value.variableKey != null && identityString(value.variableKey) == null) return false;
  }
  const nodeIds = new Set();
  for (const node of nodes) {
    const id = identityString(node?.id);
    if (id == null || nodeIds.has(id)) return false;
    nodeIds.add(id);
    if (node.inputs != null && !allIdentityStrings(node.inputs)) return false;
    if (node.outputs != null && !allIdentityStrings(node.outputs)) return false;
    if (node.variable?.key != null && identityString(node.variable.key) == null) return false;
  }
  const blockIds = new Set();
  for (const block of blocks) {
    const id = identityString(block?.id);
    if (id == null || blockIds.has(id) || !allIdentityStrings(block.nodeIds ?? [])) return false;
    blockIds.add(id);
  }
  const ssaDefinitions = Array.isArray(options.ssa?.definitions) ? options.ssa.definitions : [];
  const ssaValueIds = new Set();
  for (const definition of ssaDefinitions) {
    const id = identityString(definition?.valueId);
    if (id == null || ssaValueIds.has(id)) return false;
    ssaValueIds.add(id);
    if (definition.variableKey != null && identityString(definition.variableKey) == null) return false;
    if (definition.proof?.sourceSemanticValueId != null && identityString(definition.proof.sourceSemanticValueId) == null) return false;
    if (definition.proof?.variableIdentity?.key != null && identityString(definition.proof.variableIdentity.key) == null) return false;
    for (const incoming of definition.incoming ?? []) if (identityString(incoming?.valueId) == null) return false;
  }
  for (const use of options.ssa?.uses ?? []) {
    if (identityString(use?.sourceEntityId) == null || identityString(use?.valueId) == null) return false;
    const variableKey = use.proof?.variableIdentity?.key ?? use.proof?.sourceVariableKey;
    if (variableKey != null && identityString(variableKey) == null) return false;
  }
  return true;
}
"""
)

replace_once(
    """export function normalizeRootIdentity(variable, functionId) {
  const identity = {
    kind: 'semantic-state-root',
    functionId: String(functionId),
    variable: {
      key: String(variable?.key ?? ''),
      kind: String(variable?.kind ?? 'unknown-state'),
      scope: String(variable?.scope ?? 'unknown'),
      ...(variable?.physicalIdentity == null ? {} : { physicalIdentity: jsonSafe(variable.physicalIdentity) }),
    },
  };
  return deepFreeze(identity);
}

export function defaultRootEntityId(rootIdentity) {
  return `entity_memory_root_${stableDigest({
""",
    """export function normalizeRootIdentity(variable, functionId) {
  const normalizedFunctionId = identityString(functionId);
  const variableKey = identityString(variable?.key);
  const variableKind = variable?.kind == null ? 'unknown-state' : identityString(variable.kind);
  const variableScope = variable?.scope == null ? 'unknown' : identityString(variable.scope);
  if (normalizedFunctionId == null || variableKey == null || variableKind == null || variableScope == null) return null;
  const identity = {
    kind: 'semantic-state-root',
    functionId: normalizedFunctionId,
    variable: {
      key: variableKey,
      kind: variableKind,
      scope: variableScope,
      ...(variable?.physicalIdentity == null ? {} : { physicalIdentity: jsonSafe(variable.physicalIdentity) }),
    },
  };
  return deepFreeze(identity);
}

export function defaultRootEntityId(rootIdentity) {
  if (!rootIdentity || typeof rootIdentity !== 'object' || Array.isArray(rootIdentity)) return null;
  return `entity_memory_root_${stableDigest({
"""
)

replace_once(
    """  const kind = String(input.kind ?? '');
  if (!ROOT_KINDS.has(kind)) return null;
  const addressSpace = input.addressSpace == null ? null : String(input.addressSpace);
""",
    """  const kind = identityString(input.kind);
  if (kind == null || !ROOT_KINDS.has(kind)) return null;
  const addressSpace = input.addressSpace == null ? null : identityString(input.addressSpace);
  if (input.addressSpace != null && addressSpace == null) return null;
"""
)
replace_once(
    """    const rootEntityId = input.rootEntityId == null ? null : String(input.rootEntityId).trim();
    if (input.rootEntityId != null && !rootEntityId) return null;
""",
    """    const rootEntityId = input.rootEntityId == null ? null : identityString(input.rootEntityId, { trim: true });
    if (input.rootEntityId != null && rootEntityId == null) return null;
"""
)
replace_once(
    """  for (const candidate of semanticDescriptorCandidates(value, node, variable)) {
    const normalized = normalizeGenericDescriptor(candidate);
    if (normalized) return normalized;
  }
""",
    """  for (const candidate of semanticDescriptorCandidates(value, node, variable)) {
    const normalized = normalizeGenericDescriptor(candidate);
    return normalized ?? INVALID_ROOT_DESCRIPTOR;
  }
"""
)
replace_once(
    """  const fromTable = normalizeGenericDescriptor(descriptorLookup(ctx.options.rootDescriptors, keys));
  if (fromTable) return fromTable;
""",
    """  const rawFromTable = descriptorLookup(ctx.options.rootDescriptors, keys);
  if (rawFromTable != null) return normalizeGenericDescriptor(rawFromTable) ?? INVALID_ROOT_DESCRIPTOR;
"""
)
replace_once(
    "  return normalizeGenericDescriptor(raw);\n}\n\nfunction rootFromDescriptor",
    "  if (raw == null) return null;\n  return normalizeGenericDescriptor(raw) ?? INVALID_ROOT_DESCRIPTOR;\n}\n\nfunction rootFromDescriptor"
)
replace_once(
    "function rootFromDescriptor(descriptor, fallbackIdentity, expectedAddressSpace, widthBits) {\n  if (!descriptor) return null;\n",
    "function rootFromDescriptor(descriptor, fallbackIdentity, expectedAddressSpace, widthBits) {\n  if (descriptor === INVALID_ROOT_DESCRIPTOR) return unknown('canonical-root-descriptor-invalid');\n  if (!descriptor) return null;\n"
)
replace_once(
    "function entryRoot(ctx, value, node, variable, expectedAddressSpace) {\n  const identity = normalizeRootIdentity(variable, ctx.ir.functionId);\n",
    "function entryRoot(ctx, value, node, variable, expectedAddressSpace) {\n  const identity = normalizeRootIdentity(variable, ctx.ir.functionId);\n  if (identity == null) return unknown('canonical-address-root-identity-invalid');\n"
)
replace_once(
    """export function deriveCanonicalAddressProof(ir, addressValueId, options = {}) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return unknown('canonical-address-ir-required');
  if (addressValueId == null) return unknown('canonical-address-value-id-required');
  const ctx = buildContext(ir, options);
  const expectedAddressSpace = options.addressSpace == null ? 'memory' : String(options.addressSpace);
  let proof = deriveValue(ctx, String(addressValueId), expectedAddressSpace, { visiting: new Set(), depth: 0 });
""",
    """export function deriveCanonicalAddressProof(ir, addressValueId, options = {}) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return unknown('canonical-address-ir-required');
  if (addressValueId == null) return unknown('canonical-address-value-id-required');
  const normalizedAddressValueId = identityString(addressValueId);
  if (normalizedAddressValueId == null || !identityGraphIsValid(ir, options)) return unknown('canonical-address-identity-invalid');
  const expectedAddressSpace = options.addressSpace == null ? 'memory' : identityString(options.addressSpace);
  if (expectedAddressSpace == null) return unknown('canonical-address-address-space-invalid');
  const ctx = buildContext(ir, options);
  let proof = deriveValue(ctx, normalizedAddressValueId, expectedAddressSpace, { visiting: new Set(), depth: 0 });
"""
)
path.write_text(source)

pointsto = Path('js/analysis/pointsto/local.js')
text = pointsto.read_text()

def replace_pointsto(old, new):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one points-to replacement, got {count}: {old[:80]!r}')
    text = text.replace(old, new, 1)

replace_pointsto(
    "  const identity = normalizeRootIdentity(variable, functionId);\n  const semanticValue",
    "  const identity = normalizeRootIdentity(variable, functionId);\n  if (identity == null) return null;\n  const semanticValue"
)
replace_pointsto(
    """      if (definition.proof?.kind === 'implicit-undef') {
        return createPointsToSet({ targets: [entryRootTarget(definition, functionId, values)] });
      }
""",
    """      if (definition.proof?.kind === 'implicit-undef') {
        const target = entryRootTarget(definition, functionId, values);
        return target == null ? topPointsTo('unsupported-operation') : createPointsToSet({ targets: [target] });
      }
"""
)
replace_pointsto(
    """    if (definition.kind === 'entry') {
      return createPointsToSet({ targets: [entryRootTarget(definition, functionId, values)] });
    }
""",
    """    if (definition.kind === 'entry') {
      const target = entryRootTarget(definition, functionId, values);
      return target == null ? topPointsTo('unsupported-operation') : createPointsToSet({ targets: [target] });
    }
"""
)
pointsto.write_text(text)
