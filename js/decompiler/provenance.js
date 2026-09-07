/*
 * Source-provenance helpers shared by the decompiler UI and regression tests.
 *
 * The first group of exports below is the small address/row presentation API
 * used by the legacy viewer.  The second group is the canonical C4-03
 * projection graph.  It deliberately lives at this boundary rather than in a
 * renderer: a rendered line is a view of a semantic entity, never a new
 * semantic authority.
 */

import { stableDigest, stableStringify } from '../core/identity/index.js';
import { structuralKey } from './ast/nodes.js';

export const DECOMPILER_PROVENANCE_SCHEMA_VERSION = 1;
const PROVENANCE_STAGES = Object.freeze(['raw', 'optimized', 'rendered']);
const PROVENANCE_DIRECTIONS = Object.freeze([
  'raw-to-optimized', 'optimized-to-rendered', 'raw-to-rendered',
  'rendered-to-optimized', 'optimized-to-raw', 'rendered-to-raw',
]);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function list(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function text(value) { return value == null ? null : String(value); }
function unique(values) {
  return [...new Set(values.filter((value) => value != null).map(String))].sort();
}
function compareValues(left, right) {
  const a = String(left), b = String(right);
  const an = /^-?\d+$/.test(a), bn = /^-?\d+$/.test(b);
  if (an && bn) {
    const ai = BigInt(a), bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
function sorted(values) { return unique(values).sort(compareValues); }
function safeDigest(value) {
  try { return stableDigest(value); } catch { return stableDigest({ invalid: String(value) }); }
}
function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}
function canonicalAddressText(value) {
  if (value == null) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value); }
}
function sourceArray(source, ...keys) {
  const values = [];
  for (const key of keys) values.push(...list(source?.[key]));
  return values.filter((value) => value != null);
}

/* Normalize the historical source shape without using text or array position
 * as identity.  New Semantic IR origins are accepted too, so v2 callers can
 * travel through this same projection boundary. */
function normalizedSource(source = null) {
  const value = object(source) || {};
  const origin = object(value.origin) || {};
  const addresses = sourceArray(value, 'addresses', 'address');
  const rows = sourceArray(value, 'rows', 'row');
  const ir = sourceArray(value, 'ir', 'irId', 'sourceEntityId');
  const sourceEntityIds = sourceArray(value, 'sourceEntityIds', 'entityIds');
  const ssaDefs = sourceArray(value, 'ssaDefs', 'ssaDef');
  const ssaUses = sourceArray(value, 'ssaUses', 'ssaUse');
  const instructionIds = sourceArray(value, 'instructionIds').concat(sourceArray(origin, 'instructionIds'));
  const operationIds = sourceArray(value, 'operationIds', 'bytecodeOperationIds')
    .concat(sourceArray(origin, 'operationIds', 'bytecodeOperationIds'));
  const parentEntityIds = sourceArray(value, 'parentEntityIds').concat(sourceArray(origin, 'parentEntityIds'));
  return {
    addresses:sorted(addresses.map(canonicalAddressText)),
    rows:sorted(rows),
    ir:sorted(ir),
    sourceEntityIds:sorted(sourceEntityIds),
    ssaDefs:sorted(ssaDefs),
    ssaUses:sorted(ssaUses),
    instructionIds:sorted(instructionIds),
    operationIds:sorted(operationIds),
    parentEntityIds:sorted(parentEntityIds),
    evidence:list(value.evidence).map((entry) => object(entry) || { value:String(entry) }),
  };
}

function identitySource(source) {
  const normalized = normalizedSource(source);
  return { ...normalized, evidence:[] };
}

function mergeSources(...sources) {
  const normalized = sources.map(normalizedSource);
  return {
    addresses:sorted(normalized.flatMap((source) => source.addresses)),
    rows:sorted(normalized.flatMap((source) => source.rows)),
    ir:sorted(normalized.flatMap((source) => source.ir)),
    sourceEntityIds:sorted(normalized.flatMap((source) => source.sourceEntityIds)),
    ssaDefs:sorted(normalized.flatMap((source) => source.ssaDefs)),
    ssaUses:sorted(normalized.flatMap((source) => source.ssaUses)),
    instructionIds:sorted(normalized.flatMap((source) => source.instructionIds)),
    operationIds:sorted(normalized.flatMap((source) => source.operationIds)),
    parentEntityIds:sorted(normalized.flatMap((source) => source.parentEntityIds)),
    evidence:normalized.flatMap((source) => source.evidence),
  };
}

function sourceRefTokens(source) {
  const value = normalizedSource(source);
  const refs = [];
  for (const id of value.ir) refs.push(`ir:${id}`);
  for (const id of value.sourceEntityIds) refs.push(`source-entity:${id}`);
  for (const id of value.instructionIds) refs.push(`instruction:${id}`);
  for (const id of value.operationIds) refs.push(`operation:${id}`);
  for (const id of value.ssaDefs) refs.push(`ssa-def:${id}`);
  for (const id of value.ssaUses) refs.push(`ssa-use:${id}`);
  for (const id of value.parentEntityIds) refs.push(`parent:${id}`);
  for (const row of value.rows) refs.push(`row:${row}`);
  for (const address of value.addresses) refs.push(`address:${address}`);
  return unique(refs);
}

function explicitEntityId(stage, kind, value) {
  const id = text(value);
  return id == null ? null : `${stage}:${kind}:${id}`;
}
function generatedEntityId(stage, kind, identity) {
  return `${stage}:${kind}:${safeDigest(identity)}`;
}
function normalizeEntityId(value) {
  if (value == null) return null;
  const id = String(value);
  return id || null;
}
function entityIdentity(stage, kind, identity, explicit = null) {
  return explicitEntityId(stage, kind, explicit) || generatedEntityId(stage, kind, identity);
}

function entity(stage, kind, identity, source = null, metadata = {}, explicit = null) {
  if (!PROVENANCE_STAGES.includes(stage)) throw new TypeError(`provenance-unknown-stage:${stage}`);
  const normalized = normalizedSource(source);
  const id = entityIdentity(stage, kind, identity, explicit);
  return {
    id,
    stage,
    kind,
    identity:identity == null ? null : identity,
    source:normalized,
    metadata:object(metadata) || {},
    status:'active',
    rawEntityIds:[],
    optimizedEntityIds:[],
    renderedEntityIds:[],
  };
}

function entityRefs(entityValue) {
  return sourceRefTokens(entityValue?.source);
}

function addToMap(map, from, to) {
  if (!from || !to) return;
  const current = map.get(from) || new Set();
  current.add(to);
  map.set(from, current);
}

function mapObject(map) {
  const out = {};
  for (const [from, targets] of [...map.entries()].sort(([a], [b]) => compareValues(a, b))) {
    out[from] = [...targets].sort(compareValues);
  }
  return out;
}

function mapEntries(map) {
  return Object.fromEntries(Object.entries(map).map(([id, values]) => [id, Object.freeze(values)]));
}

function sourceFromInstruction(instruction) {
  return normalizedSource({
    address:instruction?.address,
    row:instruction?.row,
    ir:instruction?.id ?? instruction?.semanticNodeId ?? instruction?.sourceEntityId,
    sourceEntityIds:instruction?.semanticNodeId ?? instruction?.sourceEntityId,
    instructionIds:instruction?.instructionId,
    operationIds:instruction?.operationId ?? instruction?.bytecodeOperationId,
    evidence:instruction?.evidence,
    origin:instruction?.origin,
  });
}

function rawInstructionIdentity(instruction, index) {
  const explicit = instruction?.id ?? instruction?.instructionId ?? instruction?.semanticNodeId ?? null;
  return {
    explicit:explicit == null ? null : String(explicit),
    row:instruction?.row == null ? null : String(instruction.row),
    address:canonicalAddressText(instruction?.address),
    // Position is only a last-resort identity.  When a producer supplies a
    // row or address, reordering/pretty-printing must not mint a new raw ID.
    ...(instruction?.row == null && instruction?.address == null && !Number.isSafeInteger(explicit)
      ? { index:Number.isSafeInteger(index) ? index : null } : {}),
  };
}

function collectRawEntities(result, options = {}) {
  const entities = [];
  const seen = new Set();
  const add = (instruction, index, origin = 'ir') => {
    if (!instruction || typeof instruction !== 'object') return;
    const identity = rawInstructionIdentity(instruction, index);
    const key = identity.explicit != null ? `id:${identity.explicit}`
      : identity.row != null ? `row:${identity.row}`
        : identity.address != null ? `address:${identity.address}` : `index:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    const source = sourceFromInstruction(instruction);
    entities.push(entity('raw', 'instruction', identity, source, {
      index:Number.isSafeInteger(index) ? index : null,
      origin,
      operation:String(instruction.op ?? instruction.mnemonic ?? instruction.mn ?? ''),
    }, identity.explicit));
  };
  const irInstructions = result?.ir?.instructions || [];
  const modelInstructions = irInstructions.length > 0
    ? [] : (result?.model?.instructions?.length ? result.model.instructions : options.model?.instructions || []);
  for (const [index, instruction] of irInstructions.entries()) add(instruction, index, 'semantic-ir');
  for (const [index, instruction] of modelInstructions.entries()) add(instruction, index, 'decoded-model');
  const knownSourceRefs = new Set(entities.flatMap(entityRefs));
  for (const [index, line] of (result?.lines || []).entries()) {
    if (line?.row == null && line?.addr == null && !line?.source) continue;
    const source = normalizedSource(line?.source || line);
    if (!sourceRefTokens(source).length) continue;
    const identity = {
      row:line?.row == null ? null : String(line.row),
      address:canonicalAddressText(line?.addr),
      ...(line?.row == null && line?.addr == null ? { index } : {}),
    };
    const key = `line:${identity.row ?? ''}:${identity.address ?? ''}`;
    if (seen.has(key)) continue;
    // A line without an IR/model instruction still represents a raw boundary;
    // retain it as an explicit synthetic raw entity rather than dropping it.
    if (!sourceRefTokens(source).some((ref) => knownSourceRefs.has(ref))) {
      entities.push(entity('raw', 'source-boundary', identity, source, { index, origin:'rendered-boundary' }));
    }
    seen.add(key);
  }
  return entities.sort((a, b) => compareValues(a.id, b.id));
}

function expressionSource(expression) { return normalizedSource(expression?.source); }
function expressionIdentity(expression, parentId = null, path = '') {
  let key = null;
  try { key = structuralKey(expression); } catch { key = null; }
  return { structuralKey:key, parentId, path, source:identitySource(expressionSource(expression)) };
}

function collectOptimizedEntities(result) {
  const entities = [];
  const ast = object(result?.semanticAst);
  const add = (kind, identity, source, metadata = {}, explicit = null) => {
    const item = entity('optimized', kind, identity, source, metadata, explicit);
    entities.push(item);
    return item;
  };
  const addExpression = (expression, parentId, path, seen = new Set()) => {
    if (!expression || typeof expression !== 'object' || seen.has(expression)) return null;
    seen.add(expression);
    const identity = expressionIdentity(expression, parentId, path);
    const item = add('expression', identity, expression.source, {
      op:expression.op ?? expression.kind ?? null,
      bits:expression.bits ?? null,
      path,
      parentId,
      structuralKey:identity.structuralKey,
    });
    const childNames = expression.kind === 'unary' ? [['arg', expression.arg]]
      : expression.kind === 'binary' || expression.kind === 'compare' ? [['left', expression.left], ['right', expression.right]]
        : expression.kind === 'select' ? [['condition', expression.condition], ['whenTrue', expression.whenTrue], ['whenFalse', expression.whenFalse]]
          : expression.kind === 'field' ? [['base', expression.base]]
            : expression.kind === 'index' ? [['base', expression.base], ['index', expression.index]]
              : expression.kind === 'call' || expression.kind === 'intrinsic' ? (expression.args || []).map((child, index) => [`arg${index}`, child]) : [];
    for (const [name, child] of childNames) addExpression(child, item.id, `${path}.${name}`, seen);
    return item;
  };
  const addRecord = (kind, record, index, source = record?.source) => {
    if (!record || typeof record !== 'object') return null;
    const explicit = record.valueId ?? record.ir ?? record.id ?? null;
    const normalizedRecordSource = normalizedSource(source || record?.origin);
    const identity = {
      explicit:explicit == null ? null : String(explicit),
      name:record.name ?? record.location?.key ?? record.lhsText ?? null,
      // Semantic IDs are preferred.  For records without one, source
      // identity is stable across array reordering; index remains a fallback
      // only when the producer supplied no source at all.
      source:identitySource(normalizedRecordSource),
      ...(sourceRefTokens(normalizedRecordSource).length ? {} : { index }),
    };
    const item = add(kind, identity, source || record?.origin, { index, name:record.name ?? null, ir:record.ir ?? null }, explicit);
    if (record.expression) {
      const expression = addExpression(record.expression, item.id, 'root');
      if (expression) item.metadata.expressionId = expression.id;
    }
    return item;
  };
  for (const [index, value] of (ast?.values || []).entries()) {
    const item = addRecord('value', value, index, mergeSources(value?.source, value?.expression?.source));
    if (item && value?.expression) item.metadata.expressionKey = (() => { try { return structuralKey(value.expression); } catch { return null; } })();
  }
  for (const [index, store] of (ast?.stores || []).entries()) addRecord('store', store, index);
  for (const [index, condition] of (ast?.conditions || []).entries()) addRecord('condition', condition, index, mergeSources(condition?.source, condition?.expression?.source));
  for (const [index, call] of (ast?.calls || []).entries()) addRecord('call', call, index);
  for (const [index, input] of (ast?.inputs || []).entries()) addRecord('input', input, index);
  for (const [index, output] of (ast?.outputs || []).entries()) addRecord('output', output, index);
  // A legacy/fallback result may have no Semantic AST. Its raw-to-rendered
  // relationship remains useful, but optimized is explicitly empty.
  return entities.sort((a, b) => compareValues(a.id, b.id));
}

function renderedIdentity(node, occurrence) {
  const source = normalizedSource(node?.source || node);
  const semantic = object(node?.semantic);
  return {
    kind:node?.kind ?? 'raw',
    semanticOp:semantic?.op ?? null,
    semanticId:semantic?.ir == null ? null : String(semantic.ir),
    source:identitySource(source),
    occurrence,
  };
}

function collectRenderedEntities(result) {
  const entities = [];
  const occurrences = new Map();
  const body = result?.cAst?.body || result?.lines || [];
  for (const [index, node] of body.entries()) {
    const source = normalizedSource(node?.source || node);
    const semantic = object(node?.semantic);
    const base = `${node?.kind ?? 'raw'}|${semantic?.op ?? ''}|${semantic?.ir ?? ''}|${stableStringify(identitySource(source))}`;
    const occurrence = occurrences.get(base) || 0;
    occurrences.set(base, occurrence + 1);
    const identity = renderedIdentity(node, occurrence);
    const item = entity('rendered', 'line', identity, source, {
      index,
      outputStartLine:index + 1,
      outputEndLine:index + 1,
      text:node?.text == null ? '' : String(node.text),
      semanticOp:semantic?.op ?? null,
    });
    entities.push(item);
  }
  // printProgram emits a source-map span per AST node. Preserve exact span
  // ranges separately from the line identity so wrapping does not change an
  // entity's stable ID.
  for (const [entryIndex, entry] of (result?.sourceMap || []).entries()) {
    const source = normalizedSource(entry?.source);
    const matching = entities[entryIndex]
      || entities.find((item) => item.metadata.outputStartLine === Number(entry.outputStartLine));
    if (matching) {
      matching.metadata.outputStartLine = Number(entry.outputStartLine);
      matching.metadata.outputEndLine = Number(entry.outputEndLine);
      matching.source = mergeSources(matching.source, source);
    }
  }
  return entities.sort((a, b) => compareValues(a.id, b.id));
}

function indexEntities(entities) {
  const byId = new Map(entities.map((item) => [item.id, item]));
  const byRef = new Map();
  for (const item of entities) for (const ref of entityRefs(item)) {
    if (!byRef.has(ref)) byRef.set(ref, new Set());
    byRef.get(ref).add(item.id);
  }
  return { byId, byRef };
}

function connectBySources(fromEntities, toEntities, map, max = Infinity) {
  const toByRef = new Map();
  for (const item of toEntities) for (const ref of entityRefs(item)) {
    if (!toByRef.has(ref)) toByRef.set(ref, new Set());
    toByRef.get(ref).add(item.id);
  }
  for (const from of fromEntities) {
    const targets = new Set();
    for (const ref of entityRefs(from)) for (const id of toByRef.get(ref) || []) targets.add(id);
    for (const id of [...targets].slice(0, max)) addToMap(map, from.id, id);
  }
}

/* An output span usually carries the root expression's source.  Its nested
 * operands are still part of the same optimized computation even when their
 * individual source sets are narrower, so propagate the root's rendered
 * ownership through the expression/value parent chain. */
function propagateOptimizedRendered(optimized, maps) {
  const children = new Map();
  for (const item of optimized) {
    const parentId = item.metadata?.parentId;
    if (!parentId) continue;
    const list = children.get(parentId) || [];
    list.push(item);
    children.set(parentId, list);
  }
  const queue = [...optimized].filter((item) => (maps.optimizedToRendered.get(item.id) || new Set()).size);
  const visited = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (visited.has(parent.id)) continue;
    visited.add(parent.id);
    const renderedIds = maps.optimizedToRendered.get(parent.id) || new Set();
    for (const child of children.get(parent.id) || []) {
      for (const renderedId of renderedIds) {
        addToMap(maps.optimizedToRendered, child.id, renderedId);
        addToMap(maps.renderedToOptimized, renderedId, child.id);
        for (const rawId of maps.optimizedToRaw.get(child.id) || []) {
          addToMap(maps.rawToRendered, rawId, renderedId);
          addToMap(maps.renderedToRaw, renderedId, rawId);
        }
      }
      queue.push(child);
    }
  }
}

function connectTransforms(transforms, maps) {
  for (const transform of transforms) {
    const targets = [...new Set([
      ...(transform.producedEntityIds || []),
      ...(transform.deletedEntityIds || []),
    ])];
    for (const consumed of transform.consumedEntityIds) for (const produced of targets) {
      if (maps.optimizedToOptimized && String(consumed).startsWith('optimized:') && String(produced).startsWith('optimized:')) {
        addToMap(maps.optimizedToOptimized, consumed, produced);
      }
      if (String(consumed).startsWith('raw:') && String(produced).startsWith('optimized:')) {
        addToMap(maps.rawToOptimized, consumed, produced);
        addToMap(maps.optimizedToRaw, produced, consumed);
      } else if (String(consumed).startsWith('optimized:') && String(produced).startsWith('rendered:')) {
        addToMap(maps.optimizedToRendered, consumed, produced);
        addToMap(maps.renderedToOptimized, produced, consumed);
      } else if (String(consumed).startsWith('raw:') && String(produced).startsWith('rendered:')) {
        addToMap(maps.rawToRendered, consumed, produced);
        addToMap(maps.renderedToRaw, produced, consumed);
      }
    }
  }
}

function inferRewriteTransform(proof, optimized, indexes) {
  const before = text(proof?.before), after = text(proof?.after);
  if (!before && !after) return null;
  const consumed = optimized.filter((item) => item.metadata?.expressionKey === before
    || item.metadata?.structuralKey === before || item.identity?.structuralKey === before)
    .map((item) => item.id);
  const produced = optimized.filter((item) => item.metadata?.expressionKey === after
    || item.metadata?.structuralKey === after || item.identity?.structuralKey === after)
    .map((item) => item.id);
  const sourceIds = unique([...consumed, ...produced]);
  return {
    passId:'decompiler.rewrite',
    passVersion:'1',
    ruleId:text(proof?.rule) || 'rewrite',
    proofKind:text(proof?.evidence?.kind) || 'semantics-preserving-rewrite',
    consumedEntityIds:consumed,
    producedEntityIds:produced,
    originRefs:sourceIds,
    preconditions:proof?.evidence ?? null,
    deletedEntityIds:consumed.filter((id) => !produced.includes(id)),
  };
}

function endpointIds(values, indexes, preferredStage = null) {
  const ids = [];
  for (const value of list(values)) {
    const id = normalizeEntityId(value);
    if (!id) continue;
    const direct = Object.values(indexes).find((index) => index.byId.has(id));
    if (direct) {
      ids.push(id);
      continue;
    }
    const stages = preferredStage && indexes[preferredStage]
      ? [indexes[preferredStage], ...Object.values(indexes).filter((index) => index !== indexes[preferredStage])]
      : Object.values(indexes);
    const prefixed = id.startsWith('optimized:') || id.startsWith('raw:') || id.startsWith('rendered:')
      ? id : id.startsWith('value:') && preferredStage === 'optimized'
        ? `optimized:${id}` : /^-?\d+$/.test(id) && preferredStage === 'optimized'
          ? `optimized:value:${id}` : id.startsWith('instruction:')
            ? `raw:${id}` : null;
    if (prefixed && Object.values(indexes).some((index) => index.byId.has(prefixed))) {
      ids.push(prefixed);
      continue;
    }
    for (const index of stages) for (const item of index.byId.values()) {
      if (item.identity?.explicit != null && String(item.identity.explicit) === id) ids.push(item.id);
    }
  }
  return unique(ids);
}

function originEntityIds(origin, indexes) {
  const direct = endpointIds(Array.isArray(origin) ? origin : [], indexes);
  const source = normalizedSource(origin);
  const ids = [];
  for (const index of Object.values(indexes)) {
    for (const ref of sourceRefTokens(source)) ids.push(...(index.byRef.get(ref) || []));
  }
  return unique([...direct, ...ids]);
}

function transformInputs(result, options = {}) {
  const inputs = [
    ...(Array.isArray(options.transforms) ? options.transforms : []),
    ...(Array.isArray(result?.phase8Projection?.transforms) ? result.phase8Projection.transforms : []),
  ];
  for (const pass of result?.phase8?.passes || []) inputs.push(...(pass.transforms || []));
  return inputs;
}

function tombstoneSource(transform) {
  if (object(transform?.origin)) return transform.origin;
  const refs = list(transform?.originRefs).map(String);
  const instructionIds = refs.filter((ref) => ref.startsWith('instruction:')).map((ref) => ref.slice('instruction:'.length));
  if (instructionIds.length) return { origin:{ instructionIds } };
  const ir = refs.filter((ref) => ref.startsWith('ir:')).map((ref) => ref.slice('ir:'.length));
  return ir.length ? { ir } : null;
}

function optimizedEndpointId(value) {
  const id = normalizeEntityId(value);
  if (!id) return null;
  if (id.startsWith('optimized:')) return id;
  if (id.startsWith('value:')) return `optimized:${id}`;
  if (/^-?\d+$/.test(id)) return `optimized:value:${id}`;
  return null;
}

/* Phase 8 can prove that a value was consumed even though the final v1 AST no
 * longer contains that value. Keep a frozen tombstone so reverse navigation can
 * still explain the deletion; silently dropping the target would turn a valid
 * deletion into provenance loss. */
function addOptimizedTombstones(optimized, result, options) {
  const existing = new Set(optimized.map((item) => item.id));
  for (const transform of transformInputs(result, options)) {
    const candidates = [
      ...list(transform?.targets),
      ...list(transform?.consumedEntityIds),
      ...list(transform?.consumed),
      ...list(transform?.producedEntityIds),
      ...list(transform?.produced),
      ...list(transform?.deletedEntityIds),
    ];
    for (const candidate of candidates) {
      const id = optimizedEndpointId(candidate);
      if (!id || existing.has(id)) continue;
      const [, kind, explicit] = id.split(':');
      const item = entity('optimized', kind || 'value', {
        explicit:explicit ?? String(candidate),
        tombstone:true,
      }, tombstoneSource(transform), {
        tombstone:true,
        deletedBy:text(transform?.passId) || text(transform?.pass) || text(transform?.kind) || 'transform',
      }, explicit ?? String(candidate));
      item.id = id;
      item.status = 'deleted';
      optimized.push(item);
      existing.add(id);
    }
  }
  optimized.sort((a, b) => compareValues(a.id, b.id));
}

function normalizeTransform(input, index, indexes) {
  const source = object(input) || {};
  const origin = source.origin || source.originRefs || source.targets || null;
  const inferred = originEntityIds(origin, indexes);
  const requestedConsumed = unique([
    ...list(source.consumedEntityIds),
    ...list(source.consumed),
    ...list(source.targets),
  ]);
  const consumed = unique([
    ...endpointIds(requestedConsumed, indexes, 'optimized'),
    ...inferred,
  ]).filter((id) => indexes.optimized.byId.has(id) || indexes.raw.byId.has(id));
  const requestedProduced = unique([
    ...list(source.producedEntityIds),
    ...list(source.produced),
  ]);
  const deletionTransform = /(?:dce|dead|delete|eliminat|remove)/i.test(
    [source.passId, source.pass, source.ruleId, source.rule, source.kind].filter(Boolean).join(' '),
  );
  const produced = unique([
    ...endpointIds(requestedProduced, indexes, 'optimized'),
  ]).filter((id) => indexes.optimized.byId.has(id) || indexes.rendered.byId.has(id));
  const deleted = unique([
    ...endpointIds(list(source.deletedEntityIds), indexes, 'optimized'),
    ...(deletionTransform ? endpointIds(source.targets, indexes, 'optimized') : []),
    ...consumed.filter((id) => String(id).startsWith('optimized:') && !produced.includes(id)),
  ]);
  const invalidated = unique([...list(source.invalidatedEntityIds), ...list(source.invalidated)]);
  const passId = text(source.passId) || text(source.pass) || 'decompiler.projection';
  const passVersion = text(source.passVersion) || text(source.version) || '1';
  const ruleId = text(source.ruleId) || text(source.rule) || text(source.kind) || `transform-${index}`;
  const proofKind = text(source.proofKind) || text(source.proof) || text(source.evidence?.kind) || 'provenance-preserving-transform';
  const record = {
    id:`transform:${safeDigest({ passId, passVersion, ruleId, proofKind, consumed, produced, deleted, invalidated, index })}`,
    passId, passVersion, ruleId, proofKind,
    consumedEntityIds:consumed.sort(compareValues),
    producedEntityIds:produced.sort(compareValues),
    deletedEntityIds:deleted.sort(compareValues),
    invalidatedEntityIds:invalidated.sort(compareValues),
    originRefs:unique([...list(source.originRefs), ...inferred]),
    unresolvedEntityIds:unique([
      ...requestedConsumed.filter((id) => !endpointIds([id], indexes, 'optimized').length),
      ...requestedProduced.filter((id) => !endpointIds([id], indexes, 'optimized').length),
      ...list(source.deletedEntityIds).filter((id) => !endpointIds([id], indexes, 'optimized').length),
    ]),
    preconditions:source.preconditions ?? source.evidence ?? null,
    status:source.status || 'committed',
  };
  return record;
}

function phase8Transforms(result, optimized, indexes) {
  const records = [];
  for (const proof of result?.rewriteProof || []) {
    const inferred = inferRewriteTransform(proof, optimized, indexes);
    if (inferred) records.push(inferred);
  }
  for (const transform of result?.phase8Projection?.transforms || []) records.push({
    ...transform,
    passId:'phase8.projection',
    passVersion:String(result?.phase8?.contractVersion ?? 1),
    ruleId:transform.kind || 'projection',
    proofKind:transform.proof || transform.kind || 'projection',
    origin:transform.origin,
    consumedEntityIds:originEntityIds(transform.origin, indexes),
    producedEntityIds:originEntityIds(transform.origin, indexes),
  });
  for (const pass of result?.phase8?.passes || []) for (const transform of pass.transforms || []) {
    const deletion = /(?:dce|dead|delete|eliminat|remove)/i.test(`${pass.id || ''} ${transform.kind || ''}`);
    records.push({
      ...transform,
      passId:pass.id || result.phase8.registryDigest || 'phase8',
      passVersion:pass.version || String(result.phase8.contractVersion || 1),
      originRefs:transform.originRefs,
      consumedEntityIds:transform.targets,
      ...(deletion ? { producedEntityIds:[], deletedEntityIds:transform.targets } : { producedEntityIds:transform.targets }),
    });
  }
  return records;
}

function identityMaterial(result, options = {}) {
  const supplied = object(options.identity) || object(result?.provenanceIdentity) || object(result?.identity) || {};
  const ctx = object(result?.ctx) || {};
  const pipeline = object(ctx.decompilerPipeline) || {};
  const phase8 = object(result?.phase8) || object(pipeline.phase8) || {};
  return {
    ...supplied,
    binaryId:supplied.binaryId ?? options.binaryId ?? result?.binaryId ?? null,
    sliceId:supplied.sliceId ?? options.sliceId ?? result?.sliceId ?? null,
    functionId:supplied.functionId ?? options.functionId ?? result?.functionId ?? null,
    snapshotId:supplied.snapshotId ?? options.snapshotId ?? result?.snapshotId ?? null,
    analysisEpoch:supplied.analysisEpoch ?? options.analysisEpoch ?? result?.analysisEpoch ?? null,
    semanticVersion:supplied.semanticVersion ?? options.semanticVersion ?? null,
    phase8RegistryDigest:phase8.registryDigest ?? null,
    phase8ContractVersion:phase8.contractVersion ?? null,
  };
}

function sourceMapConsistency(result, rendered) {
  const spans = [];
  for (const [entryIndex, entry] of (result?.sourceMap || []).entries()) {
    const start = Number(entry.outputStartLine), end = Number(entry.outputEndLine);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) continue;
    // Rendered entities are sorted by stable identity before publication, so
    // source-map order is no longer a valid owner index. Match the exact
    // output span first and retain index only as a conservative legacy
    // fallback for producers that omit output metadata on their nodes.
    const owner = rendered.find((item) => item.metadata.outputStartLine === start
      && item.metadata.outputEndLine === end)
      || rendered.find((item) => item.metadata.outputStartLine === start)
      || rendered[entryIndex];
    spans.push({ start, end, renderedEntityId:owner?.id ?? null, source:normalizedSource(entry.source) });
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function statusOf(result, upstreamInvalidated, mappingIssues = []) {
  const completeness = result?.ctx?.decompilerPipeline?.completeness ?? result?.completeness ?? 'complete';
  if (result?.provenanceInvalidated || result?.stale === true) return { state:'invalidated', reason:'producer-invalidated' };
  if (upstreamInvalidated.length) return { state:'invalidated', reason:'upstream-analysis-invalidated' };
  if (mappingIssues.length) return { state:'partial', reason:'mapping-incomplete' };
  if (completeness !== 'complete' || result?.phase8?.published === false) return { state:'partial', reason:`producer-${completeness}` };
  return { state:'current', reason:null };
}

function mappingIssues(rendered, sourceMap, transforms) {
  const issues = rendered.filter((item) => item.status === 'unmapped').map((item) => `rendered:${item.id}`);
  for (const span of sourceMap) if (!span.renderedEntityId) issues.push(`source-map:${span.start}`);
  for (const transform of transforms) for (const id of transform.unresolvedEntityIds || []) issues.push(`transform:${transform.id}:${id}`);
  return unique(issues);
}

function attachRelationMetadata(raw, optimized, rendered, maps, transforms = []) {
  const explicitlyDeleted = new Set(transforms.flatMap((transform) => transform.deletedEntityIds || []));
  const all = [...raw, ...optimized, ...rendered];
  const byId = new Map(all.map((item) => [item.id, item]));
  for (const item of raw) {
    const optimizedIds = maps.rawToOptimized.get(item.id) || new Set();
    const renderedIds = maps.rawToRendered.get(item.id) || new Set();
    item.optimizedEntityIds = [...optimizedIds].sort(compareValues);
    item.renderedEntityIds = [...renderedIds].sort(compareValues);
    const deleted = explicitlyDeleted.has(item.id)
      || (item.optimizedEntityIds.length > 0 && item.optimizedEntityIds.every((id) => explicitlyDeleted.has(id)));
    item.status = deleted ? 'deleted'
      : item.optimizedEntityIds.length > 1 ? 'merged'
        : item.optimizedEntityIds.length || renderedIds.size ? 'active' : 'unmapped';
  }
  for (const item of optimized) {
    const rawIds = maps.optimizedToRaw.get(item.id) || new Set();
    const renderedIds = maps.optimizedToRendered.get(item.id) || new Set();
    item.rawEntityIds = [...rawIds].sort(compareValues);
    item.renderedEntityIds = [...renderedIds].sort(compareValues);
    item.status = explicitlyDeleted.has(item.id) || item.metadata?.tombstone === true ? 'deleted'
      : item.rawEntityIds.length > 1 ? 'merged'
        : item.renderedEntityIds.length === 0 ? 'unrendered' : 'active';
  }
  for (const item of rendered) {
    item.rawEntityIds = [...(maps.renderedToRaw.get(item.id) || new Set())].sort(compareValues);
    item.optimizedEntityIds = [...(maps.renderedToOptimized.get(item.id) || new Set())].sort(compareValues);
    const structural = ['sig', 'ctrl', 'label'].includes(item.identity?.kind);
    item.status = item.optimizedEntityIds.length || item.rawEntityIds.length
      ? 'active' : structural ? 'structural' : 'unmapped';
  }
  return byId;
}

function graphDigestMaterial(graph) {
  const { digest: _digest, ...material } = graph;
  return material;
}

/**
 * Build the canonical raw → optimized → rendered graph for one decompiler
 * result.  The graph is deterministic: entity IDs use semantic/source
 * identity, mappings are sorted, and rendered text is metadata rather than an
 * identity input.  Callers may supply explicit `identity` and `transforms`
 * for non-decompiler producers using the same contract.
 */
export function buildDecompilerProvenance(result, options = {}) {
  if (!result || typeof result !== 'object') throw new TypeError('decompiler-provenance-result-required');
  const raw = collectRawEntities(result, options);
  const optimized = collectOptimizedEntities(result);
  addOptimizedTombstones(optimized, result, options);
  const rendered = collectRenderedEntities(result);
  const indexes = {
    raw:indexEntities(raw),
    optimized:indexEntities(optimized),
    rendered:indexEntities(rendered),
  };
  const maps = {
    rawToOptimized:new Map(), optimizedToRaw:new Map(),
    optimizedToRendered:new Map(), renderedToOptimized:new Map(),
    rawToRendered:new Map(), renderedToRaw:new Map(),
    optimizedToOptimized:new Map(),
  };
  connectBySources(raw, optimized, maps.rawToOptimized);
  connectBySources(optimized, raw, maps.optimizedToRaw);
  connectBySources(optimized, rendered, maps.optimizedToRendered);
  connectBySources(rendered, optimized, maps.renderedToOptimized);
  connectBySources(raw, rendered, maps.rawToRendered);
  connectBySources(rendered, raw, maps.renderedToRaw);
  propagateOptimizedRendered(optimized, maps);

  const transforms = [
    ...(Array.isArray(options.transforms) ? options.transforms : []),
    ...phase8Transforms(result, optimized, indexes),
  ].map((item, index) => normalizeTransform(item, index, indexes));
  connectTransforms(transforms, maps);
  attachRelationMetadata(raw, optimized, rendered, maps, transforms);
  const identity = identityMaterial(result, options);
  const upstreamInvalidated = sorted([
    ...(result?.phase8?.invalidated || []),
    ...(result?.ctx?.decompilerPipeline?.invalidated || []),
    ...(options.invalidated || []),
    ...transforms.flatMap((transform) => transform.invalidatedEntityIds || []),
  ]);
  const sourceMap = sourceMapConsistency(result, rendered);
  const state = statusOf(result, upstreamInvalidated, mappingIssues(rendered, sourceMap, transforms));

  const mapValues = {
    rawToOptimized:mapObject(maps.rawToOptimized),
    optimizedToRaw:mapObject(maps.optimizedToRaw),
    optimizedToRendered:mapObject(maps.optimizedToRendered),
    renderedToOptimized:mapObject(maps.renderedToOptimized),
    rawToRendered:mapObject(maps.rawToRendered),
    renderedToRaw:mapObject(maps.renderedToRaw),
    optimizedToOptimized:mapObject(maps.optimizedToOptimized),
  };
  const graph = {
    schemaVersion:DECOMPILER_PROVENANCE_SCHEMA_VERSION,
    kind:'decompiler-transform-provenance',
    identity,
    identityDigest:safeDigest(identity),
    status:state.state,
    invalidation:Object.freeze({
      state:state.state,
      reason:state.reason,
      upstreamInvalidated,
      dependencyDigest:safeDigest({ identity, upstreamInvalidated }),
    }),
    raw:Object.freeze(raw),
    optimized:Object.freeze(optimized),
    rendered:Object.freeze(rendered),
    transforms:Object.freeze(transforms.sort((a, b) => compareValues(a.id, b.id))),
    mapping:Object.freeze({
      ...Object.fromEntries(Object.entries(mapValues).map(([key, value]) => [key, mapEntries(value)])),
      sourceMap:Object.freeze(sourceMap),
    }),
  };
  graph.digest = safeDigest(graphDigestMaterial(graph));
  const frozen = freeze(graph);
  return frozen;
}

export const createDecompilerProvenance = buildDecompilerProvenance;
export const createTransformProvenance = buildDecompilerProvenance;

/** Attach the graph to a product result and annotate line/AST projections. */
export function attachDecompilerProvenance(result, options = {}) {
  if (!result || typeof result !== 'object') throw new TypeError('decompiler-provenance-result-required');
  const provenance = buildDecompilerProvenance(result, options);
  const rendered = provenance.rendered;
  const byIndex = new Map(rendered.map((item) => [Number(item.metadata?.index), item]));
  if (Array.isArray(result.lines)) {
    result.lines = result.lines.map((line, index) => {
      const item = byIndex.get(index);
      return item ? { ...line, provenanceId:item.id } : line;
    });
  }
  if (Array.isArray(result.cAst?.body)) {
    result.cAst = {
      ...result.cAst,
      body:result.cAst.body.map((node, index) => {
        const item = byIndex.get(index);
        return item ? { ...node, provenanceId:item.id } : node;
      }),
    };
  }
  result.provenance = provenance;
  return result;
}
export const wireDecompilerProvenance = attachDecompilerProvenance;

function entitiesFor(provenance, id) {
  const value = normalizeEntityId(id);
  if (!value) return [];
  return [...(provenance?.raw || []), ...(provenance?.optimized || []), ...(provenance?.rendered || [])]
    .filter((item) => item.id === value);
}

function mapName(direction) {
  if (!PROVENANCE_DIRECTIONS.includes(direction)) throw new TypeError(`provenance-unknown-direction:${direction}`);
  const parts = direction.split('-');
  const from = parts[0], to = parts.at(-1);
  return `${from}To${to[0].toUpperCase()}${to.slice(1)}`;
}

function identityMatches(provenance, options = {}) {
  if (options.identityDigest != null) return String(options.identityDigest) === provenance.identityDigest;
  if (options.identity == null) return true;
  const expected = object(options.identity);
  if (!expected) return false;
  return Object.entries(expected).every(([key, value]) => stableStringify(value) === stableStringify(provenance.identity?.[key]));
}

function reverseDirection(source) {
  switch (source?.stage) {
    case 'rendered': return 'rendered-to-optimized';
    case 'optimized': return 'optimized-to-raw';
    case 'raw': return 'raw-to-rendered';
    default: return 'rendered-to-optimized';
  }
}

/**
 * Resolve one entity in either direction.  Unknown IDs and stale identities
 * return explicit conservative results instead of falling back to rendered
 * text, row order, or a guessed nearest source.
 */
export function resolveDecompilerProvenance(provenance, id, options = {}) {
  if (!provenance || typeof provenance !== 'object') return { status:'unavailable', reason:'provenance-missing', ids:[], entities:[] };
  if (!identityMatches(provenance, options)) {
    return { status:'stale', reason:'provenance-identity-mismatch', ids:[], entities:[], invalidation:provenance.invalidation };
  }
  if (provenance.status === 'invalidated') return { status:'stale', reason:provenance.invalidation?.reason || 'provenance-invalidated', ids:[], entities:[], invalidation:provenance.invalidation };
  const sourceEntities = entitiesFor(provenance, id);
  if (!sourceEntities.length) return { status:'unknown', reason:'provenance-entity-unknown', ids:[], entities:[] };
  const direction = options.direction || (options.reverse === true
    ? reverseDirection(sourceEntities[0]) : 'raw-to-optimized');
  const mapKey = mapName(direction);
  const output = new Set();
  for (const source of sourceEntities) for (const target of provenance.mapping?.[mapKey]?.[source.id] || []) output.add(target);
  const ids = [...output].sort(compareValues);
  const entities = [...(provenance.raw || []), ...(provenance.optimized || []), ...(provenance.rendered || [])]
    .filter((item) => output.has(item.id)).sort((a, b) => compareValues(a.id, b.id));
  return {
    status:'current', direction, sourceId:String(id), ids, entities,
    sourceEntities, invalidation:provenance.invalidation,
  };
}
export const navigateDecompilerProvenance = resolveDecompilerProvenance;
export const reverseDecompilerProvenance = (provenance, id, options = {}) =>
  resolveDecompilerProvenance(provenance, id, {
    ...options,
    ...(options.direction ? {} : { reverse:true }),
  });

export function provenanceEntity(provenance, id) { return entitiesFor(provenance, id)[0] || null; }
export const getProvenanceEntity = provenanceEntity;

/** Validate graph topology and optionally bind it to an expected identity. */
export function validateDecompilerProvenance(provenance, options = {}) {
  const failures = [];
  if (!provenance || typeof provenance !== 'object') return ['provenance-missing'];
  if (provenance.schemaVersion !== DECOMPILER_PROVENANCE_SCHEMA_VERSION) failures.push('provenance-schema-version');
  const entities = [...(provenance.raw || []), ...(provenance.optimized || []), ...(provenance.rendered || [])];
  const byId = new Map();
  for (const item of entities) {
    if (!item?.id || byId.has(item.id)) failures.push(`provenance-duplicate-entity:${item?.id || 'missing'}`);
    byId.set(item?.id, item);
  }
  for (const [name, mapping] of Object.entries(provenance.mapping || {})) {
    if (name === 'sourceMap') continue;
    for (const [from, targets] of Object.entries(mapping || {})) {
      if (!byId.has(from)) failures.push(`provenance-mapping-source:${from}`);
      for (const target of targets || []) if (!byId.has(target)) failures.push(`provenance-mapping-target:${from}->${target}`);
    }
  }
  for (const transform of provenance.transforms || []) {
    for (const id of [
      ...(transform.consumedEntityIds || []),
      ...(transform.producedEntityIds || []),
      ...(transform.deletedEntityIds || []),
    ]) {
      if (!byId.has(id)) failures.push(`provenance-transform-endpoint:${transform.id || 'unknown'}:${id}`);
    }
    for (const id of transform.unresolvedEntityIds || []) failures.push(`provenance-unresolved-transform:${transform.id || 'unknown'}:${id}`);
  }
  if (!identityMatches(provenance, options)) failures.push('provenance-identity-mismatch');
  if (provenance.digest !== safeDigest(graphDigestMaterial(provenance))) failures.push('provenance-digest-mismatch');
  return [...new Set(failures)];
}

function asBigInt(value) {
  if (value == null) return null;
  try { return BigInt(value); } catch { return null; }
}

function uniqueSortedBigInts(values) {
  const byText = new Map();
  for (const value of values || []) {
    const n = asBigInt(value);
    if (n != null) byText.set(n.toString(), n);
  }
  return [...byText.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function decompilerSourceAddresses(line) {
  const source = line?.source?.addresses;
  const values = Array.isArray(source) && source.length ? source : (line?.addr != null ? [line.addr] : []);
  return uniqueSortedBigInts(values);
}

export function decompilerSourceRows(line) {
  const source = line?.source?.rows;
  const values = Array.isArray(source) && source.length ? source : (line?.row != null ? [line.row] : []);
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

export function primaryDecompilerAddress(line) {
  return decompilerSourceAddresses(line)[0] ?? null;
}

export function groupDecompilerAddresses(lineOrAddresses, step = 4n) {
  const addresses = Array.isArray(lineOrAddresses)
    ? uniqueSortedBigInts(lineOrAddresses)
    : decompilerSourceAddresses(lineOrAddresses);
  const groups = [];
  for (const address of addresses) {
    const last = groups[groups.length - 1];
    if (last && address === last.end + step) last.end = address;
    else groups.push({ start: address, end: address });
  }
  return groups;
}

function hex(address, digits = 0, prefix = '') {
  const body = BigInt(address).toString(16).toUpperCase();
  const visible = digits > 0 ? body.slice(-digits).padStart(digits, '0') : body;
  return prefix + visible;
}

function groupText(group, { digits = 6, prefix = '' } = {}) {
  const start = hex(group.start, digits, prefix);
  if (group.start === group.end) return start;
  return `${start}–${hex(group.end, digits, prefix)}`;
}

/** Compact, exact source ownership for the left gutter. Sparse ranges stay sparse. */
export function formatDecompilerSource(line, { digits = 6, maxGroups = 3 } = {}) {
  const groups = groupDecompilerAddresses(line);
  if (!groups.length) return '';
  const shown = groups.slice(0, Math.max(1, maxGroups));
  let text = shown.map((g) => groupText(g, { digits })).join(' · ');
  if (groups.length > shown.length) text += ` · +${groups.length - shown.length}`;
  return text;
}

/** Full source address text for copy/inspection; no address is silently hidden. */
export function fullDecompilerSourceText(line) {
  return groupDecompilerAddresses(line).map((g) => groupText(g, { digits: 0, prefix: '0x' })).join(', ');
}

export function hasSingleDecompilerInstruction(line) {
  return decompilerSourceAddresses(line).length === 1 && decompilerSourceRows(line).length <= 1;
}
