/*
 * Resolve only exact legacy-v1 stack reloads whose reaching store is already
 * proven by the legacy IR. This runs after the typed semantic AST is built and
 * before the higher-level return recovery consumes those expressions.
 *
 * Canonical v2 projections are excluded: their MemorySSA facts remain the sole
 * authority. Ambiguous, cyclic, mismatched, or unproven stack loads stay loads.
 * The legacy reachingStore pointer is only a candidate: publication still
 * needs the physical same-block LOAD/STORE layout and source binding below.
 */
function positiveAccessSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function ownData(object, key) {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
    return { present:false, valid:true, value:undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { present:false, valid:true, value:undefined };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { present:true, valid:false, value:undefined };
    }
    return { present:true, valid:true, value:descriptor.value };
  } catch {
    return { present:true, valid:false, value:undefined };
  }
}

function valueOf(object, key) {
  const field = ownData(object, key);
  return field.present && field.valid ? field.value : undefined;
}

function validRow(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function idKey(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function stackLocation(object) {
  const location = valueOf(object, 'loc');
  if (!location || typeof location !== 'object') return null;
  const kind = valueOf(location, 'kind');
  const key = valueOf(location, 'key');
  const size = valueOf(location, 'size');
  if (typeof kind !== 'string' || typeof key !== 'string' || key.length === 0) return null;
  return { kind, key, size };
}

function instructionOp(instruction) {
  const op = valueOf(instruction, 'op');
  return typeof op === 'string' ? op : null;
}

function instructionRow(instruction) {
  const field = ownData(instruction, 'row');
  return field.present && field.valid && validRow(field.value) ? field.value : null;
}

function instructionBlock(instruction) {
  const field = ownData(instruction, 'block');
  return field.present && field.valid && validRow(field.value) ? field.value : null;
}

function arrayField(object, key) {
  const field = ownData(object, key);
  if (!field.present) return { ok:true, value:[] };
  return { ok:field.valid && Array.isArray(field.value), value:field.valid && Array.isArray(field.value) ? field.value : [] };
}

function sourceIds(node) {
  const source = valueOf(node, 'source');
  const ids = arrayField(source, 'ir');
  if (!ids.ok) return null;
  const keys = [];
  try {
    for (const id of ids.value) {
      const key = idKey(id);
      if (key == null) return null;
      keys.push(key);
    }
  } catch {
    return null;
  }
  return keys;
}

function valueArgument(instruction) {
  const args = valueOf(instruction, 'args');
  if (!Array.isArray(args) || !args.length) return null;
  const argument = args[0];
  const field = ownData(argument, 'value');
  return field.present && field.valid ? field.value || null : null;
}

function aborted(opts) {
  const callback = ownData(opts, 'shouldAbort');
  const deadline = ownData(opts, 'deadline');
  const deterministic = ownData(opts, 'deterministicTransforms');
  if (deterministic.present && (!deterministic.valid || typeof deterministic.value !== 'boolean')) return true;
  if (deadline.present && (!deadline.valid || typeof deadline.value !== 'number'
      || (!Number.isFinite(deadline.value) && deadline.value !== Infinity))) return true;
  if (!deterministic.value && deadline.present) {
    const clock = globalThis.performance?.now ? globalThis.performance.now() : Date.now();
    if (clock >= deadline.value) return true;
  }
  if (!callback.present) return false;
  if (!callback.valid || typeof callback.value !== 'function') return true;
  try { return callback.value() === true; } catch { return true; }
}

export function exactLegacySameBlockStackStore(load, ir, opts = {}) {
  if (aborted(opts)) return null;
  const loadOp = instructionOp(load);
  const loadLocation = stackLocation(load);
  const reaching = ownData(load, 'reachingStore');
  if (loadOp !== 'load' || !loadLocation || loadLocation.kind !== 'stack'
      || !loadLocation.key || !reaching.present || !reaching.valid) return null;
  const store = reaching.value;
  const storeOp = instructionOp(store);
  const storeLocation = stackLocation(store);
  const loadBlock = instructionBlock(load);
  const storeBlock = instructionBlock(store);
  const loadRow = instructionRow(load);
  const storeRow = instructionRow(store);
  if (storeOp !== 'store' || !storeLocation || storeLocation.kind !== 'stack'
      || storeLocation.key !== loadLocation.key || loadBlock == null || storeBlock == null
      || storeBlock !== loadBlock || storeRow == null || loadRow == null || storeRow >= loadRow) return null;
  const storeSize = positiveAccessSize(storeLocation.size);
  const loadSize = positiveAccessSize(loadLocation.size);
  if (storeSize == null || storeSize !== loadSize) return null;

  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok || loadBlock >= blocks.value.length) return null;
  const block = blocks.value[loadBlock];
  const instructions = arrayField(block, 'insts');
  if (!instructions.ok || instructions.value.filter((instruction) => instruction === store).length !== 1
      || instructions.value.filter((instruction) => instruction === load).length !== 1) return null;
  for (const inst of instructions.value) {
    if (aborted(opts)) return null;
    if (inst === store || inst === load) continue;
    const op = instructionOp(inst);
    const row = instructionRow(inst);
    const location = stackLocation(inst);
    // A malformed STORE is an unknown memory effect even when its row getter
    // would otherwise have been ignored as an unrelated instruction.
    if (op === 'store' && row == null) return null;
    if (row == null) {
      if (op === 'call' || op === 'clobber' || op === 'unknown') return null;
      continue;
    }
    if (row <= storeRow || row >= loadRow) continue;
    if (op === 'call' || op === 'clobber' || op === 'unknown') return null;
    if (op === 'store' && (!location || location.kind === 'unknown' || location.key === loadLocation.key)) return null;
  }
  return store;
}

function exactLegacyStore(result, load, node, opts = {}) {
  const loadLocation = stackLocation(load);
  const nodeLocation = valueOf(node, 'location');
  const nodeKey = valueOf(nodeLocation, 'key');
  if (instructionOp(load) !== 'load' || !loadLocation || loadLocation.kind !== 'stack'
      || typeof nodeKey !== 'string' || loadLocation.key !== nodeKey) return null;
  const instructionsField = ownData(result?.ir, 'instructions');
  if (!instructionsField.present || !instructionsField.valid || !Array.isArray(instructionsField.value)) return null;
  const instructions = instructionsField.value;
  if (instructions.filter((candidate) => candidate === load).length !== 1) return null;
  const ids = sourceIds(node);
  const loadId = idKey(valueOf(load, 'id'));
  if (!ids || loadId == null || !ids.includes(loadId)) return null;
  const reaching = ownData(load, 'reachingStore');
  if (!reaching.present || !reaching.valid || instructions.filter((candidate) => candidate === reaching.value).length !== 1) return null;
  return exactLegacySameBlockStackStore(load, result.ir, opts);
}

function exactStoredExpression(result, value, astById, active = new Set(), opts = {}) {
  if (!value) return null;
  const valueId = valueOf(value, 'id');
  const key = idKey(valueId);
  if (key == null) return null;
  if (active.has(key)) return null;
  const entry = astById.get(valueId);
  const node = entry?.expression ?? null;
  if (!node) return null;
  const nodeLocation = valueOf(node, 'location');
  if (valueOf(node, 'kind') !== 'load' || valueOf(nodeLocation, 'kind') !== 'stack') return node;

  const definition = valueOf(value, 'def');
  const store = exactLegacyStore(result, definition, node, opts);
  if (!store) return null;
  const stored = valueArgument(store);
  if (!stored) return null;

  active.add(key);
  const resolved = exactStoredExpression(result, stored, astById, active, opts);
  active.delete(key);
  return resolved;
}

export function materializeLegacyExactStackValues(result, opts = {}) {
  if (!result?.ir || !Array.isArray(result?.semanticAst?.values)) return result;
  if (result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;

  const astById = new Map(result.semanticAst.values.map((entry) => [valueOf(entry, 'valueId'), entry]));
  const replacements = [];
  for (const value of result.ir.values ?? []) {
    if (aborted(opts)) return result;
    const entry = astById.get(valueOf(value, 'id'));
    const entryExpression = valueOf(entry, 'expression');
    const expressionLocation = valueOf(entryExpression, 'location');
    if (valueOf(entryExpression, 'kind') !== 'load' || valueOf(expressionLocation, 'kind') !== 'stack') continue;
    const resolved = exactStoredExpression(result, value, astById, new Set(), opts);
    if (!resolved || (valueOf(resolved, 'kind') === 'load' && valueOf(valueOf(resolved, 'location'), 'kind') === 'stack')) continue;
    replacements.push([entry, resolved]);
  }
  if (aborted(opts)) return result;
  for (const [entry, resolved] of replacements) entry.expression = resolved;
  return result;
}
