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

function sourceIds(node, control) {
  const source = valueOf(node, 'source');
  const ids = arrayField(source, 'ir');
  if (!ids.ok) return null;
  const keys = [];
  try {
    for (const id of ids.value) {
      if (control?.isAborted?.()) return null;
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

export function legacyRecoveryControl(opts) {
  const callback = ownData(opts, 'shouldAbort');
  const deadline = ownData(opts, 'deadline');
  const deterministic = ownData(opts, 'deterministicTransforms');
  const timeBudget = ownData(opts, 'decompilerTimeBudgetMs');
  const workBudget = ownData(opts, 'decompilerNodeBudget');
  if (deterministic.present && (!deterministic.valid || typeof deterministic.value !== 'boolean')) {
    return { isAborted:() => true };
  }
  const validDeadline = deadline.present && deadline.valid && typeof deadline.value === 'number'
    && (Number.isFinite(deadline.value) || deadline.value === Infinity);
  if (deadline.present && !validDeadline) return { isAborted:() => true };
  const validTimeBudget = timeBudget.present && timeBudget.valid && typeof timeBudget.value === 'number'
    && Number.isFinite(timeBudget.value) && timeBudget.value >= 0;
  const validWorkBudget = workBudget.present && workBudget.valid && typeof workBudget.value === 'number'
    && Number.isSafeInteger(workBudget.value) && workBudget.value >= 0;
  const started = globalThis.performance?.now ? globalThis.performance.now() : Date.now();
  // Malformed and omitted time budgets retain the finite default below;
  // only explicit deterministic mode disables the wall-clock deadline.
  const callerTimeBudget = validTimeBudget ? timeBudget.value : 50;
  const derivedDeadline = deterministic.value === true ? Infinity : started + callerTimeBudget;
  const effectiveDeadline = validDeadline ? Math.min(deadline.value, derivedDeadline) : derivedDeadline;
  const maxWork = validWorkBudget ? workBudget.value : 12000;
  const callbackFunction = callback.present && callback.valid && typeof callback.value === 'function'
    ? callback.value : null;
  let cancelled = callback.present && (!callback.valid || typeof callback.value !== 'function');
  let work = 0;
  return {
    isAborted() {
      if (cancelled) return true;
      if (deterministic.value !== true) {
        const clock = globalThis.performance?.now ? globalThis.performance.now() : Date.now();
        if (clock >= effectiveDeadline) { cancelled = true; return true; }
      }
      if (work >= maxWork) { cancelled = true; return true; }
      work += 1;
      if (!callbackFunction) return false;
      try {
        if (callbackFunction() === true) { cancelled = true; return true; }
      } catch { cancelled = true; return true; }
      return false;
    },
  };
}

export function exactLegacySameBlockStackStore(load, ir, opts = {}, control = legacyRecoveryControl(opts)) {
  if (control.isAborted()) return null;
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
  if (!instructions.ok) return null;
  let storeOccurrences = 0;
  let loadOccurrences = 0;
  for (const instruction of instructions.value) {
    if (control.isAborted()) return null;
    if (instruction === store) storeOccurrences += 1;
    if (instruction === load) loadOccurrences += 1;
  }
  if (storeOccurrences !== 1 || loadOccurrences !== 1) return null;
  const memoryRows = new Set();
  const memoryMutations = new Map();
  const physicalLoads = new Map();
  for (const inst of instructions.value) {
    if (control.isAborted()) return null;
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
    if (op === 'load') {
      const loadKey = location?.key ?? null;
      const mutations = memoryMutations.get(row) || [];
      if (mutations.some((mutation) => mutation.op !== 'store' || mutation.key == null
          || loadKey == null || mutation.key === loadKey)) return null;
      const loads = physicalLoads.get(row) || [];
      loads.push(loadKey);
      physicalLoads.set(row, loads);
    } else if (['store', 'call', 'clobber', 'unknown'].includes(op)) {
      if (memoryRows.has(row)) return null;
      const locationKey = op === 'store' ? location?.key ?? null : null;
      const loads = physicalLoads.get(row) || [];
      if (loads.some((loadKey) => op !== 'store' || locationKey == null
          || loadKey == null || locationKey === loadKey)) return null;
      memoryRows.add(row);
      const mutations = memoryMutations.get(row) || [];
      mutations.push({ op, key:locationKey });
      memoryMutations.set(row, mutations);
    }
    if (inst === store || inst === load) continue;
    if (row <= storeRow || row >= loadRow) continue;
    if (op === 'call' || op === 'clobber' || op === 'unknown') return null;
    if (op === 'store' && (!location || location.kind === 'unknown' || location.key === loadLocation.key)) return null;
  }
  return store;
}

function exactLegacyStore(result, load, node, opts = {}, control = legacyRecoveryControl(opts)) {
  const loadLocation = stackLocation(load);
  const nodeLocation = valueOf(node, 'location');
  const nodeKey = valueOf(nodeLocation, 'key');
  if (instructionOp(load) !== 'load' || !loadLocation || loadLocation.kind !== 'stack'
      || typeof nodeKey !== 'string' || loadLocation.key !== nodeKey) return null;
  const instructionsField = ownData(result?.ir, 'instructions');
  if (!instructionsField.present || !instructionsField.valid || !Array.isArray(instructionsField.value)) return null;
  const instructions = instructionsField.value;
  let loadOccurrences = 0;
  for (const candidate of instructions) {
    if (control.isAborted()) return null;
    if (candidate === load) loadOccurrences += 1;
  }
  if (loadOccurrences !== 1) return null;
  const ids = sourceIds(node, control);
  const loadId = idKey(valueOf(load, 'id'));
  if (!ids || loadId == null || !ids.includes(loadId)) return null;
  const reaching = ownData(load, 'reachingStore');
  if (!reaching.present || !reaching.valid) return null;
  let reachingOccurrences = 0;
  for (const candidate of instructions) {
    if (control.isAborted()) return null;
    if (candidate === reaching.value) reachingOccurrences += 1;
  }
  if (reachingOccurrences !== 1) return null;
  return exactLegacySameBlockStackStore(load, result.ir, opts, control);
}

function exactStoredExpression(result, value, astById, active = new Set(), opts = {}, control = legacyRecoveryControl(opts)) {
  if (control.isAborted()) return null;
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
  const store = exactLegacyStore(result, definition, node, opts, control);
  if (!store) return null;
  const stored = valueArgument(store);
  if (!stored) return null;

  active.add(key);
  const resolved = exactStoredExpression(result, stored, astById, active, opts, control);
  active.delete(key);
  return resolved;
}

export function materializeLegacyExactStackValues(result, opts = {}) {
  if (!result?.ir || !Array.isArray(result?.semanticAst?.values)) return result;
  if (result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;

  const control = legacyRecoveryControl(opts);
  if (control.isAborted()) return result;
  const astById = new Map();
  for (const entry of result.semanticAst.values) {
    if (control.isAborted()) return result;
    astById.set(valueOf(entry, 'valueId'), entry);
  }
  const replacements = [];
  for (const value of result.ir.values ?? []) {
    if (control.isAborted()) return result;
    const entry = astById.get(valueOf(value, 'id'));
    const entryExpression = valueOf(entry, 'expression');
    const expressionLocation = valueOf(entryExpression, 'location');
    if (valueOf(entryExpression, 'kind') !== 'load' || valueOf(expressionLocation, 'kind') !== 'stack') continue;
    const resolved = exactStoredExpression(result, value, astById, new Set(), opts, control);
    if (!resolved || (valueOf(resolved, 'kind') === 'load' && valueOf(valueOf(resolved, 'location'), 'kind') === 'stack')) continue;
    replacements.push([entry, resolved]);
  }
  if (control.isAborted()) return result;
  for (const [entry, resolved] of replacements) {
    if (control.isAborted()) return result;
    entry.expression = resolved;
  }
  return result;
}
