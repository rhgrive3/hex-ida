import { isCanonicalSemanticSsaProducerArtifact } from './build.js';
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

// Repeated point queries over a canonical producer artifact should not rebuild
// the same linear searches. Cache only unforgeably branded artifacts emitted by
// buildSemanticSsa(); arbitrary frozen caller-owned objects retain historical
// live property/accessor observation semantics.
const frozenQueryIndexes = new WeakMap();
function frozenQueryIndex(ssa) {
  if (!isCanonicalSemanticSsaProducerArtifact(ssa)) return null;
  const defs = definitions(ssa);
  const useRows = uses(ssa);
  if (!Object.isFrozen(defs) || !Object.isFrozen(useRows)) return null;
  let index = frozenQueryIndexes.get(ssa);
  if (index) return index;
  if (!defs.every((row) => row && typeof row === 'object' && Object.isFrozen(row))
      || !useRows.every((row) => row && typeof row === 'object' && Object.isFrozen(row))) return null;

  const definitionByValue = new Map();
  const definitionById = new Map();
  const useById = new Map();
  const usesByValue = new Map();
  const definitionsByVariable = new Map();
  const phiDefinitions = [];
  const phiDefinitionsByBlock = new Map();
  const usesBySourceEntity = new Map();
  const useBySemanticValue = new Map();
  const definitionBySemanticValue = new Map();

  for (const definition of defs) {
    if (!definitionByValue.has(definition.valueId)) definitionByValue.set(definition.valueId, definition);
    if (!definitionById.has(definition.definitionId)) definitionById.set(definition.definitionId, definition);
    if (definition.variableKey != null) {
      const list = definitionsByVariable.get(definition.variableKey) ?? [];
      list.push(definition);
      definitionsByVariable.set(definition.variableKey, list);
    }
    if (definition.kind === 'phi') {
      phiDefinitions.push(definition);
      if (definition.blockId != null) {
        const list = phiDefinitionsByBlock.get(definition.blockId) ?? [];
        list.push(definition);
        phiDefinitionsByBlock.set(definition.blockId, list);
      }
    }
    const semanticValueId = definition.proof?.sourceSemanticValueId;
    if (semanticValueId != null && !definitionBySemanticValue.has(semanticValueId)) {
      definitionBySemanticValue.set(semanticValueId, definition);
    }
  }
  for (const use of useRows) {
    if (!useById.has(use.useId)) useById.set(use.useId, use);
    const byValue = usesByValue.get(use.valueId) ?? [];
    byValue.push(use);
    usesByValue.set(use.valueId, byValue);
    const bySource = usesBySourceEntity.get(use.sourceEntityId) ?? [];
    bySource.push(use);
    usesBySourceEntity.set(use.sourceEntityId, bySource);
    const semanticValueId = use.proof?.sourceSemanticValueId;
    if (semanticValueId != null && !useBySemanticValue.has(semanticValueId)) useBySemanticValue.set(semanticValueId, use);
  }
  const byUseId = (a, b) => a.useId.localeCompare(b.useId);
  const byDefinitionPosition = (a, b) =>
    String(a.blockId ?? '').localeCompare(String(b.blockId ?? '')) || a.valueId.localeCompare(b.valueId);
  const byValueId = (a, b) => a.valueId.localeCompare(b.valueId);
  for (const list of usesByValue.values()) list.sort(byUseId);
  for (const list of usesBySourceEntity.values()) list.sort(byUseId);
  for (const list of definitionsByVariable.values()) list.sort(byDefinitionPosition);
  phiDefinitions.sort(byValueId);
  for (const list of phiDefinitionsByBlock.values()) list.sort(byValueId);

  index = { definitionByValue, definitionById, useById, usesByValue, definitionsByVariable,
    phiDefinitions, phiDefinitionsByBlock, usesBySourceEntity, useBySemanticValue, definitionBySemanticValue };
  frozenQueryIndexes.set(ssa, index);
  return index;
}

export function getSsaDefinition(ssa, valueId) {
  const id = nonEmpty(valueId, 'semantic-ssa-query-value-id-required');
  const index = frozenQueryIndex(ssa);
  return index ? index.definitionByValue.get(id) ?? null : definitions(ssa).find((definition) => definition.valueId === id) ?? null;
}

export function getSsaDefinitionById(ssa, definitionId) {
  const id = nonEmpty(definitionId, 'semantic-ssa-query-definition-id-required');
  const index = frozenQueryIndex(ssa);
  return index ? index.definitionById.get(id) ?? null : definitions(ssa).find((definition) => definition.definitionId === id) ?? null;
}

export function getSsaUse(ssa, useId) {
  const id = nonEmpty(useId, 'semantic-ssa-query-use-id-required');
  const index = frozenQueryIndex(ssa);
  return index ? index.useById.get(id) ?? null : uses(ssa).find((use) => use.useId === id) ?? null;
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
  const index = frozenQueryIndex(ssa);
  const rows = index ? index.usesByValue.get(definition.valueId) ?? []
    : uses(ssa).filter((use) => use.valueId === definition.valueId).slice().sort((a, b) => a.useId.localeCompare(b.useId));
  return Object.freeze(rows.slice());
}

export function getUsesForValue(ssa, valueId) {
  const definition = getSsaDefinition(ssa, valueId);
  return definition ? getUsesForDefinition(ssa, definition) : Object.freeze([]);
}

export function getDefinitionsForVariable(ssa, variableKey) {
  const key = nonEmpty(variableKey, 'semantic-ssa-query-variable-key-required');
  const index = frozenQueryIndex(ssa);
  const rows = index ? index.definitionsByVariable.get(key) ?? []
    : definitions(ssa).filter((definition) => definition.variableKey === key).slice().sort((a, b) =>
      String(a.blockId ?? '').localeCompare(String(b.blockId ?? '')) || a.valueId.localeCompare(b.valueId));
  return Object.freeze(rows.slice());
}

export function getPhiDefinitions(ssa, blockId = null) {
  const id = blockId == null ? null : nonEmpty(blockId, 'semantic-ssa-query-block-id-required');
  const index = frozenQueryIndex(ssa);
  const rows = index ? (id == null ? index.phiDefinitions : index.phiDefinitionsByBlock.get(id) ?? [])
    : definitions(ssa).filter((definition) => definition.kind === 'phi' && (id == null || definition.blockId === id))
      .slice().sort((a, b) => a.valueId.localeCompare(b.valueId));
  return Object.freeze(rows.slice());
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
  const index = frozenQueryIndex(ssa);
  const rows = index ? index.usesBySourceEntity.get(id) ?? []
    : uses(ssa).filter((use) => use.sourceEntityId === id).slice().sort((a, b) => a.useId.localeCompare(b.useId));
  return Object.freeze(rows.slice());
}

export function getSsaUseForSemanticValue(ssa, semanticValueId) {
  const id = nonEmpty(semanticValueId, 'semantic-ssa-query-semantic-value-required');
  const index = frozenQueryIndex(ssa);
  return index ? index.useBySemanticValue.get(id) ?? null
    : uses(ssa).find((use) => use.proof?.sourceSemanticValueId === id) ?? null;
}

export function getSsaDefinitionForSemanticValue(ssa, semanticValueId) {
  const id = nonEmpty(semanticValueId, 'semantic-ssa-query-semantic-value-required');
  const index = frozenQueryIndex(ssa);
  return index ? index.definitionBySemanticValue.get(id) ?? null
    : definitions(ssa).find((definition) => definition.proof?.sourceSemanticValueId === id) ?? null;
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
