import { expr, mapChildren, structuralKey } from '../ast/nodes.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression } from '../flag-semantics.js';

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

function valueOf(arg) {
  const field = ownData(arg, 'value');
  return field.present && field.valid ? field.value || null : null;
}

function fieldValue(object, key) {
  const field = ownData(object, key);
  return field.present && field.valid ? field.value : undefined;
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
  // Every non-deterministic scan has a finite wall-clock default. Invalid or
  // omitted caller budgets must not silently make the structural walk
  // unbounded.
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
  const insts = arrayField(block, 'insts');
  if (!insts.ok) return null;
  for (let i = insts.value.length - 1; i >= 0; i--) {
    if (control?.isAborted?.()) return null;
    if (['cbr', 'br', 'ret'].includes(fieldValue(insts.value[i], 'op'))) return insts.value[i];
  }
  return null;
}

function branchSuccessors(ir, block, term, opts, control) {
  const successors = arrayField(block, 'succ');
  if (!successors.ok) {
    return { yes:null, no:null, exact:false };
  }
  for (const successor of successors.value) {
    if (control?.isAborted?.() || !validBlock(successor)) return { yes:null, no:null, exact:false };
  }
  const op = fieldValue(term, 'op');
  if (op !== 'cbr' || successors.value.length < 2) {
    return { yes: successors.value[0] ?? null, no: successors.value[1] ?? null, exact: op !== 'cbr' };
  }
  const yes = targetBlock(ir, term, opts, control);
  if (yes == null) return { yes: null, no: null, exact: false };
  let hasYes = false;
  let no = null;
  for (const successor of successors.value) {
    if (control?.isAborted?.()) return { yes:null, no:null, exact:false };
    if (successor === yes) hasYes = true;
    else if (no == null) no = successor;
  }
  return hasYes ? { yes, no, exact: true } : { yes:null, no:null, exact:false };
}

function canReach(ir, start, target, blocked, cap = 256, control) {
  if (start == null || target == null) return false;
  const queue = [start];
  const seen = new Set();
  const blocks = arrayField(ir, 'blocks');
  if (!blocks.ok) return false;
  while (queue.length && cap-- > 0) {
    if (control?.isAborted?.()) return false;
    const current = queue.shift();
    if (current === target) return true;
    if (current === blocked || seen.has(current)) continue;
    seen.add(current);
    const successors = arrayField(blocks.value[current], 'succ');
    if (!successors.ok) return false;
    for (const next of successors.value) {
      if (control?.isAborted?.() || !validBlock(next)) return false;
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

function armIndex(ir, controllerIndex, successor, mergeBlock, predecessors, control) {
  if (successor === mergeBlock) {
    for (let index = 0; index < predecessors.length; index++) {
      if (control?.isAborted?.()) return -1;
      if (predecessors[index] === controllerIndex) return index;
    }
    return -1;
  }
  for (let index = 0; index < predecessors.length; index++) {
    if (control?.isAborted?.()) return -1;
    if (canReach(ir, successor, predecessors[index], mergeBlock, 256, control)) return index;
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

function controllerForMerge(ir, mergeBlock, predecessors, opts, control) {
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
    if (!dominates(ir, blockIndex, mergeBlock, control)) continue;
    const term = terminal(block, control);
    if (fieldValue(term, 'op') !== 'cbr' || successors.value.length < 2) continue;
    const arms = branchSuccessors(ir, block, term, opts, control);
    if (!arms.exact) continue;
    const yesIndex = armIndex(ir, blockIndex, arms.yes, mergeBlock, predecessors, control);
    const noIndex = armIndex(ir, blockIndex, arms.no, mergeBlock, predecessors, control);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    candidates.push({ term, yesIndex, noIndex, depth: domDepth(ir, blockIndex, control) });
  }
  candidates.sort((a, b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function expressionMaps(result, control) {
  const values = new Map();
  for (const item of result.semanticAst?.values || []) {
    if (control?.isAborted?.()) return null;
    const id = fieldValue(item, 'valueId');
    if (id != null) values.set(id, fieldValue(item, 'expression'));
  }
  const conditions = new Map();
  for (const item of result.semanticAst?.conditions || []) {
    if (control?.isAborted?.()) return null;
    const id = fieldValue(item, 'ir');
    if (id != null) conditions.set(id, fieldValue(item, 'expression'));
  }
  return { values, conditions };
}

function simplify(expression, engine, control) {
  if (!expression) return null;
  if (control?.isAborted?.()) return null;
  const rewritten = engine.rewrite(expression, control?.engineContext || {}).root;
  return control?.isAborted?.() ? null : rewritten;
}

const INVERT_OP = Object.freeze({ eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' });

function expressionOfValue(value, maps) {
  const id = fieldValue(value, 'id');
  return value && id != null ? maps.values.get(id) || null : null;
}

/*
 * Flag-setting ARM64 arithmetic is lifted as a value-producing BIN followed by
 * a same-row CMP/NZCV operation. SSA rename may bind the CMP's first register
 * read to the BIN result (SUBS: (a-b) ? b) rather than the pre-write a. Repair
 * only when the Semantic IR itself proves a unique same-row companion BIN with
 * the same arithmetic sub-op. No ARM64 text is reparsed here.
 */
function sameRowFlagProducer(cmp, ir, control) {
  if (control?.isAborted?.()) return null;
  const cmpRow = fieldValue(cmp, 'row');
  const cmpSub = fieldValue(cmp, 'sub');
  if (!validRow(cmpRow) || !['sub', 'add', 'and'].includes(cmpSub)) return null;
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok) return null;
  const candidates = [];
  for (const inst of instructions.value) {
    if (control?.isAborted?.()) return null;
    const args = arrayField(inst, 'args');
    const dst = fieldValue(inst, 'dst');
    if (inst !== cmp && fieldValue(inst, 'op') === 'bin'
      && fieldValue(inst, 'row') === cmpRow && fieldValue(inst, 'sub') === cmpSub
      && args.ok && args.value.length >= 2 && dst != null) candidates.push(inst);
  }
  if (candidates.length !== 1) return null;
  const producer = candidates[0];
  const cmpArgs = arrayField(cmp, 'args');
  const observed = cmpArgs.ok ? valueOf(cmpArgs.value[0]) : null;
  const observedReg = fieldValue(observed, 'reg');
  const producerReg = fieldValue(fieldValue(producer, 'dst'), 'reg');
  if (observedReg != null && producerReg != null && observedReg !== producerReg) return null;
  return producer;
}

function repairedFlagComparison(flagsValue, cond, maps, ir, control) {
  if (control?.isAborted?.()) return null;
  const cmp = fieldValue(flagsValue, 'def');
  if (fieldValue(cmp, 'op') !== 'cmp') return null;

  const cmpArgs = arrayField(cmp, 'args');
  if (!cmpArgs.ok) return null;
  let leftValue = valueOf(cmpArgs.value[0]);
  let rightValue = valueOf(cmpArgs.value[1]);
  const shadow = fieldValue(leftValue, 'def');
  let producer = null;
  if (fieldValue(shadow, 'op') === 'bin'
      && fieldValue(shadow, 'row') === fieldValue(cmp, 'row')
      && fieldValue(shadow, 'sub') === fieldValue(cmp, 'sub')) producer = shadow;
  if (!producer) producer = sameRowFlagProducer(cmp, ir, control);
  if (producer) {
    const producerArgs = arrayField(producer, 'args');
    if (!producerArgs.ok) return null;
    const originalLeft = valueOf(producerArgs.value[0]);
    const originalRight = valueOf(producerArgs.value[1]);
    if (originalLeft && originalRight) {
      leftValue = originalLeft;
      rightValue = originalRight;
    }
  }

  let left = expressionOfValue(leftValue, maps);
  let right = expressionOfValue(rightValue, maps);
  if (!left || !right) return null;
  const operandBits = [fieldValue(leftValue, 'bits'), fieldValue(rightValue, 'bits')]
    .filter(validBits);
  const exactOperandBits = operandBits.length === 2 && operandBits[0] === operandBits[1]
    ? operandBits[0]
    : 0;
  const cmpBitsField = ownData(cmp, 'bits');
  const producerBitsField = ownData(producer, 'bits');
  const producerDstBitsField = ownData(fieldValue(producer, 'dst'), 'bits');
  if ((cmpBitsField.present && (!cmpBitsField.valid || !validBits(cmpBitsField.value)))
      || (producerBitsField.present && (!producerBitsField.valid || !validBits(producerBitsField.value)))
      || (producerDstBitsField.present && (!producerDstBitsField.valid || !validBits(producerDstBitsField.value)))) return null;
  const producerBits = cmpBitsField.present ? cmpBitsField.value
    : producerBitsField.present ? producerBitsField.value
      : producerDstBitsField.present ? producerDstBitsField.value : exactOperandBits;
  const leftBits = fieldValue(left, 'bits');
  const rightBits = fieldValue(right, 'bits');
  if ((leftBits != null && !validBits(leftBits)) || (rightBits != null && !validBits(rightBits))) return null;
  const bits = producerBits > 0
    ? producerBits
    : Math.max(leftBits || 0, rightBits || 0, 1);
  const fitOperand = (node) => {
    const nodeBitsField = ownData(node, 'bits');
    if (nodeBitsField.present && (!nodeBitsField.valid || !validBits(nodeBitsField.value))) return null;
    const nodeBits = nodeBitsField.present ? nodeBitsField.value : bits;
    return nodeBits > bits
      ? expr.unary('trunc', node, bits, fieldValue(node, 'signed') ?? null, {
        address: fieldValue(cmp, 'address'),
        row: fieldValue(cmp, 'row'),
        ir: fieldValue(cmp, 'id'),
        evidence: [{ reason: `exact ${bits}-bit NZCV producer width` }],
      }, { fromBits: nodeBits })
      : node;
  };
  left = fitOperand(left);
  right = fitOperand(right);
  if (!left || !right) return null;
  const cmpSub = fieldValue(cmp, 'sub');
  const cmpRow = fieldValue(cmp, 'row');
  const cmpId = fieldValue(cmp, 'id');
  const leftId = idKey(fieldValue(leftValue, 'id'));
  const rightId = idKey(fieldValue(rightValue, 'id'));
  return buildNZCVConditionExpression(cmpSub || 'sub', cond, left, right, bits, {
    address: fieldValue(cmp, 'address'),
    row: cmpRow,
    ir: cmpId,
    ssaUses: [leftId, rightId].filter((x) => x != null),
    evidence: [{ reason: producer ? 'same-row flag producer operands' : 'NZCV comparison' }],
  });
}

function invertCondition(condition) {
  if (condition?.kind === 'compare' && INVERT_OP[condition.op]) {
    return expr.compare(INVERT_OP[condition.op], condition.left, condition.right, condition.compareSigned, condition.source);
  }
  return expr.unary('lnot', condition, 1, false, condition?.source);
}

function materializedFlagCondition(term, maps, ir, control) {
  if (control?.isAborted?.()) return null;
  const extra = fieldValue(term, 'extra');
  const kind = fieldValue(extra, 'kind') || fieldValue(term, 'sub') || '';
  if (!['tbz', 'tbnz', 'cbz', 'cbnz'].includes(kind)) return null;
  const termArgs = arrayField(term, 'args');
  if (!termArgs.ok) return null;
  const tested = valueOf(termArgs.value[0]);
  const select = fieldValue(tested, 'def');
  if (fieldValue(select, 'op') !== 'sel' || !['set', 'setm'].includes(fieldValue(select, 'sub'))) return null;

  const selectArgs = arrayField(select, 'args');
  if (!selectArgs.ok) return null;
  const flagsValue = valueOf(selectArgs.value.at(-1));
  const condition = repairedFlagComparison(flagsValue, fieldValue(select, 'cond'), maps, ir, control);
  if (!condition) return null;

  // cset/csetm materialize true as a non-zero value and false as zero. Branches
  // on non-zero therefore preserve the condition; zero branches invert it.
  return kind === 'tbz' || kind === 'cbz' ? invertCondition(condition) : condition;
}

function directFlagCondition(term, maps, ir, control) {
  if (control?.isAborted?.()) return null;
  const extra = fieldValue(term, 'extra');
  const cond = fieldValue(term, 'cond') || fieldValue(extra, 'cond');
  if (!cond) return null;
  const args = arrayField(term, 'args');
  return args.ok ? repairedFlagComparison(valueOf(args.value.at(-1)), cond, maps, ir, control) : null;
}

function resolveConditionStackLoads(condition, maps, engine, ir, opts, active, depth = 0, control) {
  const rewrite = (node, localDepth = depth) => {
    if (control?.isAborted?.()) return null;
    if (!node || localDepth > 64) return node;
    if (node.kind === 'load' && node.location?.kind === 'stack' && node.location?.key) {
      const slot = exactStackLoadSlot(ir, null, node, control);
      if (!slot) return node;
      return resolveStackBefore(ir, fieldValue(slot.load, 'block'), fieldValue(slot.load, 'row'), slot.key, slot.size,
        maps, opts, engine, active, localDepth + 1, control) || node;
    }
    return mapChildren(node, (child) => rewrite(child, localDepth + 1));
  };
  return rewrite(condition);
}

function controlCondition(term, maps, engine, ir, opts, active, depth, control) {
  const condition = materializedFlagCondition(term, maps, ir, control)
    || directFlagCondition(term, maps, ir, control)
    || maps.conditions.get(fieldValue(term, 'id'));
  if (!condition) return null;
  return simplify(resolveConditionStackLoads(condition, maps, engine, ir, opts, active, depth, control), engine, control);
}

function positiveAccessSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 8) ? value : null;
}

function exactStackLoadSource(ir, value, expression, control) {
  if (control?.isAborted?.()) return null;
  const expressionLocation = fieldValue(expression, 'location');
  const expressionKind = fieldValue(expression, 'kind');
  const expressionKey = fieldValue(expressionLocation, 'key');
  if (expressionKind !== 'load' || fieldValue(expressionLocation, 'kind') !== 'stack'
      || typeof expressionKey !== 'string' || expressionKey.length === 0) return null;
  // `value.def` is SSA metadata and may be a detached presentation object. A
  // recovery proof must bind to exactly one physical LOAD in ir.instructions;
  // the detached object is never sufficient by itself.
  const ids = sourceValues(expression, 'ir', idKey, control);
  if (!ids || ids.length === 0) return null;
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok) return null;
  const candidates = [];
  for (const inst of instructions.value) {
    if (control?.isAborted?.()) return null;
    const id = idKey(fieldValue(inst, 'id'));
    const op = fieldValue(inst, 'op');
    const location = fieldValue(inst, 'loc');
    const kind = fieldValue(location, 'kind');
    const key = fieldValue(location, 'key');
    if (id != null && ids.includes(id) && op === 'load' && kind === 'stack'
      && key === expressionKey) candidates.push(inst);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function exactStackLoadSlot(ir, value, expression, control) {
  const load = exactStackLoadSource(ir, value, expression, control);
  const location = fieldValue(load, 'loc');
  const size = positiveAccessSize(fieldValue(location, 'size'));
  const block = fieldValue(load, 'block');
  const row = fieldValue(load, 'row');
  const key = fieldValue(location, 'key');
  return load && size != null && validBlock(block) && validRow(row) && typeof key === 'string' && key.length > 0
    ? { load, key, size } : null;
}

function storeAccessSize(inst) {
  const location = fieldValue(inst, 'loc');
  const locSize = ownData(location, 'size');
  if (locSize.present) return locSize.valid ? positiveAccessSize(locSize.value) : null;
  return positiveAccessSize(fieldValue(inst, 'size'));
}

function exactStoreExpression(inst, key, size, maps, engine, ir, opts, active, depth, control) {
  const location = fieldValue(inst, 'loc');
  if (control?.isAborted?.() || fieldValue(inst, 'op') !== 'store' || fieldValue(location, 'kind') !== 'stack'
      || fieldValue(location, 'key') !== key
      || storeAccessSize(inst) !== size) return null;
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok) return null;
  let occurrences = 0;
  for (const candidate of instructions.value) {
    if (control?.isAborted?.()) return null;
    if (candidate === inst) occurrences += 1;
  }
  if (occurrences !== 1) return null;
  if (!validBlock(fieldValue(inst, 'block')) || !validRow(fieldValue(inst, 'row'))) return null;
  const args = fieldValue(inst, 'args');
  const value = Array.isArray(args) ? valueOf(args[0]) : null;
  const valueId = fieldValue(value, 'id');
  let expression = value && valueId != null ? maps.values.get(valueId) || null : null;
  if (!expression) return null;

  // Clang -O0 often copies an argument spill into the branch-local return slot.
  // Resolve that nested stack load at its own program point through the same
  // CFG/barrier proof before publishing the outer join. If the source cannot be
  // proven exactly, fail closed instead of emitting a select of unresolved loads.
  const expressionLocation = fieldValue(expression, 'location');
  if (fieldValue(expression, 'kind') === 'load' && fieldValue(expressionLocation, 'kind') === 'stack') {
    const sourceSlot = exactStackLoadSlot(ir, value, expression, control);
    if (!sourceSlot) return null;
    expression = resolveStackBefore(ir, fieldValue(sourceSlot.load, 'block'), fieldValue(sourceSlot.load, 'row'),
      sourceSlot.key, sourceSlot.size, maps, opts, engine, active, depth + 1, control);
    if (!expression) return null;
  }

  // A W-register store is an exact truncation boundary. Keep that width in the
  // recovered source value instead of leaking the 64-bit entry-register width
  // through an -O0 spill. This is essential for signed int32 comparisons such
  // as clamp(x,0) when x has bit 31 set.
  const storeBits = size * 8;
  const expressionBits = ownData(expression, 'bits');
  if (expressionBits.present && (!expressionBits.valid || !validBits(expressionBits.value))) return null;
  if (storeBits > 0 && expressionBits.present && expressionBits.value > storeBits) {
    expression = simplify(expr.unary('trunc', expression, storeBits, fieldValue(expression, 'signed'), {
      address: fieldValue(inst, 'address'),
      row: fieldValue(inst, 'row'),
      ir: fieldValue(inst, 'id'),
      evidence: [{ reason: `exact ${storeBits}-bit stack store width` }],
    }, { fromBits: expressionBits.value }), engine, control);
  }
  return expression;
}

function instructionsBefore(ir, blockIndex, beforeRow, control) {
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok || !validBlock(blockIndex) || (beforeRow != null && !validRow(beforeRow))) return null;
  const selected = [];
  const memoryRows = new Set();
  const memoryMutations = new Map();
  const physicalLoads = new Map();
  for (const inst of instructions.value) {
    if (control?.isAborted?.()) return null;
    const block = fieldValue(inst, 'block');
    if (!validBlock(block)) return null;
    if (block !== blockIndex) continue;
    const row = fieldValue(inst, 'row');
    const op = fieldValue(inst, 'op');
    // Every physical instruction in the scanned block needs an authentic row.
    // Otherwise the order relation can be forged by a getter or a coercible
    // string and an older value could be published.
    if (!validRow(row)) return null;
    // A physical LOAD colliding with a same-location mutation has no
    // authenticated order. Unrelated machine memory operations can share a
    // semantic row (for example a field read and a stack spill), so only the
    // candidate location collision is ambiguous.
    if (op === 'load') {
      const loadKey = fieldValue(fieldValue(inst, 'loc'), 'key');
      const mutations = memoryMutations.get(row) || [];
      if (mutations.some((mutation) => mutation.op !== 'store' || mutation.key == null
          || loadKey == null || mutation.key === loadKey)) return null;
      const loads = physicalLoads.get(row) || [];
      loads.push(loadKey);
      physicalLoads.set(row, loads);
    } else if (['store', 'call', 'clobber', 'unknown'].includes(op)) {
      if (memoryRows.has(row)) return null;
      const locationKey = op === 'store' ? fieldValue(fieldValue(inst, 'loc'), 'key') : null;
      const loads = physicalLoads.get(row) || [];
      if (loads.some((loadKey) => op !== 'store' || locationKey == null
          || loadKey == null || locationKey === loadKey)) return null;
      memoryRows.add(row);
      const mutations = memoryMutations.get(row) || [];
      mutations.push({ op, key:locationKey });
      memoryMutations.set(row, mutations);
    }
    if (beforeRow == null || row < beforeRow) selected.push(inst);
  }
  selected.sort((a, b) => fieldValue(b, 'row') - fieldValue(a, 'row'));
  return selected;
}

function hasUnsafeBarrier(inst, key) {
  const op = fieldValue(inst, 'op');
  const location = fieldValue(inst, 'loc');
  const locationKey = fieldValue(location, 'key');
  const locationKind = fieldValue(location, 'kind');
  if (op === 'call' || op === 'clobber' || op === 'unknown') return true;
  return op === 'store' && (locationKey !== key || locationKind !== 'stack')
    && (!locationKey || locationKind === 'unknown');
}

function resolveStackBefore(ir, blockIndex, beforeRow, key, size, maps, opts, engine, active, depth = 0, control) {
  if (control?.isAborted?.() || !validBlock(blockIndex) || (beforeRow != null && !validRow(beforeRow))
      || positiveAccessSize(size) == null || depth > 64) return null;
  const visitKey = `${blockIndex}:${beforeRow ?? 'end'}:${key}:${size}`;
  if (active.has(visitKey)) return null;
  active.add(visitKey);
  try {
    const instructions = instructionsBefore(ir, blockIndex, beforeRow, control);
    if (!instructions) return null;
    for (const inst of instructions) {
      if (control?.isAborted?.()) return null;
      const op = fieldValue(inst, 'op');
      const location = fieldValue(inst, 'loc');
      if (op === 'store' && fieldValue(location, 'kind') === 'stack' && fieldValue(location, 'key') === key) {
        return exactStoreExpression(inst, key, size, maps, engine, ir, opts, active, depth, control);
      }
      if (hasUnsafeBarrier(inst, key)) return null;
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
      const resolved = resolveStackBefore(ir, pred, null, key, size, maps, opts, engine, active, depth + 1, control);
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

    const mergeControl = controllerForMerge(ir, blockIndex, predecessors, opts, control);
    if (!mergeControl) return null;
    const condition = controlCondition(mergeControl.term, maps, engine, ir, opts, active, depth + 1, control);
    if (!condition) return null;
    const bits = size * 8;
    const signed = fieldValue(condition, 'compareSigned') ?? fieldValue(incoming[0], 'signed')
      ?? fieldValue(incoming[1], 'signed') ?? null;

    // `yesIndex` is the machine branch target (condition true), `noIndex` is the
    // fallthrough arm. armIndex() handles a direct-to-merge edge by selecting the
    // controller block's value, so the mapping is valid for both diamonds and
    // guard-style shapes such as Clang's O0 clamp.
    return simplify(expr.select(condition, incoming[mergeControl.yesIndex], incoming[mergeControl.noIndex], bits, signed, {
      address: fieldValue(mergeControl.term, 'address'),
      row: fieldValue(mergeControl.term, 'row'),
      ir: fieldValue(mergeControl.term, 'id'),
      evidence: [{ reason: 'exact stack Memory-SSA/CFG join' }],
    }), engine, control);
  } finally {
    active.delete(visitKey);
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

function stackReturnSlot(ir, expression, control) {
  const slot = exactStackLoadSlot(ir, null, expression, control);
  // A rendered stack key is not evidence that a physical read occurred.
  const bits = fieldValue(expression, 'bits');
  if (!slot || !validBits(bits) || slot.size * 8 !== bits) return null;
  return slot;
}

function returnSiteForNode(node, ir, allowSingleFallback = false, control) {
  const instructions = arrayField(ir, 'instructions');
  if (!instructions.ok) return null;
  const rets = [];
  for (const inst of instructions.value) {
    if (control?.isAborted?.()) return null;
    if (fieldValue(inst, 'op') === 'ret') rets.push(inst);
  }
  if (!rets.length) return null;
  const rows = sourceValues(node, 'rows', (row) => validRow(row) ? row : null, control);
  const irIds = sourceValues(node, 'ir', idKey, control);
  const addresses = sourceValues(node, 'addresses', addressKey, control);
  if (rows == null || irIds == null || addresses == null) return null;
  const rowSet = new Set(rows);
  const idSet = new Set(irIds);
  const addressSet = new Set(addresses);
  const matches = [];
  for (const ret of rets) {
    if (control?.isAborted?.()) return null;
    const row = fieldValue(ret, 'row');
    const id = idKey(fieldValue(ret, 'id'));
    const address = addressKey(fieldValue(ret, 'address'));
    if (rowSet.has(row) || (id != null && idSet.has(id)) || (address != null && addressSet.has(address))) matches.push(ret);
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length && allowSingleFallback && rets.length === 1) return rets[0];
  return null;
}

function recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback, control) {
  if (control?.isAborted?.()) return null;
  const output = returnOutput(result, control);
  const nodeSlot = stackReturnSlot(result.ir, node?.semantic?.expression, control);
  const slot = nodeSlot || (allowSingleFallback ? stackReturnSlot(result.ir, output?.expression, control) : null);
  if (!slot) return null;
  const retInst = returnSiteForNode(node, result.ir, allowSingleFallback, control);
  if (!retInst) return null;
  const load = slot.load;
  const loadRow = fieldValue(load, 'row');
  const retRow = fieldValue(retInst, 'row');
  const loadBlock = fieldValue(load, 'block');
  const retBlock = fieldValue(retInst, 'block');
  if (!validRow(loadRow) || !validRow(retRow) || !validBlock(loadBlock) || !validBlock(retBlock)) return null;
  if (loadBlock === retBlock) {
    if (loadRow >= retRow) return null;
  } else if (!dominates(result.ir, loadBlock, retBlock, control)) {
    return null;
  }
  // Stores after this read cannot change the value already consumed by RET.
  return resolveStackBefore(result.ir, loadBlock, loadRow, slot.key, slot.size,
    maps, opts, engine, new Set(), 0, control);
}

function rewriteReturnsInAst(result, maps, opts, engine, control) {
  const nodes = returnNodes(result, control);
  if (!nodes) return { changed:0, recovered:[], aborted:true };
  if (!nodes.length) return { changed:0, recovered:[] };
  const recovered = [];
  const allowSingleFallback = nodes.length === 1;
  for (const node of nodes) {
    if (control?.isAborted?.()) return { changed:0, recovered:[], aborted:true };
    const expression = recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback, control);
    if (!expression || expression.kind === 'load') continue;
    recovered.push({ node, expression });
  }
  // Recovery is a transaction: a cancellation during the scan must leave all
  // statements and semantic outputs at their original values.
  if (control?.isAborted?.()) return { changed:0, recovered:[], aborted:true };
  const output = returnOutput(result, control);
  if (control?.isAborted?.()) return { changed:0, recovered:[], aborted:true };
  const originals = [];
  for (const { node } of recovered) {
    if (control?.isAborted?.()) return { changed:0, recovered:[], aborted:true };
    originals.push({ node, text:node.text, expression:node.semantic?.expression });
  }
  const originalOutput = output?.expression;
  const rollback = () => {
    for (const { node, text, expression } of originals) {
      node.text = text;
      if (node.semantic) node.semantic.expression = expression;
    }
    if (output && recovered.length === 1 && nodes.length === 1) output.expression = originalOutput;
  };
  for (const { node, expression } of recovered) {
    if (control?.isAborted?.()) {
      rollback();
      return { changed:0, recovered:[], aborted:true };
    }
    node.text = `return ${printExpression(expression)};`;
    if (node.semantic) node.semantic.expression = expression;
  }
  if (recovered.length === 1 && nodes.length === 1 && output) {
    output.expression = recovered[0].expression;
  }
  if (control?.isAborted?.()) {
    rollback();
    return { changed:0, recovered:[], aborted:true };
  }
  return { changed:recovered.length, recovered, rollback };
}

export function recoverExactStackPhiExpressions(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const control = recoveryControl(opts);
  if (control.isAborted()) return result;
  const maps = expressionMaps(result, control);
  if (!maps) return result;
  const nodeBudget = validWorkBudget(fieldValue(opts, 'decompilerNodeBudget'), 12000);
  const timeBudget = validTimeBudget(fieldValue(opts, 'decompilerTimeBudgetMs'), 50);
  // Direct Memory-SSA proofs do not need the rewrite engine for a literal
  // store, so enforce a zero caller budget before beginning the scan as well.
  if (nodeBudget === 0 || (!control.deterministic && timeBudget === 0)) return result;
  const engine = new RewriteEngine(DEFAULT_RULES, {
    maxIterations: 10,
    nodeBudget: Math.min(2048, nodeBudget),
    timeBudgetMs: Math.min(10, timeBudget / 5),
    deterministic: control.deterministic,
    maxApplications: 512,
  });
  const rewrite = rewriteReturnsInAst(result, maps, opts, engine, control);
  if (rewrite.aborted || control.isAborted() || !rewrite.changed) return result;

  if (control.isAborted()) return result;
  const columnWidth = fieldValue(opts, 'columnWidth') || fieldValue(opts, 'prettyColumnWidth') || 88;
  const printed = printProgram(result.cAst, { columnWidth });
  if (control.isAborted()) {
    rewrite.rollback?.();
    return result;
  }
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind: node.kind,
    indent: node.indent,
    text: node.text,
    row: node.source?.rows?.[0] ?? null,
    addr: node.source?.addresses?.[0] ?? null,
    note: null,
    source: node.source,
  }));
  result.rewriteProof = [...(result.rewriteProof || []), {
    rule: 'exact-stack-phi-recovery',
    phase: 'memory-ssa',
    evidence: { kind: 'cfg-memory-ssa', detail: `${rewrite.changed} return site(s) reconstructed from exact RET provenance without crossing unknown memory effects` },
  }];
  result.metrics = {
    ...(result.metrics || {}),
    rewrittenExpressions: (result.metrics?.rewrittenExpressions || 0) + rewrite.changed,
    sourceMappedNodes: printed.mapping.length,
  };
  result.ctx = {
    ...(result.ctx || {}),
    decompilerPipeline: {
      ...(result.ctx?.decompilerPipeline || {}),
      exactStackPhiRecovered: true,
    },
  };
  return result;
}
