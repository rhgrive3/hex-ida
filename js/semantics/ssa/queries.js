function requireArray(value, code) {
  if (!Array.isArray(value)) throw new TypeError(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}
function exactStringOrNull(value) {
  return typeof value === 'string' ? value : null;
}
function definitions(ssa) { return requireArray(ssa?.definitions, 'semantic-ssa-query-invalid-definitions'); }
function uses(ssa) { return requireArray(ssa?.uses, 'semantic-ssa-query-invalid-uses'); }

export function getSsaDefinition(ssa, valueId) {
  const id = nonEmpty(valueId, 'semantic-ssa-query-value-id-required');
  return definitions(ssa).find((definition) => definition.valueId === id) ?? null;
}

export function getSsaDefinitionById(ssa, definitionId) {
  const id = nonEmpty(definitionId, 'semantic-ssa-query-definition-id-required');
  return definitions(ssa).find((definition) => definition.definitionId === id) ?? null;
}

export function getSsaUse(ssa, useId) {
  const id = nonEmpty(useId, 'semantic-ssa-query-use-id-required');
  return uses(ssa).find((use) => use.useId === id) ?? null;
}

export function getDefinitionForUse(ssa, useOrId) {
  const use = typeof useOrId === 'string' ? getSsaUse(ssa, useOrId) : useOrId;
  if (!use) return null;
  return getSsaDefinition(ssa, use.valueId);
}

export function getUsesForDefinition(ssa, definitionOrId) {
  const definition = typeof definitionOrId === 'string'
    ? getSsaDefinitionById(ssa, definitionOrId) ?? getSsaDefinition(ssa, definitionOrId)
    : definitionOrId;
  if (!definition) return Object.freeze([]);
  return Object.freeze(uses(ssa).filter((use) => use.valueId === definition.valueId).slice().sort((a, b) => a.useId.localeCompare(b.useId)));
}

export function getUsesForValue(ssa, valueId) {
  const definition = getSsaDefinition(ssa, valueId);
  return definition ? getUsesForDefinition(ssa, definition) : Object.freeze([]);
}

export function getDefinitionsForVariable(ssa, variableKey) {
  const key = nonEmpty(variableKey, 'semantic-ssa-query-variable-key-required');
  return Object.freeze(definitions(ssa).filter((definition) => definition.variableKey === key).slice().sort((a, b) =>
    String(a.blockId ?? '').localeCompare(String(b.blockId ?? '')) || a.valueId.localeCompare(b.valueId)));
}

export function getPhiDefinitions(ssa, blockId = null) {
  const id = blockId == null ? null : nonEmpty(blockId, 'semantic-ssa-query-block-id-required');
  return Object.freeze(definitions(ssa).filter((definition) => definition.kind === 'phi' && (id == null || definition.blockId === id))
    .slice().sort((a, b) => a.valueId.localeCompare(b.valueId)));
}

export function getPhiIncoming(ssa, phiValueId, predecessorBlockId) {
  const phi = getSsaDefinition(ssa, phiValueId);
  if (!phi || phi.kind !== 'phi') return null;
  const predecessor = nonEmpty(predecessorBlockId, 'semantic-ssa-query-predecessor-required');
  const incoming = phi.incoming.find((item) => item.predecessorBlockId === predecessor);
  if (!incoming) return null;
  return Object.freeze({ ...incoming, definition: getSsaDefinition(ssa, incoming.valueId) });
}

export function getSsaUsesForSourceEntity(ssa, sourceEntityId) {
  const id = nonEmpty(sourceEntityId, 'semantic-ssa-query-source-entity-required');
  return Object.freeze(uses(ssa).filter((use) => use.sourceEntityId === id).slice().sort((a, b) => a.useId.localeCompare(b.useId)));
}

export function getSsaUseForSemanticValue(ssa, semanticValueId) {
  const id = nonEmpty(semanticValueId, 'semantic-ssa-query-semantic-value-required');
  return uses(ssa).find((use) => use.proof?.sourceSemanticValueId === id) ?? null;
}

export function getSsaDefinitionForSemanticValue(ssa, semanticValueId) {
  const id = nonEmpty(semanticValueId, 'semantic-ssa-query-semantic-value-required');
  return definitions(ssa).find((definition) => definition.proof?.sourceSemanticValueId === id) ?? null;
}

export function createSsaQueryIndex(ssa) {
  const definitionByValue = new Map(definitions(ssa).map((definition) => [definition.valueId, definition]));
  const definitionById = new Map(definitions(ssa).map((definition) => [definition.definitionId, definition]));
  const useById = new Map(uses(ssa).map((use) => [use.useId, use]));
  const usesByValue = new Map();
  for (const use of uses(ssa)) {
    const list = usesByValue.get(use.valueId) ?? [];
    list.push(use);
    usesByValue.set(use.valueId, list);
  }
  return Object.freeze({
    definition(valueId) {
      const id = exactStringOrNull(valueId);
      return id == null ? null : definitionByValue.get(id) ?? null;
    },
    definitionById(definitionId) {
      const id = exactStringOrNull(definitionId);
      return id == null ? null : definitionById.get(id) ?? null;
    },
    use(useId) {
      const id = exactStringOrNull(useId);
      return id == null ? null : useById.get(id) ?? null;
    },
    definitionForUse(useId) {
      const id = exactStringOrNull(useId);
      if (id == null) return null;
      const use = useById.get(id);
      return use ? definitionByValue.get(use.valueId) ?? null : null;
    },
    usesForValue(valueId) {
      const id = exactStringOrNull(valueId);
      return Object.freeze((id == null ? [] : usesByValue.get(id) ?? []).slice().sort((a, b) => a.useId.localeCompare(b.useId)));
    },
  });
}
