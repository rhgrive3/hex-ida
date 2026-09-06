import { expr, structuralKey } from '../ast/nodes.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression } from '../flag-semantics.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../../semantics/memoryssa/queries.js';

const INVERSE = Object.freeze({ eq:'ne', ne:'eq', lt:'ge', le:'gt', gt:'le', ge:'lt' });
const EXACT_VIEW_MOV_SUBS = new Set([null, 'copy', 'bitcast', 'trunc', 'zext']);

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

function valueOf(a) {
  const field = ownData(a, 'value');
  return field.present && field.valid ? field.value || null : null;
}

function validRow(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validBlock(value) { return validRow(value); }

function validBits(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function idKey(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function addressKey(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function arrayField(object, key) {
  const field = ownData(object, key);
  if (!field.present) return { ok:true, value:[] };
  return { ok:field.valid && Array.isArray(field.value), value:field.valid && Array.isArray(field.value) ? field.value : [] };
}

function sourceValues(node, key, converter, control) {
  const source = fieldValue(node, 'source');
  const values = arrayField(source, key);
  if (!values.ok) return null;
  const converted = [];
  try {
    for (const value of values.value) {
      if (control?.isAborted?.()) return null;
      const convertedValue = converter(value);
      if (convertedValue == null) return null;
      converted.push(convertedValue);
    }
  } catch {
    return null;
  }
  return converted;
}

function validTimeBudget(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validWorkBudget(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function now() { return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }

function recoveryControl(opts) {
  const abortField = ownData(opts, 'shouldAbort');
  const deadlineField = ownData(opts, 'deadline');
  const deterministicField = ownData(opts, 'deterministicTransforms');
  const timeBudgetField = ownData(opts, 'decompilerTimeBudgetMs');
  const workBudgetField = ownData(opts, 'decompilerNodeBudget');
  const validDeadline = deadlineField.present && deadlineField.valid
    && typeof deadlineField.value === 'number'
    && (Number.isFinite(deadlineField.value) || deadlineField.value === Infinity);
  const deterministic = deterministicField.present && deterministicField.valid
    && deterministicField.value === true;
  const validCallerTimeBudget = timeBudgetField.present && timeBudgetField.valid
    && typeof timeBudgetField.value === 'number' && Number.isFinite(timeBudgetField.value)
    && timeBudgetField.value >= 0;
  const validCallerWorkBudget = workBudgetField.present && workBudgetField.valid
    && typeof workBudgetField.value === 'number' && Number.isSafeInteger(workBudgetField.value)
    && workBudgetField.value >= 0;
  let cancelled = (abortField.present && (!abortField.valid || typeof abortField.value !== 'function'))
    || (deadlineField.present && !validDeadline)
    || (deterministicField.present && (!deterministicField.valid || typeof deterministicField.value !== 'boolean'));
  const callback = abortField.present && abortField.valid && typeof abortField.value === 'function'
    ? abortField.value : null;
  const started = now();
  const callerTimeBudget = validCallerTimeBudget ? timeBudgetField.value : 50;
  const callerWorkBudget = validCallerWorkBudget ? workBudgetField.value : 12000;
  // Invalid or omitted caller budgets retain the finite default deadline;
  // structural proof scans remain bounded in every interactive mode.
  const derivedDeadline = !deterministic ? started + callerTimeBudget : Infinity;
  const deadline = validDeadline ? Math.min(deadlineField.value, derivedDeadline) : derivedDeadline;
  let workUsed = 0;
  const isAborted = () => {
    if (cancelled) return true;
    if (!deterministic && now() >= deadline) { cancelled = true; return true; }
    if (workUsed >= callerWorkBudget) { cancelled = true; return true; }
    workUsed += 1;
    if (!callback) return false;
    try {
      if (callback() === true) { cancelled = true; return true; }
    } catch {
      cancelled = true;
      return true;
    }
    return false;
  };
  return {
    deterministic,
    isAborted,
    engineContext: {
      deterministicTransforms:deterministic,
      deadline,
      shouldAbort:isAborted,
    },
  };
}

function positiveAccessSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 8) ? value : null;
}

const MEMORY_LOCATION_KINDS = new Set(['stack', 'global', 'field', 'unknown']);
const MEMORY_WRITE_SCOPES = new Set(['none', 'accesses', 'all', 'unknown']);

function canonicalMemoryKill(location) {
  if (location == null || typeof location !== 'object' || Array.isArray(location)) return null;
  const kindField = ownData(location, 'kind');
  const keyField = ownData(location, 'key');
  const sizeField = ownData(location, 'size');
  if (!kindField.present || !kindField.valid || !MEMORY_LOCATION_KINDS.has(kindField.value)
      || !keyField.present || !keyField.valid || typeof keyField.value !== 'string'
      || keyField.value.length === 0
      || !sizeField.present || !sizeField.valid
      || (sizeField.value !== null && positiveAccessSize(sizeField.value) == null)) return null;
  return { kind:kindField.value, key:keyField.value, size:sizeField.value };
}

function authenticatedCallMemoryEffect(inst, control) {
  const extra = fieldValue(inst, 'extra');
  const completeness = fieldValue(extra, 'callCompleteness');
  const memoryWrite = fieldValue(extra, 'memoryWrite');
  const scope = fieldValue(memoryWrite, 'scope');
  // `memKills` is a projection of the canonical memory effect.  Its absence
  // is safe only for a complete call whose canonical summary explicitly says
  // it writes no memory.  A bare array, even an empty one, is not authority.
  if (completeness !== 'complete' || memoryWrite == null || typeof memoryWrite !== 'object'
      || Array.isArray(memoryWrite) || !MEMORY_WRITE_SCOPES.has(scope)) return null;
  if (scope === 'none') {
    if (fieldValue(inst, 'memoryBarrier') === true) return null;
    const killsField = ownData(inst, 'memKills');
    if (killsField.present && (!killsField.valid || !Array.isArray(killsField.value) || killsField.value.length)) return null;
    return [];
  }
  const killsField = ownData(inst, 'memKills');
  if (!killsField.present || !killsField.valid || !Array.isArray(killsField.value)
      || killsField.value.length === 0) return null;
  const kills = [];
  for (const location of killsField.value) {
    if (control?.isAborted?.()) return null;
    const canonical = canonicalMemoryKill(location);
    if (!canonical) return null;
    kills.push(canonical);
  }
  return kills;
}

function mapsOf(result, control) {
  const values = new Map();
  for (const value of result.semanticAst?.values || []) {
    if (control?.isAborted?.()) return null;
    const id = fieldValue(value, 'valueId');
    if (id != null) values.set(id, fieldValue(value, 'expression'));
  }
  return values;
}

function fitWidth(node, bits, source = null) {
  if (!node || typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits <= 0) return node;
  const nodeBitsField = ownData(node, 'bits');
  if (nodeBitsField.present && (!nodeBitsField.valid || !validBits(nodeBitsField.value))) return null;
  const nodeBits = nodeBitsField.present ? nodeBitsField.value : bits;
  if (nodeBits <= bits) return node;
  return expr.unary('trunc', node, bits, fieldValue(node, 'signed') ?? null, source || fieldValue(node, 'source'), { fromBits:nodeBits });
}

function expressionOf(value, values) {
  const valueId = fieldValue(value, 'id');
  const node = value && valueId != null ? values.get(valueId) || null : null;
  const bitsField = ownData(value, 'bits');
  if (value && bitsField.present
      && (!bitsField.valid || (typeof bitsField.value !== 'number'
        || !Number.isSafeInteger(bitsField.value) || bitsField.value <= 0))) return null;
  return node ? fitWidth(node, bitsField.present ? bitsField.value : undefined, {
    row:fieldValue(fieldValue(value, 'def'), 'row') ?? null,
    address:fieldValue(fieldValue(value, 'def'), 'address') ?? null,
    ir:fieldValue(fieldValue(value, 'def'), 'id') ?? null,
    ssaUse:fieldValue(value, 'id') ?? null,
    evidence:[{ reason:'SSA value-width boundary' }],
  }) : null;
}

function simplify(node, engine, control) {
  if (!node || control?.isAborted?.()) return null;
  const rewritten = engine.rewrite(node, control?.engineContext || {}).root;
  return control?.isAborted?.() ? null : rewritten;
}

function invert(node) {
  if (node?.kind === 'compare' && INVERSE[node.op]) {
    return expr.compare(INVERSE[node.op], node.left, node.right, node.compareSigned, node.source);
  }
  return expr.unary('lnot', node, 1, false, node?.source);
}

function sameRowArithmetic(ir, cmp, control) {
  if (control?.isAborted?.()) return null;
  const cmpRow = fieldValue(cmp, 'row');
  if (!validRow(cmpRow)) return null;
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok) return null;
  const cmpIndex = instructions.value.indexOf(cmp);
  if (cmpIndex < 0) return null;
  let best = null;
  let bestIndex = -1;
  for (let index = 0; index < cmpIndex; index++) {
    if (control?.isAborted?.()) return null;
    const inst = instructions.value[index];
    if (fieldValue(inst, 'op') !== 'bin' || fieldValue(inst, 'row') !== cmpRow
        || fieldValue(inst, 'sub') !== fieldValue(cmp, 'sub')) continue;
    const args = arrayField(inst, 'args');
    if (!args.ok || args.value.length < 2) continue;
    if (index > bestIndex) { best = inst; bestIndex = index; }
  }
  return best;
}

function compareFromFlags(ir, flagsValue, cond, values, control) {
  if (control?.isAborted?.()) return null;
  const cmp = fieldValue(flagsValue, 'def');
  if (fieldValue(cmp, 'op') !== 'cmp') return null;

  // Flag-setting arithmetic is lifted as BIN then CMP on the same ARM64 row.
  // SSA renaming can make CMP read the just-written destination. The preceding
  // same-row BIN is an exact proof of the original flag-producing operands.
  const cmpArgs = arrayField(cmp, 'args');
  if (!cmpArgs.ok) return null;
  const arithmetic = sameRowArithmetic(ir, cmp, control);
  const arithmeticArgs = arithmetic ? arrayField(arithmetic, 'args') : { ok:false, value:[] };
  const leftValue = valueOf(arithmeticArgs.ok ? arithmeticArgs.value[0] : cmpArgs.value[0]);
  const rightValue = valueOf(arithmeticArgs.ok ? arithmeticArgs.value[1] : cmpArgs.value[1]);
  const left = expressionOf(leftValue, values);
  const right = expressionOf(rightValue, values);
  if (!left || !right) return null;
  const cmpBits = fieldValue(cmp, 'bits');
  const leftValueBits = fieldValue(leftValue, 'bits');
  const rightValueBits = fieldValue(rightValue, 'bits');
  const leftBits = fieldValue(left, 'bits');
  const rightBits = fieldValue(right, 'bits');
  if ((cmpBits != null && !validBits(cmpBits)) || (leftValueBits != null && !validBits(leftValueBits))
      || (rightValueBits != null && !validBits(rightValueBits))
      || (leftBits != null && !validBits(leftBits)) || (rightBits != null && !validBits(rightBits))) return null;
  const bits = cmpBits || leftValueBits || rightValueBits || leftBits || rightBits || 64;

  const leftId = idKey(fieldValue(leftValue, 'id'));
  const rightId = idKey(fieldValue(rightValue, 'id'));
  return buildNZCVConditionExpression(fieldValue(cmp, 'sub') || 'sub', cond, left, right, bits, {
    address: fieldValue(cmp, 'address'),
    row: fieldValue(cmp, 'row'),
    ir: fieldValue(cmp, 'id'),
    ssaUses: [leftId, rightId].filter((x) => x != null),
    evidence: [{ reason: arithmetic ? 'same-row flag-producing arithmetic operands' : 'NZCV compare operands' }],
  });
}

function branchCondition(ir, term, values, control) {
  if (control?.isAborted?.()) return null;
  const extra = fieldValue(term, 'extra');
  const kind = fieldValue(extra, 'kind') || fieldValue(term, 'sub') || '';
  const termArgs = arrayField(term, 'args');
  if (!termArgs.ok) return null;
  const tested = valueOf(termArgs.value[0]);

  if (kind === 'cbz' || kind === 'cbnz') {
    const x = expressionOf(tested, values);
    const xBits = fieldValue(x, 'bits');
    if (!x || !validBits(xBits)) return null;
    return expr.compare(kind === 'cbz' ? 'eq' : 'ne', x, expr.constant(0, xBits), null, fieldValue(term, 'source'));
  }

  if (kind === 'tbz' || kind === 'tbnz') {
    const select = fieldValue(tested, 'def');
    if (fieldValue(select, 'op') === 'sel' && ['set', 'setm'].includes(fieldValue(select, 'sub'))) {
      const selectArgs = arrayField(select, 'args');
      if (!selectArgs.ok) return null;
      const flags = valueOf(selectArgs.value[selectArgs.value.length - 1]);
      const materialized = compareFromFlags(ir, flags, fieldValue(select, 'cond'), values, control);
      if (materialized) return kind === 'tbz' ? invert(materialized) : materialized;
    }

    const x = expressionOf(tested, values);
    if (!x) return null;
    const bit = fieldValue(extra, 'bit');
    const testedBits = fieldValue(tested, 'bits');
    const xBits = fieldValue(x, 'bits');
    const bits = testedBits ?? xBits ?? 64;
    if ((testedBits != null && !validBits(testedBits)) || (xBits != null && !validBits(xBits))
        || !validBits(bits) || typeof bit !== 'number' || !Number.isSafeInteger(bit) || bit < 0 || bit >= bits) return null;
    if (bit === bits - 1) {
      return expr.compare(kind === 'tbz' ? 'ge' : 'lt', x, expr.constant(0, bits, true), true, fieldValue(term, 'source'));
    }
    const shifted = expr.binary('lshr', x, expr.constant(bit, bits, false), bits, false, fieldValue(term, 'source'));
    const masked = expr.binary('and', shifted, expr.constant(1, bits, false), bits, false, fieldValue(term, 'source'));
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', masked, expr.constant(0, bits, false), false, fieldValue(term, 'source'));
  }

  const condition = fieldValue(term, 'cond') || fieldValue(extra, 'cond');
  if (kind === 'cond' || condition) {
    const flags = valueOf(termArgs.value[termArgs.value.length - 1]);
    return compareFromFlags(ir, flags, condition, values, control);
  }
  return null;
}

function targetBlock(ir, term, opts, control) {
  const extra = fieldValue(term, 'extra');
  const address = fieldValue(extra, 'target');
  if (address == null) return null;
  const rowMapper = ownData(opts, 'rowOfAddress');
  if (!rowMapper.present || !rowMapper.valid || typeof rowMapper.value !== 'function') return null;
  let row;
  try { row = rowMapper.value(address); } catch { return null; }
  if (!validRow(row)) return null;
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok) return null;
  for (const block of blocks.value) {
    if (control?.isAborted?.()) return null;
    const index = fieldValue(block, 'index');
    const startRow = fieldValue(block, 'startRow');
    const endRow = fieldValue(block, 'endRow');
    if (!validBlock(index) || !validRow(startRow) || !validRow(endRow)) continue;
    if (row >= startRow && row <= endRow) return index;
  }
  return null;
}

function terminal(block, control) {
  const xs = arrayField(block, 'insts');
  if (!xs.ok) return null;
  for (let i = xs.value.length - 1; i >= 0; i--) {
    if (control?.isAborted?.()) return null;
    if (['cbr','br','ret'].includes(fieldValue(xs.value[i], 'op'))) return xs.value[i];
  }
  return null;
}

function branchArms(ir, block, term, opts, control) {
  const successors = arrayField(block, 'succ');
  if (!successors.ok) {
    return { yes:null, no:null, exact:false };
  }
  for (const successor of successors.value) {
    if (control?.isAborted?.() || !validBlock(successor)) return { yes:null, no:null, exact:false };
  }
  const succ = successors.value;
  const op = fieldValue(term, 'op');
  if (op !== 'cbr' || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null, exact:op !== 'cbr' };
  const yes = targetBlock(ir, term, opts, control);
  if (yes == null) return { yes:null, no:null, exact:false };
  let hasYes = false;
  let no = null;
  for (const successor of succ) {
    if (control?.isAborted?.()) return { yes:null, no:null, exact:false };
    if (successor === yes) hasYes = true;
    else if (no == null) no = successor;
  }
  return hasYes ? { yes, no, exact:true } : { yes:null, no:null, exact:false };
}

function canReach(ir, start, target, blocked, cap = 256, control) {
  if (start == null || target == null) return false;
  const queue = [start], seen = new Set();
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok) return false;
  while (queue.length && cap-- > 0) {
    if (control?.isAborted?.()) return false;
    const at = queue.shift();
    if (!validBlock(at)) return false;
    if (at === target) return true;
    if (at === blocked || seen.has(at)) continue;
    seen.add(at);
    const successors = arrayField(blocks.value[at], 'succ');
    if (!successors.ok) return false;
    for (const next of successors.value) {
      if (control?.isAborted?.() || !validBlock(next)) return false;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

function armPredecessorIndex(ir, controller, successor, merge, predecessors, control) {
  if (successor === merge) {
    for (let index = 0; index < predecessors.length; index++) {
      if (control?.isAborted?.()) return -1;
      if (predecessors[index] === controller.index) return index;
    }
    return -1;
  }
  for (let index = 0; index < predecessors.length; index++) {
    if (control?.isAborted?.()) return -1;
    if (canReach(ir, successor, predecessors[index], merge, 256, control)) return index;
  }
  return -1;
}

function dominates(ir, candidate, node, control) {
  if (!validBlock(candidate) || !validBlock(node)) return false;
  const dominators = ownData(ir, 'dominators');
  const view = dominators.present && dominators.valid ? dominators.value?.[node] : null;
  if (typeof view?.has === 'function') {
    try { return view.has(candidate); } catch { return false; }
  }
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok) return false;
  const idom = ownData(ir, 'idom');
  const idomValues = idom.present && idom.valid && Array.isArray(idom.value) ? idom.value : [];
  let cur = node, guard = blocks.value.length + 2;
  while (cur != null && cur >= 0 && guard-- > 0) {
    if (control?.isAborted?.()) return false;
    if (cur === candidate) return true;
    const parent = idomValues[cur];
    const blockParent = fieldValue(blocks.value[cur], 'idom');
    cur = parent ?? blockParent ?? -1;
    if (cur !== -1 && !validBlock(cur)) return false;
  }
  return false;
}

function domDepth(ir, block, control) {
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok || !validBlock(block)) return 0;
  const idom = ownData(ir, 'idom');
  const idomValues = idom.present && idom.valid && Array.isArray(idom.value) ? idom.value : [];
  let depth = 0, cur = block, guard = blocks.value.length + 2;
  while (cur != null && cur >= 0 && guard-- > 0) {
    if (control?.isAborted?.()) return 0;
    depth++;
    const parent = idomValues[cur];
    const blockParent = fieldValue(blocks.value[cur], 'idom');
    cur = parent ?? blockParent ?? -1;
    if (cur !== -1 && !validBlock(cur)) return 0;
  }
  return depth;
}

function controller(ir, merge, predecessors, opts, control) {
  const candidates = [];
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok) return null;
  for (const block of blocks.value) {
    if (control?.isAborted?.()) return null;
    const blockIndex = fieldValue(block, 'index');
    const successors = arrayField(block, 'succ');
    if (!successors.ok || !validBlock(blockIndex)) return null;
    for (const next of successors.value) {
      if (control?.isAborted?.() || !validBlock(next)) return null;
    }
    if (!dominates(ir, blockIndex, merge, control)) continue;
    const term = terminal(block, control);
    if (fieldValue(term, 'op') !== 'cbr' || successors.value.length < 2) continue;
    const arms = branchArms(ir, block, term, opts, control);
    if (!arms.exact) continue;
    const yesIndex = armPredecessorIndex(ir, { index:blockIndex }, arms.yes, merge, predecessors, control);
    const noIndex = armPredecessorIndex(ir, { index:blockIndex }, arms.no, merge, predecessors, control);
    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, depth:domDepth(ir, block.index, control) });
  }
  candidates.sort((a,b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function exactReturnLoad(result, root, ret, control) {
  if (control?.isAborted?.()) return null;
  const bits = fieldValue(root, 'bits');
  const rootLocation = fieldValue(root, 'location');
  const rootKey = fieldValue(rootLocation, 'key');
  if (!validBits(bits) || fieldValue(rootLocation, 'kind') !== 'stack'
      || typeof rootKey !== 'string' || rootKey.length === 0) return null;
  const sourceIds = sourceValues(root, 'ir', idKey, control);
  if (!sourceIds || sourceIds.length === 0) return null;
  const instructions = arrayField(result.ir, 'instructions');
  if (!instructions.ok) return null;
  const candidates = [];
  for (const inst of instructions.value) {
    if (control?.isAborted?.()) return null;
    const id = idKey(fieldValue(inst, 'id'));
    const location = fieldValue(inst, 'loc');
    if (id != null && sourceIds.includes(id)
      && fieldValue(inst, 'op') === 'load'
      && fieldValue(location, 'kind') === 'stack'
      && fieldValue(location, 'key') === rootKey) candidates.push(inst);
  }
  if (candidates.length !== 1) return null;
  const load = candidates[0];
  const location = fieldValue(load, 'loc');
  const size = positiveAccessSize(fieldValue(location, 'size'));
  if (size == null || size > Math.floor(Number.MAX_SAFE_INTEGER / 8) || size * 8 !== bits) return null;
  const loadRow = fieldValue(load, 'row');
  const retRow = fieldValue(ret, 'row');
  const loadBlock = fieldValue(load, 'block');
  const retBlock = fieldValue(ret, 'block');
  if (!validRow(loadRow) || !validRow(retRow) || !validBlock(loadBlock) || !validBlock(retBlock)) return null;
  if (loadBlock === retBlock) {
    if (loadRow >= retRow) return null;
  } else if (!dominates(result.ir, loadBlock, retBlock, control)) {
    return null;
  }
  return { load, size };
}

function storeValue(inst, key, size, values) {
  const location = fieldValue(inst, 'loc');
  const row = fieldValue(inst, 'row');
  if (fieldValue(inst, 'op') !== 'store'
      || fieldValue(location, 'kind') !== 'stack'
      || fieldValue(location, 'key') !== key
      || !validRow(row)
      || positiveAccessSize(fieldValue(location, 'size')) !== size) return null;
  const args = fieldValue(inst, 'args');
  const value = Array.isArray(args) ? valueOf(args[0]) : null;
  let node = expressionOf(value, values);
  if (!node) return null;
  const bits = size * 8;
  if (bits) node = fitWidth(node, bits, {
    address:fieldValue(inst, 'address'),
    row,
    ir:fieldValue(inst, 'id'),
    evidence:[{ reason:`exact ${bits}-bit stack-store boundary` }],
  });
  return node;
}

function reachingRegisterDefinition(ir, atInst, reg, control) {
  if (control?.isAborted?.()) return null;
  const values = arrayField(ir, 'values');
  const instructions = arrayField(ir, 'instructions');
  const atBlock = fieldValue(atInst, 'block');
  const atRow = fieldValue(atInst, 'row');
  if (!values.ok || !instructions.ok || !validBlock(atBlock) || !validRow(atRow) || typeof reg !== 'string') return null;
  let best = null, bestDepth = -1, bestRow = -Infinity;
  for (const value of values.value) {
    if (control?.isAborted?.()) return null;
    const def = fieldValue(value, 'def');
    const defBlock = fieldValue(def, 'block');
    const defRow = fieldValue(def, 'row');
    if (fieldValue(value, 'reg') !== reg || !def || fieldValue(value, 'clobbered') === true
        || !validBlock(defBlock) || !validRow(defRow)) continue;
    let definitionCount = 0;
    for (const instruction of instructions.value) {
      if (control?.isAborted?.()) return null;
      if (instruction === def) definitionCount += 1;
    }
    if (definitionCount !== 1) continue;
    if (defBlock === atBlock) {
      if (defRow >= atRow) continue;
      if (defRow > bestRow) { best = value; bestRow = defRow; bestDepth = Number.MAX_SAFE_INTEGER; }
      continue;
    }
    if (!dominates(ir, defBlock, atBlock, control)) continue;
    const depth = domDepth(ir, defBlock, control);
    if (bestDepth !== Number.MAX_SAFE_INTEGER && (depth > bestDepth || (depth === bestDepth && defRow > bestRow))) {
      best = value; bestDepth = depth; bestRow = defRow;
    }
  }
  return best;
}

function exactViewTrace(value, active = new Set()) {
  const valueId = idKey(fieldValue(value, 'id'));
  if (!value || valueId == null || active.has(valueId)) return null;
  const valueBits = ownData(value, 'bits');
  if (valueBits.present && (!valueBits.valid || !validBits(valueBits.value))) return null;
  active.add(valueId);
  let current = value;
  const steps = [];
  while (fieldValue(fieldValue(current, 'def'), 'op') === 'mov') {
    const def = fieldValue(current, 'def');
    const args = arrayField(def, 'args');
    if (!args.ok || args.value.length !== 1) break;
    const sub = fieldValue(def, 'sub') ?? null;
    const extra = fieldValue(def, 'extra');
    const exactIdentity = sub == null || sub === 'copy' || sub === 'bitcast'
      || fieldValue(extra, 'stateRead') === true || fieldValue(extra, 'stateWrite') === true;
    if (!exactIdentity && !EXACT_VIEW_MOV_SUBS.has(sub)) break;
    const source = valueOf(args.value[0]);
    const sourceId = idKey(fieldValue(source, 'id'));
    if (!source || sourceId == null || active.has(sourceId)) break;
    if (sub === 'trunc' || sub === 'zext') {
      const sourceBits = fieldValue(source, 'bits');
      const currentBits = fieldValue(current, 'bits');
      if (!validBits(sourceBits) || !validBits(currentBits)) return null;
      steps.push(`${sub}:${sourceBits}>${currentBits}`);
    }
    active.add(sourceId);
    current = source;
  }
  return { root: current, bits:valueBits.present ? valueBits.value : 0, steps };
}

function storedViewProjectsValue(stored, expected, store) {
  if (!stored || !expected || !store) return false;
  const storedId = idKey(fieldValue(stored, 'id'));
  const expectedId = idKey(fieldValue(expected, 'id'));
  if (storedId == null || expectedId == null) return false;
  if (stored === expected || storedId === expectedId) return true;
  const a = exactViewTrace(stored), b = exactViewTrace(expected);
  const aRootId = idKey(fieldValue(a?.root, 'id'));
  const bRootId = idKey(fieldValue(b?.root, 'id'));
  if (!a?.root || !b?.root || aRootId == null || aRootId !== bRootId) return false;
  const location = fieldValue(store, 'loc');
  const address = fieldValue(store, 'addr');
  const extra = fieldValue(store, 'extra');
  const sizeField = ownData(location, 'size').present ? ownData(location, 'size')
    : ownData(address, 'size').present ? ownData(address, 'size') : ownData(extra, 'size');
  if (sizeField.present && (!sizeField.valid || positiveAccessSize(sizeField.value) == null)) return false;
  const widthBits = sizeField.present ? sizeField.value * 8 : 0;
  const storedBits = fieldValue(stored, 'bits');
  if (storedBits != null && !validBits(storedBits)) return false;
  if (widthBits > 0 && storedBits !== widthBits) return false;
  if (a.steps.length < b.steps.length) return false;
  const suffix = a.steps.slice(a.steps.length - b.steps.length);
  return suffix.every((step, index) => step === b.steps[index]);
}

function committedStoreBarrier(inst, key, control) {
  const op = fieldValue(inst, 'op');
  const location = fieldValue(inst, 'loc');
  const locationKey = fieldValue(location, 'key');
  const locationKind = fieldValue(location, 'kind');
  if (op === 'clobber' || op === 'unknown') return true;
  if (op === 'call') {
    const kills = authenticatedCallMemoryEffect(inst, control);
    if (!kills) return true;
    for (const loc of kills) {
      if (control?.isAborted?.() || loc.kind === 'unknown' || loc.key === key) return true;
    }
    return false;
  }
  if (op !== 'store') return false;
  return !locationKey || locationKind === 'unknown' || locationKey === key;
}

function storeOfExactValue(ir, blockIndex, value, control) {
  if (control?.isAborted?.()) return null;
  const blocks = arrayField(ir, 'blocks');
  const valueId = idKey(fieldValue(value, 'id'));
  if (!blocks.ok || !validBlock(blockIndex) || valueId == null) return null;
  let current = blockIndex;
  const seen = new Set();
  const later = [];
  let guard = Math.min(64, blocks.value.length + 2);
  while (current != null && current >= 0 && guard-- > 0 && !seen.has(current)) {
    if (!validBlock(current) || current >= blocks.value.length) return null;
    seen.add(current);
    const blockInstructions = arrayField(blocks.value[current], 'insts');
    if (!blockInstructions.ok) return null;
    const instructions = [...blockInstructions.value];
    const memoryRows = new Set();
    for (const instruction of instructions) {
      if (control?.isAborted?.()) return null;
      const row = fieldValue(instruction, 'row');
      if (!validRow(row)) return null;
      const op = fieldValue(instruction, 'op');
      if (['load', 'store', 'call', 'clobber', 'unknown'].includes(op)) {
        if (memoryRows.has(row)) return null;
        memoryRows.add(row);
      }
    }
    instructions.sort((a,b) => fieldValue(b, 'row') - fieldValue(a, 'row'));
    for (const inst of instructions) {
      if (control?.isAborted?.()) return null;
      const op = fieldValue(inst, 'op');
      const location = fieldValue(inst, 'loc');
      const locationKind = fieldValue(location, 'kind');
      const locationKey = fieldValue(location, 'key');
      const args = arrayField(inst, 'args');
      if (op === 'store' && locationKind !== 'stack' && locationKind !== 'unknown'
          && typeof locationKey === 'string' && locationKey.length > 0 && args.ok
          && storedViewProjectsValue(valueOf(args.value[0]), value, inst)) {
        if (!dominates(ir, current, blockIndex, control)) return null;
        for (const candidate of later) {
          if (control?.isAborted?.() || committedStoreBarrier(candidate, locationKey, control)) return null;
        }
        return inst;
      }
      later.push(inst);
    }
    const predecessorField = ownData(blocks.value[current], 'pred');
    if (!predecessorField.present || !predecessorField.valid || !Array.isArray(predecessorField.value)) return null;
    const predecessors = [...predecessorField.value];
    for (const pred of predecessors) {
      if (control?.isAborted?.() || !validBlock(pred)) return null;
    }
    if (predecessors.length !== 1) return null;
    current = predecessors[0];
  }
  return null;
}

function semanticLocationForStore(result, store, control) {
  if (control?.isAborted?.()) return null;
  const storeId = idKey(fieldValue(store, 'id'));
  if (storeId == null) return null;
  for (const item of result.semanticAst?.stores || []) {
    if (control?.isAborted?.()) return null;
    const ids = sourceValues(item, 'ir', idKey, control);
    if (ids?.includes(storeId)) return fieldValue(item, 'location') || null;
  }
  return null;
}

function locationIdentity(location) {
  if (!location) return null;
  if (location.kind === 'field') {
    return `field:${location.offset ?? ''}:${location.name || ''}:${structuralKey(location.base)}`;
  }
  if (location.kind === 'index') {
    return `index:${location.scale || 1}:${structuralKey(location.base)}:${structuralKey(location.index)}`;
  }
  return `${location.kind}:${location.key || location.text || location.name || ''}`;
}

function semanticLocationForProvenSnapshot(result, definition, control) {
  if (control?.isAborted?.()) return null;
  const definitionDst = fieldValue(definition, 'dst');
  const definitionDstId = idKey(fieldValue(definitionDst, 'id'));
  let projected = null;
  if (definitionDstId != null) {
    for (const item of result.semanticAst?.values || []) {
      if (control?.isAborted?.()) return null;
      if (idKey(fieldValue(item, 'valueId')) === definitionDstId) {
        projected = fieldValue(item, 'expression') || null;
        break;
      }
    }
  }
  const projectedLocation = fieldValue(projected, 'location');
  const projectedKind = fieldValue(projected, 'kind');
  if (projectedKind === 'load'
      && fieldValue(projectedLocation, 'kind') !== 'stack' && fieldValue(projectedLocation, 'kind') !== 'unknown') return projectedLocation;

  const extra = fieldValue(definition, 'extra');
  const definitionLocation = fieldValue(definition, 'loc');
  const key = fieldValue(extra, 'committedLocationKey') ?? fieldValue(definitionLocation, 'key');
  if (typeof key !== 'string' || key.length === 0) return null;
  const rowField = ownData(extra, 'committedStoreRows');
  if (rowField.present && (!rowField.valid || !Array.isArray(rowField.value))) return null;
  if (rowField.present) {
    for (const row of rowField.value) {
      if (control?.isAborted?.() || !validRow(row)) return null;
    }
  }
  const rows = new Set(rowField.present ? rowField.value : []);
  const instructions = arrayField(result.ir, 'instructions');
  if (!instructions.ok) return null;
  const locations = [];
  for (const store of instructions.value) {
    if (control?.isAborted?.()) return null;
    const location = fieldValue(store, 'loc');
    const kind = fieldValue(location, 'kind');
    const storeKey = fieldValue(location, 'key');
    if (fieldValue(store, 'op') !== 'store'
        || typeof kind !== 'string' || kind === 'stack' || kind === 'unknown'
        || storeKey !== key || (rows.size && !rows.has(fieldValue(store, 'row')))) continue;
    const semanticLocation = semanticLocationForStore(result, store, control);
    if (!semanticLocation) return null;
    locations.push(semanticLocation);
  }
  if (!locations.length) return null;
  for (const location of locations) {
    if (control?.isAborted?.() || !location) return null;
  }
  const identity = locationIdentity(locations[0]);
  if (!identity) return null;
  for (const location of locations) {
    if (control?.isAborted?.() || locationIdentity(location) !== identity) return null;
  }
  return locations[0];
}

function committedLocationForPhi(result, value, control) {
  if (control?.isAborted?.()) return null;
  const definition = fieldValue(value, 'def');
  const definitionExtra = fieldValue(definition, 'extra');
  const definitionLocation = fieldValue(definition, 'loc');
  const definitionKind = fieldValue(definitionLocation, 'kind');
  if (fieldValue(definition, 'op') === 'load'
      && (fieldValue(definitionExtra, 'committedPhiSnapshot') === true || fieldValue(definitionExtra, 'committedSnapshotView') === true)
      && typeof definitionKind === 'string' && definitionKind !== 'stack' && definitionKind !== 'unknown') {
    const location = semanticLocationForProvenSnapshot(result, definition, control);
    if (location) return location;
  }

  const phi = definition;
  const incomingField = ownData(phi, 'incoming');
  if (fieldValue(phi, 'op') !== 'phi' || !incomingField.present || !incomingField.valid
      || !Array.isArray(incomingField.value) || !incomingField.value.length) return null;
  const locations = [];
  for (const incoming of incomingField.value) {
    if (control?.isAborted?.()) return null;
    const from = fieldValue(incoming, 'from');
    const incomingValue = fieldValue(incoming, 'value');
    const store = storeOfExactValue(result.ir, from, incomingValue, control);
    if (!store) return null;
    const location = semanticLocationForStore(result, store, control);
    if (!location) return null;
    locations.push(location);
  }
  const identity = locationIdentity(locations[0]);
  if (!identity) return null;
  for (const location of locations) {
    if (control?.isAborted?.() || locationIdentity(location) !== identity) return null;
  }
  return locations[0];
}

function canonicalReturnRegister(result, root, opts = {}) {
  const adapter = opts.abiAdapter || result?.abiAdapter || result?.ctx?.abiAdapter || null;
  if (adapter?.supported === true && typeof adapter.returnLocations === 'function') {
    const returnType = opts.returnType
      ?? opts.functionPrototype?.returnType
      ?? opts.prototype?.returnType
      ?? result?.prototype?.returnType
      ?? result?.types?.ret?.type
      ?? (root?.bits ? `int${root.bits}` : null);
    if (!returnType) return null;
    try {
      const locations = adapter.returnLocations({
        functionPrototype:{ returnType, returnsValue:true },
        returnType,
      });
      return Array.isArray(locations) && locations.length === 1
        && fieldValue(locations[0], 'kind') === 'register' && fieldValue(locations[0], 'aggregate') !== true
        && typeof fieldValue(locations[0], 'reg') === 'string'
        ? fieldValue(locations[0], 'reg') || null : null;
    } catch {
      return null;
    }
  }
  if (adapter) return null;
  // The old ARM64 facade predates the canonical ABI envelope. Preserve its
  // presentation-only x0 behavior, while a v2 IR without an adapter remains
  // unknown instead of acquiring a private ABI rule.
  if (opts.legacyAArch64 === true || result?.ir?.compat?.projection !== 'semantic-ir-v2-to-v1') return 'x0';
  return null;
}

function committedReturnValue(result, root, ret, opts = {}, control, physicalRootLoad = null) {
  if (control?.isAborted?.()) return null;
  const rootLocation = fieldValue(root, 'location');
  const rootKey = fieldValue(rootLocation, 'key');
  const rootBits = fieldValue(root, 'bits');
  if (fieldValue(root, 'kind') !== 'load' || fieldValue(rootLocation, 'kind') !== 'stack'
      || typeof rootKey !== 'string' || rootKey.length === 0 || !validBits(rootBits)) return null;
  // A semantic stack key alone is presentation metadata. Keep the committed
  // forwarding path tied to the authenticated physical root LOAD that exact
  // return recovery proved, including its width.
  const physicalRootLocation = fieldValue(physicalRootLoad, 'loc');
  if (!physicalRootLoad || fieldValue(physicalRootLoad, 'op') !== 'load'
      || fieldValue(physicalRootLocation, 'kind') !== 'stack'
      || fieldValue(physicalRootLocation, 'key') !== rootKey
      || positiveAccessSize(fieldValue(physicalRootLocation, 'size')) * 8 !== rootBits) return null;
  const returnRegister = canonicalReturnRegister(result, root, opts);
  if (!returnRegister) return null;
  const reaching = reachingRegisterDefinition(result.ir, ret, returnRegister, control);
  const load = fieldValue(reaching, 'def');
  const loadLocation = fieldValue(load, 'loc');
  const loadSize = positiveAccessSize(fieldValue(loadLocation, 'size'));
  const loadRow = fieldValue(load, 'row');
  const loadBlock = fieldValue(load, 'block');
  const retRow = fieldValue(ret, 'row');
  const retBlock = fieldValue(ret, 'block');
  if (fieldValue(load, 'op') !== 'load' || fieldValue(loadLocation, 'kind') !== 'stack'
      || fieldValue(loadLocation, 'key') !== rootKey || loadSize == null || loadSize * 8 !== rootBits
      || !validRow(loadRow) || !validBlock(loadBlock) || !validRow(retRow) || !validBlock(retBlock)) return null;
  if (loadBlock === retBlock ? loadRow >= retRow : !dominates(result.ir, loadBlock, retBlock, control)) return null;
  const loadForwarding = fieldValue(load, 'memoryForwarding');
  const loadExtra = fieldValue(load, 'extra');
  const forwarding = loadForwarding ?? fieldValue(loadExtra, 'memoryForwarding');
  let exactForwarding = false;
  try {
    exactForwarding = isCanonicalExactMemoryForwarding(forwarding,
      canonicalMemoryForwardingContextForLoad(forwarding, load,
        fieldValue(load, 'memoryForwardingContext') ?? fieldValue(loadExtra, 'memoryForwardingContext')));
  } catch {
    return null;
  }
  if (!exactForwarding) return null;
  const contributingField = ownData(forwarding, 'contributingDefinitionIds');
  if (!contributingField.present || !contributingField.valid || !Array.isArray(contributingField.value)) return null;
  const definitionIds = new Set();
  for (const definitionId of contributingField.value) {
    const key = idKey(definitionId);
    if (key == null) return null;
    definitionIds.add(key);
  }
  const instructions = arrayField(result.ir, 'instructions');
  if (!instructions.ok) return null;
  const stackStores = [];
  for (const candidate of instructions.value) {
    if (control?.isAborted?.()) return null;
    const candidateLocation = fieldValue(candidate, 'loc');
    const memDef = fieldValue(candidate, 'memDef');
    const candidateExtra = fieldValue(candidate, 'extra');
    const definitionId = fieldValue(memDef, 'definitionId') ?? fieldValue(candidateExtra, 'memoryDefinitionId');
    const definitionKey = idKey(definitionId);
    if (fieldValue(candidate, 'op') === 'store'
      && fieldValue(candidateLocation, 'kind') === 'stack'
      && fieldValue(candidateLocation, 'key') === rootKey
      && definitionKey != null
      && definitionIds.has(definitionKey)) stackStores.push(candidate);
  }
  if (stackStores.length !== 1) return null;
  const stackStore = stackStores[0];
  const stackArgs = arrayField(stackStore, 'args');
  const spilled = stackArgs.ok ? valueOf(stackArgs.value[0]) : null;
  const location = committedLocationForPhi(result, spilled, control);
  if (!location) return null;
  return expr.load(location, rootBits, fieldValue(root, 'source'), {
    signed: fieldValue(root, 'signed') ?? null,
    proof: 'all SSA phi predecessors committed the exact spilled value to one lvalue',
  });
}

function unsafeBarrier(inst, key, control) {
  const op = fieldValue(inst, 'op');
  const location = fieldValue(inst, 'loc');
  const locationKey = fieldValue(location, 'key');
  const locationKind = fieldValue(location, 'kind');
  if (op === 'clobber' || op === 'unknown') return true;
  if (op === 'call') {
    const kills = authenticatedCallMemoryEffect(inst, control);
    if (!kills) return true;
    for (const loc of kills) {
      if (control?.isAborted?.() || loc.kind === 'unknown' || loc.key === key) return true;
    }
    return false;
  }
  if (op !== 'store') return false;
  if (locationKey === key) return true;
  return !locationKey || locationKind === 'unknown';
}

function before(ir, block, row, key, control) {
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok || !validBlock(block) || (row != null && !validRow(row))) return null;
  const selected = [];
  const memoryRows = new Set();
  for (const instruction of instructions.value) {
    if (control?.isAborted?.()) return null;
    const instructionBlock = fieldValue(instruction, 'block');
    if (!validBlock(instructionBlock)) return null;
    if (instructionBlock !== block) continue;
    const instructionRow = fieldValue(instruction, 'row');
    const op = fieldValue(instruction, 'op');
    if (!validRow(instructionRow)) return null;
    if (['load', 'store', 'call', 'clobber', 'unknown'].includes(op)) {
      if (memoryRows.has(instructionRow)) return null;
      memoryRows.add(instructionRow);
    }
    if (row == null || instructionRow < row) selected.push(instruction);
  }
  selected.sort((a, b) => fieldValue(b, 'row') - fieldValue(a, 'row'));
  return selected;
}

function resolve(ir, blockIndex, beforeRow, key, size, values, opts, engine, active, depth = 0, control) {
  if (control?.isAborted?.() || !validBlock(blockIndex) || (beforeRow != null && !validRow(beforeRow)) || depth > 64) return null;
  const token = `${blockIndex}:${beforeRow ?? 'end'}:${key}:${size}`;
  if (active.has(token)) return null;
  active.add(token);
  try {
    const instructions = before(ir, blockIndex, beforeRow, key, control);
    if (!instructions) return null;
    for (const inst of instructions) {
      if (control?.isAborted?.()) return null;
      const stored = storeValue(inst, key, size, values);
      if (stored) return stored;
      if (unsafeBarrier(inst, key, control)) return null;
    }

    const blocks = arrayField(ir, 'blocks');
    if (!blocks.ok || blockIndex >= blocks.value.length) return null;
    const block = blocks.value[blockIndex];
    const predecessorField = ownData(block, 'pred');
    if (!predecessorField.present || !predecessorField.valid || !Array.isArray(predecessorField.value)) return null;
    const predecessors = [...predecessorField.value];
    for (const pred of predecessors) {
      if (control?.isAborted?.() || !validBlock(pred)) return null;
    }
    if (!predecessors.length) return null;
    const incoming = [];
    for (const pred of predecessors) {
      if (control?.isAborted?.()) return null;
      const resolved = resolve(ir, pred, null, key, size, values, opts, engine, active, depth + 1, control);
      if (!resolved) return null;
      incoming.push(resolved);
    }
    const unique = new Map();
    for (const value of incoming) {
      if (control?.isAborted?.()) return null;
      unique.set(structuralKey(value), value);
    }
    if (unique.size === 1) return incoming[0];
    if (predecessors.length !== 2 || unique.size !== 2) return null;

    const mergeControl = controller(ir, blockIndex, predecessors, opts, control);
    if (!mergeControl) return null;
    const condition = simplify(branchCondition(ir, mergeControl.term, values, control), engine, control);
    if (!condition) return null;
    const firstBits = fieldValue(incoming[0], 'bits');
    const secondBits = fieldValue(incoming[1], 'bits');
    if ((firstBits != null && !validBits(firstBits)) || (secondBits != null && !validBits(secondBits))) return null;
    const bits = firstBits || secondBits || 64;
    const signed = fieldValue(condition, 'compareSigned') ?? fieldValue(incoming[0], 'signed')
      ?? fieldValue(incoming[1], 'signed') ?? null;
    return simplify(expr.select(condition, incoming[mergeControl.yesIndex], incoming[mergeControl.noIndex], bits, signed, {
      address:fieldValue(mergeControl.term, 'address'),
      row:fieldValue(mergeControl.term, 'row'),
      ir:fieldValue(mergeControl.term, 'id'),
      evidence:[{ reason:'exact stack CFG join' }],
    }), engine, control);
  } finally {
    active.delete(token);
  }
}

function isReturnNode(node) {
  const semantic = fieldValue(node, 'semantic');
  const text = fieldValue(node, 'text');
  return fieldValue(semantic, 'op') === 'return'
    || (typeof text === 'string' && /^return\b/.test(text.trim()));
}

function returnOutput(result, control) {
  const outputs = result.semanticAst?.outputs;
  if (!Array.isArray(outputs)) return null;
  for (const output of outputs) {
    if (control?.isAborted?.()) return null;
    if (fieldValue(output, 'name') === 'return') return output;
  }
  return null;
}

function returnNodes(result, control) {
  const body = result.cAst?.body;
  if (!Array.isArray(body)) return [];
  const nodes = [];
  for (const node of body) {
    if (control?.isAborted?.()) return null;
    if (isReturnNode(node)) nodes.push(node);
  }
  return nodes;
}

function snapshotReturnPublication(result) {
  const bodyField = ownData(result.cAst, 'body');
  const body = bodyField.present && bodyField.valid && Array.isArray(bodyField.value) ? bodyField.value : null;
  const nodes = (body || []).map((node) => {
    const semantic = fieldValue(node, 'semantic');
    return {
      node,
      text:ownData(node, 'text'),
      semantic,
      expression:ownData(semantic, 'expression'),
    };
  });
  const outputs = Array.isArray(result.semanticAst?.outputs)
    ? result.semanticAst.outputs.map((output) => ({ output, expression:ownData(output, 'expression') })) : [];
  const fields = new Map();
  for (const key of ['pseudocode', 'sourceMap', 'lines', 'rewriteProof', 'metrics', 'ctx']) {
    fields.set(key, ownData(result, key));
  }
  return { bodyField, body, nodes, outputs, fields };
}

function restoreReturnPublication(result, snapshot) {
  const restoreField = (object, key, field) => {
    if (!object) return;
    if (!field.present) {
      try { delete object[key]; } catch { /* immutable result fields stay unchanged */ }
      return;
    }
    try { object[key] = field.value; } catch { /* immutable result fields stay unchanged */ }
  };
  if (snapshot.bodyField.present && snapshot.bodyField.valid) {
    restoreField(result.cAst, 'body', snapshot.bodyField);
  }
  for (const state of snapshot.nodes) {
    restoreField(state.node, 'text', state.text);
    restoreField(state.semantic, 'expression', state.expression);
  }
  for (const state of snapshot.outputs) restoreField(state.output, 'expression', state.expression);
  for (const [key, field] of snapshot.fields) restoreField(result, key, field);
}

function returnNodeMatches(node, ret, control) {
  const rows = sourceValues(node, 'rows', (row) => validRow(row) ? row : null, control);
  const ir = sourceValues(node, 'ir', idKey, control);
  const addresses = sourceValues(node, 'addresses', addressKey, control);
  if (rows == null || ir == null || addresses == null) return false;
  const retRow = fieldValue(ret, 'row');
  const retId = idKey(fieldValue(ret, 'id'));
  const retAddress = addressKey(fieldValue(ret, 'address'));
  return rows.includes(retRow)
    || (retId != null && ir.includes(retId))
    || (retAddress != null && addresses.includes(retAddress));
}

function rewriteReturn(result, expression, opts, ret, control) {
  if (control?.isAborted?.()) return false;
  const output = returnOutput(result, control);
  if (!output) return false;
  const nodes = returnNodes(result, control);
  if (!nodes || nodes.length !== 1 || !returnNodeMatches(nodes[0], ret, control)) return false;
  const node = nodes[0];
  const previousOutput = output.expression;
  const previousText = node.text;
  const previousExpression = node.semantic?.expression;
  output.expression = expression;
  node.text = `return ${printExpression(expression)};`;
  if (node.semantic) node.semantic.expression = expression;
  if (control?.isAborted?.()) {
    output.expression = previousOutput;
    node.text = previousText;
    if (node.semantic) node.semantic.expression = previousExpression;
    return false;
  }
  const columnWidth = fieldValue(opts, 'columnWidth') || fieldValue(opts, 'prettyColumnWidth') || 88;
  const printed = printProgram(result.cAst, { columnWidth });
  if (control?.isAborted?.()) {
    output.expression = previousOutput;
    node.text = previousText;
    if (node.semantic) node.semantic.expression = previousExpression;
    return false;
  }
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  return true;
}

function committedStackSpillOnExactReturnPath(result, root, load, size, control) {
  const rootLocation = fieldValue(root, 'location');
  const rootKey = fieldValue(rootLocation, 'key');
  if (typeof rootKey !== 'string' || rootKey.length === 0) return null;
  const instructions = before(result.ir, fieldValue(load, 'block'), fieldValue(load, 'row'), rootKey, control);
  if (!instructions) return null;
  for (const inst of instructions) {
    if (control?.isAborted?.()) return null;
    const location = fieldValue(inst, 'loc');
    if (fieldValue(inst, 'op') === 'store' && fieldValue(location, 'kind') === 'stack'
        && fieldValue(location, 'key') === rootKey) {
      if (positiveAccessSize(fieldValue(location, 'size')) !== size) return null;
      const args = fieldValue(inst, 'args');
      const storedValue = Array.isArray(args) ? valueOf(args[0]) : null;
      const committedLocation = committedLocationForPhi(result, storedValue, control);
      return committedLocation ? { stackStore:inst, location:committedLocation } : null;
    }
    if (unsafeBarrier(inst, rootKey, control)) return null;
  }
  return null;
}

function removeProofOnlyStackSpill(result, stackStore, opts, control) {
  const body = result.cAst?.body;
  if (!Array.isArray(body) || !stackStore) return false;
  const storeRow = fieldValue(stackStore, 'row');
  const storeId = idKey(fieldValue(stackStore, 'id'));
  if (!validRow(storeRow) || storeId == null) return false;
  const filtered = [];
  for (const node of body) {
    if (control?.isAborted?.()) return false;
    const text = fieldValue(node, 'text');
    if (typeof text !== 'string' || !/^\s*local_[A-Za-z0-9_]+\s*=/.test(text)) {
      filtered.push(node);
      continue;
    }
    const rows = sourceValues(node, 'rows', (row) => validRow(row) ? row : null, control);
    const ir = sourceValues(node, 'ir', idKey, control);
    if (rows == null || ir == null) {
      if (control?.isAborted?.()) return false;
      filtered.push(node);
      continue;
    }
    const isSpill = rows.includes(storeRow) || ir.includes(storeId);
    if (!isSpill) filtered.push(node);
  }
  if (filtered.length === body.length) return false;
  result.cAst.body = filtered;
  const columnWidth = fieldValue(opts, 'columnWidth') || fieldValue(opts, 'prettyColumnWidth') || 88;
  const printed = printProgram(result.cAst, { columnWidth });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  return true;
}

export function recoverExactStackReturn(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const control = recoveryControl(opts);
  if (control.isAborted()) return result;
  const output = returnOutput(result, control);
  const root = output?.expression;
  const rootLocation = fieldValue(root, 'location');
  const rootKey = fieldValue(rootLocation, 'key');
  if (fieldValue(root, 'kind') !== 'load' || fieldValue(rootLocation, 'kind') !== 'stack'
      || typeof rootKey !== 'string' || rootKey.length === 0) return result;
  const instructions = arrayField(result.ir, 'instructions');
  if (!instructions.ok) return result;
  const returns = [];
  for (const instruction of instructions.value) {
    if (control.isAborted()) return result;
    if (fieldValue(instruction, 'op') === 'ret') returns.push(instruction);
  }
  const returnStatements = returnNodes(result, control);
  if (!returnStatements) return result;
  // Stack-PHI recovery is path-local. The fallback has no per-output return
  // envelope, so it must not guess among multiple physical RETs or statements.
  if (returns.length !== 1 || returnStatements.length !== 1) return result;
  const ret = returns[0];
  const loadProof = exactReturnLoad(result, root, ret, control);
  if (!loadProof || !returnNodeMatches(returnStatements[0], ret, control)) return result;

  const values = mapsOf(result, control);
  if (!values) return result;
  const nodeBudget = validWorkBudget(fieldValue(opts, 'decompilerNodeBudget'), 12000);
  const timeBudget = validTimeBudget(fieldValue(opts, 'decompilerTimeBudgetMs'), 50);
  // A direct stack proof can resolve a literal without entering RewriteEngine;
  // honor a zero caller budget before that proof starts. Deterministic mode
  // intentionally disables only the wall-clock deadline, so its time zero is
  // still allowed when work remains.
  if (nodeBudget === 0 || (!control.deterministic && timeBudget === 0)) return result;
  const engine = new RewriteEngine(DEFAULT_RULES, {
    maxIterations:10,
    nodeBudget:Math.min(2048, nodeBudget),
    timeBudgetMs:Math.min(12, timeBudget / 4),
    deterministic:control.deterministic,
    maxApplications:512,
  });
  if (control.isAborted()) return result;
  let committed = committedReturnValue(result, root, ret, opts, control, loadProof.load);
  let committedSpill = null;
  if (!committed) {
    const proof = committedStackSpillOnExactReturnPath(result, root, loadProof.load, loadProof.size, control);
    if (proof) {
      committedSpill = proof.stackStore;
      const rootBits = fieldValue(root, 'bits');
      if (!validBits(rootBits)) return result;
      committed = expr.load(proof.location, rootBits, fieldValue(root, 'source'), {
        signed:fieldValue(root, 'signed') ?? null,
        proof:'exact return-path spill carries an SSA phi whose predecessors commit one lvalue',
      });
    }
  }
  const recovered = committed || resolve(result.ir, fieldValue(loadProof.load, 'block'), fieldValue(loadProof.load, 'row'), rootKey,
    loadProof.size, values, opts, engine, new Set(), 0, control);
  // A stack load means no useful reconstruction happened. A committed non-stack
  // field/global load is an intentional high-level return and must be retained.
  const transaction = snapshotReturnPublication(result);
  if (!recovered || (recovered.kind === 'load' && recovered.location?.kind === 'stack')
      || !rewriteReturn(result, recovered, opts, ret, control)) {
    restoreReturnPublication(result, transaction);
    return result;
  }
  if (committedSpill && (!removeProofOnlyStackSpill(result, committedSpill, opts, control)
      || control.isAborted())) {
    restoreReturnPublication(result, transaction);
    return result;
  }
  // Do not append proof or metrics after a cancellation that arrived during
  // cleanup.  The complete publication is one transaction with the AST edit.
  if (control.isAborted()) {
    restoreReturnPublication(result, transaction);
    return result;
  }

  result.rewriteProof = [...(result.rewriteProof || []), {
    rule:'exact-stack-return-recovery', phase:'memory-ssa',
    evidence:{ kind:'cfg-memory-ssa', detail:'exact stack return reconstructed from predecessor stores and flag-producing SSA evidence' },
  }];
  result.metrics = { ...(result.metrics || {}), rewrittenExpressions:(result.metrics?.rewrittenExpressions || 0) + 1, sourceMappedNodes:result.sourceMap?.length || 0 };
  result.ctx = { ...(result.ctx || {}), decompilerPipeline:{ ...(result.ctx?.decompilerPipeline || {}), exactStackReturnRecovered:true } };
  return result;
}
