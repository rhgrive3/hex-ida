import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { exactLegacySameBlockStackStore, legacyRecoveryControl } from './legacy-exact-return-repair.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr, mapChildren, sourceOf } from './ast/nodes.js';
import { printExpression, printProgram } from './pretty/c.js';
import { PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { applyPhase8Projection } from './phase8/projection.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';

export { buildExpressionForTesting } from './pipeline-core.js';
export { exactLegacySameBlockStackStore };

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

function fieldValue(object, key) {
  const field = ownData(object, key);
  return field.present && field.valid ? field.value : undefined;
}

function valueOf(arg) {
  const field = ownData(arg, 'value');
  return field.present && field.valid ? field.value || null : null;
}

function idKey(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function validRow(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validBits(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function positiveSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 8) ? value : null;
}

function arrayField(object, key) {
  const field = ownData(object, key);
  if (!field.present) return { ok:true, value:[] };
  return { ok:field.valid && Array.isArray(field.value), value:field.valid && Array.isArray(field.value) ? field.value : [] };
}

function safeDataProperties(object) {
  const copy = {};
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return copy;
  let keys;
  try { keys = Reflect.ownKeys(object); } catch { return copy; }
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const field = ownData(object, key);
    if (field.present && field.valid) copy[key] = field.value;
  }
  return copy;
}

function validTimeBudget(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validWorkBudget(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedPipelineOptions(options) {
  const safe = safeDataProperties(options);
  for (const [key, valid] of [
    ['decompilerTimeBudgetMs', validTimeBudget],
    ['decompilerNodeBudget', validWorkBudget],
    ['decompilerIterationCap', validWorkBudget],
    ['phase8TimeBudgetMs', validTimeBudget],
    ['phase8WorkBudget', validWorkBudget],
  ]) {
    const field = ownData(options, key);
    if (field.present && (!field.valid || !valid(field.value))) return { blocked:true, options:safe };
    if (field.present && field.value === 0
        && (key !== 'decompilerTimeBudgetMs' || fieldValue(options, 'deterministicTransforms') !== true)) {
      return { blocked:true, options:safe };
    }
  }
  return { blocked:false, options:safe };
}

function sourceIds(node, control) {
  const source = fieldValue(node, 'source');
  const field = ownData(source, 'ir');
  if (!field.present) return [];
  if (!field.valid || !Array.isArray(field.value)) return null;
  const ids = [];
  try {
    for (const id of field.value) {
      if (control?.isAborted?.()) return null;
      const key = idKey(id);
      if (key == null) return null;
      ids.push(key);
    }
  } catch {
    return null;
  }
  return ids;
}

function addressKey(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function strictSource(node) {
  const source = fieldValue(node, 'source');
  const read = (key, converter) => {
    const field = ownData(source, key);
    if (!field.present) return [];
    if (!field.valid || !Array.isArray(field.value)) return null;
    const values = [];
    try {
      for (const value of field.value) {
        const converted = converter(value);
        if (converted == null) return null;
        values.push(converted);
      }
    } catch { return null; }
    return values;
  };
  const rows = read('rows', (value) => validRow(value) ? value : null);
  const addresses = read('addresses', addressKey);
  const ir = read('ir', idKey);
  if (rows == null || addresses == null || ir == null) return null;
  return { ...sourceOf({ rows, addresses, ir }), rows, addresses, ir };
}

function recoveryAborted(opts) {
  const callback = ownData(opts, 'shouldAbort');
  const deadline = ownData(opts, 'deadline');
  const deterministic = ownData(opts, 'deterministicTransforms');
  if (deterministic.present && (!deterministic.valid || typeof deterministic.value !== 'boolean')) return true;
  if (deadline.present && (!deadline.valid || typeof deadline.value !== 'number'
      || (!Number.isFinite(deadline.value) && deadline.value !== Infinity))) return true;
  if (deterministic.value !== true && deadline.present) {
    const clock = globalThis.performance?.now ? globalThis.performance.now() : Date.now();
    if (clock >= deadline.value) return true;
  }
  if (!callback.present) return false;
  if (!callback.valid || typeof callback.value !== 'function') return true;
  try { return callback.value() === true; } catch { return true; }
}

const INVERSE_CONDITION = {
  eq:'ne', ne:'eq', hs:'lo', lo:'hs', cs:'cc', cc:'cs',
  hi:'ls', ls:'hi', ge:'lt', lt:'ge', gt:'le', le:'gt',
  mi:'pl', pl:'mi', vs:'vc', vc:'vs',
};

function isZeroValue(value) {
  return value?.const === 0n || (value?.def?.op === 'const' && (value.def.extra?.value ?? value.const) === 0n);
}

/* pipeline-core expresses ordinary CMP relations but intentionally leaves raw
 * N-flag conditions conservative. For the extremely common `cmp value,#0`, MI
 * and PL are exactly signed `< 0` and `>= 0`, so normalize them to the relational
 * conditions the semantic AST already models. */
function relationalSignCondition(inst, cond) {
  if (cond !== 'mi' && cond !== 'pl') return cond;
  const flags = valueOf(inst?.args?.[2] || inst?.args?.at?.(-1));
  const compare = flags?.def;
  if (compare?.op !== 'cmp' || compare?.sub !== 'sub' || !isZeroValue(valueOf(compare.args?.[1]))) return cond;
  return cond === 'mi' ? 'lt' : 'ge';
}

/* CNEG/CINC/CINV are aliases of CSNEG/CSINC/CSINV with the condition inverted. */
function normalizeConditionalSelectAliases(ir) {
  const changes = [];
  const alias = { cneg:'neg', cinc:'inc', cinv:'inv' };
  for (const inst of ir?.instructions || []) {
    const replacement = alias[inst?.sub];
    if (replacement) {
      let inverse = INVERSE_CONDITION[inst.cond];
      if (!inverse) continue;
      inverse = relationalSignCondition(inst, inverse);
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.sub = replacement;
      inst.cond = inverse;
      continue;
    }
    const relational = relationalSignCondition(inst, inst?.cond);
    if (relational !== inst?.cond) {
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.cond = relational;
    }
  }
  return () => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const { inst, sub, cond } = changes[i];
      inst.sub = sub;
      inst.cond = cond;
    }
  };
}

function constrainSemanticValueWidths(result) {
  if (!result?.semanticAst?.values || !result?.ir?.values) return result;
  const irValues = new Map();
  for (const value of result.ir.values) {
    const id = idKey(fieldValue(value, 'id'));
    if (id == null) continue;
    if (irValues.has(id)) irValues.set(id, null);
    else irValues.set(id, value);
  }
  for (const item of result.semanticAst.values) {
    const valueId = idKey(fieldValue(item, 'valueId'));
    const value = valueId == null ? null : irValues.get(valueId);
    const node = fieldValue(item, 'expression');
    const targetBits = fieldValue(value, 'bits');
    const sourceBits = fieldValue(node, 'bits');
    if (!node || !validBits(targetBits) || !validBits(sourceBits) || sourceBits <= targetBits) continue;
    item.expression = expr.unary('trunc', node, targetBits, fieldValue(value, 'signed') ?? fieldValue(node, 'signed') ?? null, fieldValue(node, 'source'),
      { fromBits: sourceBits, proof: 'SSA value width after Memory-SSA substitution' });
  }
  return result;
}

function canonicalScalarReturnRegister(result, opts = {}) {
  const adapter = opts.abiAdapter || result?.abiAdapter || result?.ctx?.abiAdapter || null;
  const returnType = opts.returnType
    ?? opts.functionPrototype?.returnType
    ?? opts.prototype?.returnType
    ?? result?.prototype?.returnType
    ?? result?.types?.ret?.type
    ?? null;
  const returnBits = opts.returnBits
    ?? opts.functionPrototype?.returnBits
    ?? opts.prototype?.returnBits
    ?? result?.prototype?.returnBits
    ?? result?.types?.ret?.bits
    ?? null;
  if (adapter?.supported === true) {
    try {
      const functionPrototype = {
        ...(opts.functionPrototype || opts.prototype || result?.prototype || {}),
        ...(returnType != null ? { returnType } : {}),
        ...(returnBits != null ? { returnBits } : {}),
        returnsValue:true,
      };
      const locations = adapter.returnLocations?.({ functionPrototype, returnType, returnBits });
      if (Array.isArray(locations)) {
        return locations.length === 1 && locations[0]?.kind === 'register'
          && locations[0]?.aggregate !== true && typeof locations[0]?.reg === 'string'
          ? locations[0].reg : null;
      }
    } catch { return null; }
    return null;
  }
  if (adapter) return null;
  // The old ARM64 facade predates the canonical ABI envelope. Preserve its
  // presentation-only fallback, while a v2 IR without an adapter remains
  // unknown rather than inheriting AAPCS64's x0 return register.
  if (opts.legacyAArch64 === true || result?.ir?.compat?.projection !== 'semantic-ir-v2-to-v1') return 'x0';
  return null;
}

function latestReturnStackLoad(ir, ret, returnRegister) {
  const instructions = arrayField(ir, 'instructions');
  const retArgs = arrayField(ret, 'args');
  if (!instructions.ok || !retArgs.ok) return null;
  const explicit = valueOf(retArgs.value[0]);
  const explicitDefinition = fieldValue(explicit, 'def');
  const explicitLocation = fieldValue(explicitDefinition, 'loc');
  if (fieldValue(explicitDefinition, 'op') === 'load' && fieldValue(explicitLocation, 'kind') === 'stack'
      && instructions.value.filter((instruction) => instruction === explicitDefinition).length === 1
      && validRow(fieldValue(explicitDefinition, 'row')) && validRow(fieldValue(explicitDefinition, 'block'))) {
    return { value: explicit, load: explicitDefinition };
  }

  // For implicit ABI returns, only the actual latest reaching definition of the
  // canonical return register may authorize a stack-load re-anchor. A
  // historical stack load is not return truth when a later ADD/SUB/call/etc.
  // redefines that register (#914). Never substitute AAPCS64's x0 here: on
  // RISC-V it is the hardwired zero register.
  if (!returnRegister) return null;
  let value = null, bestRow = -Infinity;
  const values = arrayField(ir, 'values');
  const retRow = fieldValue(ret, 'row');
  if (!values.ok || !validRow(retRow)) return null;
  for (const candidate of values.value) {
    const def = fieldValue(candidate, 'def');
    const defRow = fieldValue(def, 'row');
    const defBlock = fieldValue(def, 'block');
    if (fieldValue(candidate, 'reg') !== returnRegister || !def || defRow >= retRow
        || !validRow(defRow) || !validRow(defBlock)
        || instructions.value.filter((instruction) => instruction === def).length !== 1) continue;
    if (defRow > bestRow) { value = candidate; bestRow = defRow; }
  }
  const valueDefinition = fieldValue(value, 'def');
  return fieldValue(valueDefinition, 'op') === 'load'
    && fieldValue(fieldValue(valueDefinition, 'loc'), 'kind') === 'stack'
    ? { value, load:valueDefinition } : null;
}

function reanchorExactStackReturn(result, opts = {}) {
  if (!result?.semanticAst || !result?.ir) return result;
  const instructions = arrayField(result.ir, 'instructions');
  if (!instructions.ok) return result;
  const ret = [...instructions.value].reverse().find((inst) => fieldValue(inst, 'op') === 'ret');
  const returnRegister = canonicalScalarReturnRegister(result, opts);
  const found = ret ? latestReturnStackLoad(result.ir, ret, returnRegister) : null;
  const load = found?.load;
  const loadLocation = fieldValue(load, 'loc');
  const loadKey = fieldValue(loadLocation, 'key');
  if (!load || typeof loadKey !== 'string' || loadKey.length === 0) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;
  const { value } = found;
  const valueBitsField = ownData(value, 'bits');
  const loadSizeField = ownData(loadLocation, 'size');
  const instructionSizeField = ownData(load, 'size');
  if (valueBitsField.present && (!valueBitsField.valid || !validBits(valueBitsField.value))) return result;
  const loadSize = loadSizeField.present ? loadSizeField : instructionSizeField;
  if (loadSize.present && (!loadSize.valid || positiveSize(loadSize.value) == null)) return result;
  const bits = valueBitsField.present ? valueBitsField.value : loadSize.present ? loadSize.value * 8 : 64;
  const loadId = fieldValue(load, 'id');
  const valueId = fieldValue(value, 'id');
  output.expression = expr.load({ kind:'stack', key:loadKey, name:fieldValue(loadLocation, 'name') || `stack_${loadKey}`, text:fieldValue(loadLocation, 'name') || `stack_${loadKey}` },
    bits, {
      address:fieldValue(load, 'address'), row:fieldValue(load, 'row'), ir:loadId, ssaDef:valueId ?? null,
      evidence:[{ reason:'SSA return stack load re-anchor' }],
    }, { signed:fieldValue(load, 'signed') ?? fieldValue(value, 'signed') ?? null });
  return result;
}

/* Legacy-v1 keeps its historical MemorySSA `reachingStore` pointer. Use that
 * existing proof only for a trivially ordered same-block fixed-stack spill.
 * No CFG/path inference is added here, and any call/unknown barrier keeps the
 * load explicit. This is intentionally narrower than canonical v2 forwarding. */
function recoverLegacySameBlockStackSpills(result, opts = {}, control = legacyRecoveryControl(opts)) {
  if (!result?.semanticAst || !result?.ir || result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;
  if (control.isAborted()) return result;
  const instructionById = new Map();
  for (const inst of result.ir.instructions || []) {
    if (control.isAborted()) return result;
    const id = idKey(fieldValue(inst, 'id'));
    if (id == null) continue;
    if (instructionById.has(id)) instructionById.set(id, null);
    else instructionById.set(id, inst);
  }
  const expressions = new Map();
  for (const item of result.semanticAst.values || []) {
    if (control.isAborted()) return result;
    const id = idKey(fieldValue(item, 'valueId'));
    if (id != null) expressions.set(id, fieldValue(item, 'expression'));
  }
  const active = new Set();
  let scanAborted = false;

  const rewrite = (node, depth = 0) => {
    if (control.isAborted()) { scanAborted = true; return node; }
    if (!node || depth > 64) return node;
    const nodeLocation = fieldValue(node, 'location');
    const nodeKey = fieldValue(nodeLocation, 'key');
    if (fieldValue(node, 'kind') === 'load' && fieldValue(nodeLocation, 'kind') === 'stack'
        && typeof nodeKey === 'string' && nodeKey.length > 0) {
      const ids = sourceIds(node, control);
      if (!ids || ids.length !== 1) return node;
      const load = instructionById.get(ids[0]);
      const loadLocation = fieldValue(load, 'loc');
      if (!load || fieldValue(load, 'op') !== 'load'
          || fieldValue(loadLocation, 'key') !== nodeKey) return node;
      const store = exactLegacySameBlockStackStore(load, result.ir, opts, control);
      const args = fieldValue(store, 'args');
      const storedValue = Array.isArray(args) ? valueOf(args[0]) : null;
      if (!storedValue) return node;
      const key = idKey(fieldValue(storedValue, 'id'));
      if (key == null) return node;
      if (active.has(key)) return node;
      const replacement = expressions.get(key);
      if (!replacement) return node;
      active.add(key);
      let resolved = rewrite(replacement, depth + 1);
      active.delete(key);
      if (scanAborted) return node;
      const storeSize = fieldValue(fieldValue(store, 'loc'), 'size');
      const storeBits = typeof storeSize === 'number' && Number.isSafeInteger(storeSize) && storeSize > 0
        && storeSize <= Math.floor(Number.MAX_SAFE_INTEGER / 8) ? storeSize * 8 : 0;
      const resolvedBits = typeof resolved?.bits === 'number' && Number.isSafeInteger(resolved.bits)
        && resolved.bits > 0 ? resolved.bits : storeBits;
      if (storeBits > 0 && resolvedBits > storeBits) {
        resolved = expr.unary('trunc', resolved, storeBits, resolved.signed ?? null, {
          address:fieldValue(store, 'address'),
          row:fieldValue(store, 'row'),
          ir:fieldValue(store, 'id'),
          evidence:[{ reason:`exact ${storeBits}-bit legacy stack store width` }],
        }, { fromBits:resolvedBits });
      }
      return resolved;
    }
    return mapChildren(node, (child) => rewrite(child, depth + 1));
  };

  const valueChanges = [];
  for (const item of result.semanticAst.values || []) {
    if (control.isAborted()) return result;
    const original = fieldValue(item, 'expression');
    const resolved = rewrite(original);
    if (scanAborted) return result;
    if (resolved !== original) valueChanges.push({ item, original, resolved });
    const id = idKey(fieldValue(item, 'valueId'));
    if (id != null) expressions.set(id, resolved);
  }
  const outputChanges = [];
  for (const output of result.semanticAst.outputs || []) {
    if (control.isAborted()) return result;
    const original = fieldValue(output, 'expression');
    if (!original) continue;
    const resolved = rewrite(original);
    if (scanAborted) return result;
    if (resolved !== original) outputChanges.push({ output, original, resolved });
  }

  const nodeChanges = [];
  for (const node of result.cAst?.body || []) {
    if (control.isAborted()) return result;
    const semantic = fieldValue(node, 'semantic');
    const text = fieldValue(node, 'text');
    if (!(fieldValue(semantic, 'op') === 'return'
      || (typeof text === 'string' && /^return\b/.test(text.trim())))) continue;
    const expression = fieldValue(semantic, 'expression');
    if (!expression) continue;
    const resolved = rewrite(expression);
    if (scanAborted) return result;
    if (resolved !== expression) nodeChanges.push({ node, expression, resolved, text:node.text });
  }
  const rollback = () => {
    for (const { item, original } of valueChanges) item.expression = original;
    for (const { output, original } of outputChanges) output.expression = original;
    for (const { node, expression, text } of nodeChanges) {
      if (node.semantic) node.semantic.expression = expression;
      node.text = text;
    }
  };
  if (control.isAborted()) return result;
  for (const { item, resolved } of valueChanges) {
    if (control.isAborted()) { rollback(); return result; }
    item.expression = resolved;
  }
  for (const { output, resolved } of outputChanges) {
    if (control.isAborted()) { rollback(); return result; }
    output.expression = resolved;
  }
  for (const { node, resolved } of nodeChanges) {
    if (control.isAborted()) { rollback(); return result; }
    if (node.semantic) node.semantic.expression = resolved;
    node.text = `return ${printExpression(resolved)};`;
  }
  if (control.isAborted()) {
    rollback();
    return result;
  }
  const printedChanged = nodeChanges.length > 0;
  if (!printedChanged) return result;
  const columnWidth = fieldValue(opts, 'columnWidth') || fieldValue(opts, 'prettyColumnWidth') || 88;
  const printed = printProgram(result.cAst, { columnWidth });
  if (control.isAborted()) {
    rollback();
    return result;
  }
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:printed.mapping.length };
  return result;
}

/* When a return stack LOAD has a proven same-slot reaching STORE, the spill
 * STORE remains proof provenance but does not own the reconstructed C return
 * statement after the stack temporary has been eliminated. Drop only that one
 * statement-level source row; every other source/proof entry is preserved. */
function reanchorRecoveredReturnSource(result, opts = {}) {
  if (!result?.ir || !result?.cAst) return result;
  const instructionField = ownData(result.ir, 'instructions');
  const bodyField = ownData(result.cAst, 'body');
  if (!instructionField.present || !instructionField.valid || !Array.isArray(instructionField.value)
      || !bodyField.present || !bodyField.valid || !Array.isArray(bodyField.value)) return result;
  const instructions = instructionField.value;
  const ret = [...instructions].reverse().find((inst) => fieldValue(inst, 'op') === 'ret');
  const retRow = fieldValue(ret, 'row');
  if (!ret || !validRow(retRow)) return result;

  const storeForFact = (load, fact) => {
    if (!fact || !load) return null;
    const contributorField = ownData(fact, 'contributingDefinitionIds');
    if (!contributorField.present || !contributorField.valid || !Array.isArray(contributorField.value)) return null;
    const contributors = new Set();
    for (const definitionId of contributorField.value) {
      const key = idKey(definitionId);
      if (key == null) return null;
      contributors.add(key);
    }
    const loadLocation = fieldValue(load, 'loc');
    const loadKey = fieldValue(loadLocation, 'key');
    if (typeof loadKey !== 'string' || loadKey.length === 0) return null;
    const matches = instructions.filter((candidate) => {
      const location = fieldValue(candidate, 'loc');
      const memDef = fieldValue(candidate, 'memDef');
      const extra = fieldValue(candidate, 'extra');
      const definitionId = fieldValue(memDef, 'definitionId') ?? fieldValue(extra, 'memoryDefinitionId');
      return fieldValue(candidate, 'op') === 'store'
        && fieldValue(location, 'kind') === 'stack'
        && fieldValue(location, 'key') === loadKey
        && validRow(fieldValue(candidate, 'row'))
        && idKey(definitionId) != null
        && contributors.has(idKey(definitionId));
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const changes = [];
  for (const node of bodyField.value) {
    if (recoveryAborted(opts)) return result;
    const semantic = fieldValue(node, 'semantic');
    const text = fieldValue(node, 'text');
    const isReturn = fieldValue(semantic, 'op') === 'return'
      || (typeof text === 'string' && /^return\b/.test(text.trim()));
    if (!isReturn || (typeof text === 'string' && /\blocal_[0-9A-F]+\b/i.test(text))) continue;
    const current = strictSource(node);
    if (!current) continue;
    const sourceRows = new Set(current.rows);
    let load = null;
    for (const inst of instructions) {
      if (recoveryAborted(opts)) return result;
      const location = fieldValue(inst, 'loc');
      const row = fieldValue(inst, 'row');
      if (fieldValue(inst, 'op') !== 'load' || fieldValue(location, 'kind') !== 'stack'
          || !validRow(row) || row >= retRow || !sourceRows.has(row)) continue;
      const directReaching = ownData(inst, 'reachingStore');
      let store = null;
      if (directReaching.present && directReaching.valid && directReaching.value
          && instructions.filter((candidate) => candidate === directReaching.value).length === 1) {
        const directLocation = fieldValue(directReaching.value, 'loc');
        if (fieldValue(directReaching.value, 'op') === 'store'
            && fieldValue(directLocation, 'kind') === 'stack'
            && fieldValue(directLocation, 'key') === fieldValue(location, 'key')) {
          store = directReaching.value;
        }
      } else {
        const extra = fieldValue(inst, 'extra');
        const fact = fieldValue(inst, 'memoryForwarding') ?? fieldValue(extra, 'memoryForwarding');
        try {
          if (fact && isCanonicalExactMemoryForwarding(fact,
            canonicalMemoryForwardingContextForLoad(fact, inst,
              fieldValue(inst, 'memoryForwardingContext') ?? fieldValue(extra, 'memoryForwardingContext')))) {
            store = storeForFact(inst, fact);
          }
        } catch { store = null; }
      }
      const storeRow = fieldValue(store, 'row');
      if (!store || !validRow(storeRow) || !sourceRows.has(storeRow)) continue;
      if (!load || row > fieldValue(load, 'row')) load = inst;
    }
    const spillFact = fieldValue(load, 'memoryForwarding')
      ?? fieldValue(fieldValue(load, 'extra'), 'memoryForwarding');
    let spill = null;
    const directSpill = ownData(load, 'reachingStore');
    if (directSpill.present && directSpill.valid && directSpill.value
        && instructions.filter((candidate) => candidate === directSpill.value).length === 1) {
      const loadLocation = fieldValue(load, 'loc');
      const spillLocation = fieldValue(directSpill.value, 'loc');
      if (fieldValue(directSpill.value, 'op') === 'store'
          && fieldValue(spillLocation, 'kind') === 'stack'
          && fieldValue(spillLocation, 'key') === fieldValue(loadLocation, 'key')) {
        spill = directSpill.value;
      }
    } else {
      try {
        if (load && spillFact && isCanonicalExactMemoryForwarding(spillFact,
          canonicalMemoryForwardingContextForLoad(spillFact, load,
            fieldValue(load, 'memoryForwardingContext') ?? fieldValue(fieldValue(load, 'extra'), 'memoryForwardingContext')))) {
          spill = storeForFact(load, spillFact);
        }
      } catch { spill = null; }
    }
    const spillRow = fieldValue(spill, 'row');
    const loadRow = fieldValue(load, 'row');
    if (!load || !spill || !validRow(spillRow) || !validRow(loadRow)) continue;
    const alignedAddresses = current.addresses.length === current.rows.length;
    const alignedIr = current.ir.length === current.rows.length;
    changes.push({ node, previous:fieldValue(node, 'source'), next:{
      ...current,
      rows:current.rows.filter((row) => row !== spillRow),
      addresses:alignedAddresses
        ? current.addresses.filter((_, index) => current.rows[index] !== spillRow)
        : current.addresses,
      ir:alignedIr
        ? current.ir.filter((_, index) => current.rows[index] !== spillRow)
        : current.ir,
      evidence:[...(current.evidence || []), { reason:'eliminated stack spill is proof-only provenance' }],
    }});
  }
  if (recoveryAborted(opts) || !changes.length) return result;
  for (const change of changes) change.node.source = change.next;
  if (recoveryAborted(opts)) {
    for (const change of changes) change.node.source = change.previous;
    return result;
  }
  const columnWidth = fieldValue(opts, 'columnWidth') || fieldValue(opts, 'prettyColumnWidth') || 88;
  const printed = printProgram(result.cAst, { columnWidth });
  if (recoveryAborted(opts)) {
    for (const change of changes) change.node.source = change.previous;
    return result;
  }
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:result.sourceMap?.length || 0 };
  return result;
}

function fullPhase8Projection(result, model, opts) {
  if (opts.phase8Optimize !== true || !result?.semantic || !result?.ir) return result;
  const stage = runPhase8Stage(
    { ir:result.ir, types:result.types, opts },
    {
      stages:PHASE8_ALL_STAGES,
      ...(opts.phase8TimeBudgetMs != null ? { timeBudgetMs:Number(opts.phase8TimeBudgetMs) } : {}),
      ...(opts.phase8WorkBudget != null ? { maxWorkItems:opts.phase8WorkBudget } : {}),
      shouldAbort:opts.shouldAbort,
      budgetClass:'standard',
    },
  );
  const priorPipeline = result.ctx?.decompilerPipeline || {};
  let updated = {
    ...result,
    phase8:stage.ledger,
    ctx:{
      ...(result.ctx || {}),
      decompilerPipeline:{
        ...priorPipeline,
        completeness:stage.ledger?.published === true && stage.ledger?.completeness === 'complete'
          ? priorPipeline.completeness
          : 'partial',
        phase8:stage.ledger,
        phase8Timings:stage.timings,
        phase8ElapsedMs:stage.elapsedMs,
      },
    },
  };
  if (stage.ledger?.published !== true || stage.ledger?.completeness !== 'complete' || !stage.analysis) return updated;
  updated = applyPhase8Projection(updated, stage.analysis, opts);
  return updated;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const bounded = boundedPipelineOptions(opts);
  if (bounded.blocked) return result;
  const safeOpts = bounded.options;
  const restore = normalizeConditionalSelectAliases(result?.ir);
  let core;
  try {
    // The final Phase 8 path executes the full optimizer set once below, after
    // the existing representation pipeline reaches its stable AST. The core is
    // kept on its interactive/canonical lane here so the optimizer is not run
    // twice and does not borrow the PassManager rewrite deadline.
    core = constrainSemanticValueWidths(enhanceCore(result, model, { ...safeOpts, phase8Optimize:false }));
  } finally { restore(); }
  const reanchored = reanchorExactStackReturn(core, safeOpts);
  const legacySpillsRecovered = recoverLegacySameBlockStackSpills(reanchored, safeOpts);
  const stackPhiRecovered = recoverExactStackPhiExpressions(legacySpillsRecovered, safeOpts);
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(stackPhiRecovered, safeOpts), safeOpts);
  return fullPhase8Projection(reanchorRecoveredReturnSource(recovered, safeOpts), model, safeOpts);
}
