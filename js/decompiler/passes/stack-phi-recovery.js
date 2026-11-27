import { expr, mapChildren, structuralKey, mergeSource } from '../ast/nodes.js';
import { RewriteEngine, RewriteHistoryJournal, expressionOriginHistory } from '../rewrite/engine.js';
import { captureRecoveryIrData, PROJECTION_LIMITS } from '../phase8/projection-origin.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression, invertBooleanCondition } from '../flag-semantics.js';
import { uniqueReachableMergePredecessorIndex } from './stack-join-arm-proof.js';

// Only a successful recovery below can issue this presentation binding.
const recoveryConsumers = new WeakMap();
export function readStackPhiHistoryConsumer(semantic, ir) {
  const binding = recoveryConsumers.get(semantic);
  if (!binding || binding.ir !== ir) return null;
  const data = key => Object.getOwnPropertyDescriptor(semantic, key)?.value;
  return data('expression') === binding.expression && data('op') === binding.op
    && data('ir') === binding.instructionId && data('location') === binding.location
    && binding.isCurrent() ? binding : null;
}

function bindRecoveries(result, recovered, opts) {
  const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
  const budget = opts.renderProvenanceBindingBudget;
  const reasons = new Set(result.expressionHistoryBinding?.reasons || []);
  let remaining = cap(budget?.maxConsumers, 4096);
  // Observe shared canonical dependencies once, not once per return site.
  try {
    const observation = captureRecoveryIrData(result.ir, [
      recovered.map(({ node, records }) => [node.semantic?.expression, records])], opts.shouldAbort);
    if (observation.metrics.edges > cap(budget?.maxEdges, PROJECTION_LIMITS.edges)) {
      reasons.add('recovery-binding-budget');
    } else {
      for (const { node, records } of recovered) {
        const semantic = node.semantic;
        if (!semantic) { reasons.add('recovery-consumer-unavailable'); continue; }
        if (remaining-- <= 0) { reasons.add('recovery-binding-budget'); continue; }
        recoveryConsumers.set(semantic, Object.freeze({ ir:result.ir,
          expression:semantic.expression, op:semantic.op, instructionId:semantic.ir,
          location:semantic.location, records,
          isCurrent:() => observation.matches(),
        }));
      }
    }
  } catch { reasons.add('recovery-binding-observation-unavailable'); }
  if (reasons.size) result.expressionHistoryBinding = Object.freeze({
    completeness:'incomplete', reasons:Object.freeze([...reasons].sort()),
  });
}

function valueOf(arg) { return arg?.value || null; }

function retainRecoverySource(maps, instruction) {
  if (!instruction || !maps.recoverySources) return;
  if (maps._sourceCollector && maps._sourceCollector.size < 512) maps._sourceCollector.add(instruction);
  if (maps.recoverySources.size < 512) maps.recoverySources.add(instruction);
  else if (!maps.recoverySources.has(instruction)) maps.recoverySourcesTruncated = true;
}

function recoveryOriginHistory(before, expression, maps) {
  const sources = [...maps.recoverySources].map(inst => ({
    address:inst.address, row:inst.row, ir:inst.id, ssaDef:inst.dst?.id,
    ssaUses:(inst.args || []).map(valueOf).filter(Boolean).map(value => value.id),
  }));
  const history = expressionOriginHistory({ source:mergeSource(before?.source, ...sources) }, expression);
  return maps.recoverySourcesTruncated
    ? Object.freeze({ ...history, truncated:true }) : history;
}

function createPassIndex(ir) {
  const blocks = ir?.blocks || [];
  const blockByIndex = new Map();
  let sortedDisjointRows = true;
  let prevEndRow = -Infinity;
  let hasAnyBlockInsts = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) { sortedDisjointRows = false; continue; }
    if (block.index != null) blockByIndex.set(block.index, block);
    if (!hasAnyBlockInsts && Array.isArray(block.insts) && block.insts.length > 0) hasAnyBlockInsts = true;
    if (sortedDisjointRows) {
      if (typeof block.startRow === 'number' && typeof block.endRow === 'number'
          && block.startRow <= block.endRow && block.startRow > prevEndRow) {
        prevEndRow = block.endRow;
      } else {
        sortedDisjointRows = false;
      }
    }
  }
  const blockInstsDesc = new Map();
  if (hasAnyBlockInsts) {
    for (const block of blocks) {
      if (!block || block.index == null) continue;
      const insts = block.insts;
      if (!insts || !insts.length) { blockInstsDesc.set(block.index, []); continue; }
      blockInstsDesc.set(block.index, [...insts].sort((a, b) => (b.row ?? -1) - (a.row ?? -1) || (b.id ?? -1) - (a.id ?? -1)));
    }
  } else {
    for (const inst of ir?.instructions || []) {
      if (inst?.block == null) continue;
      let list = blockInstsDesc.get(inst.block);
      if (!list) { list = []; blockInstsDesc.set(inst.block, list); }
      list.push(inst);
    }
    for (const list of blockInstsDesc.values()) {
      list.sort((a, b) => (b.row ?? -1) - (a.row ?? -1) || (b.id ?? -1) - (a.id ?? -1));
    }
  }
  const domDepthCache = new Map();
  return { blocks, blockByIndex, sortedDisjointRows, blockInstsDesc, domDepthCache };
}

function blockForRow(ir, row, passIndex = null) {
  const blocks = passIndex?.blocks || ir?.blocks;
  if (!blocks || !blocks.length) return null;
  if (passIndex?.sortedDisjointRows && typeof row === 'number') {
    let lo = 0, hi = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = blocks[mid];
      if (row < b.startRow) hi = mid - 1;
      else if (row > b.endRow) lo = mid + 1;
      else return b.index ?? null;
    }
    return null;
  }
  return blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function targetBlock(ir, term, opts, passIndex = null) {
  const address = term?.extra?.target;
  if (address == null) return null;
  const row = opts?.rowOfAddress?.(address);
  if (row == null) return null;
  return blockForRow(ir, row, passIndex);
}

function terminal(block) {
  const insts = block?.insts || [];
  for (let i = insts.length - 1; i >= 0; i--) {
    if (['cbr', 'br', 'ret'].includes(insts[i]?.op)) return insts[i];
  }
  return null;
}

function branchSuccessors(ir, block, term, opts, passIndex = null) {
  const successors = block?.succ || [];
  if (term?.op !== 'cbr' || successors.length < 2) return { yes: successors[0] ?? null, no: successors[1] ?? null, exact: term?.op !== 'cbr' };
  const yes = targetBlock(ir, term, opts, passIndex);
  if (yes == null || !successors.includes(yes)) return { yes: null, no: null, exact: false };
  return { yes, no: successors.find((x) => x !== yes) ?? null, exact: true };
}

function armIndex(ir, controller, successor, mergeBlock, predecessors) {
  return uniqueReachableMergePredecessorIndex(
    ir, controller.index, successor, mergeBlock, predecessors,
  );
}

function dominates(ir, candidate, node) {
  if (candidate == null || node == null) return false;
  const view = ir.dominators?.[node];
  if (view?.has) return view.has(candidate);
  let cur = node, guard = (ir.blocks?.length || 0) + 2;
  while (cur != null && cur >= 0 && guard-- > 0) {
    if (cur === candidate) return true;
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
  }
  return false;
}

function domDepth(ir, block, passIndex = null) {
  if (passIndex?.domDepthCache.has(block)) return passIndex.domDepthCache.get(block);
  let depth = 0, cur = block, guard = (ir.blocks?.length || 0) + 2;
  while (cur != null && cur >= 0 && guard-- > 0) { depth++; cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1; }
  if (passIndex) passIndex.domDepthCache.set(block, depth);
  return depth;
}

function controllerForMerge(ir, mergeBlock, predecessors, opts, passIndex = null) {
  const blockByIndex = passIndex?.blockByIndex;
  const getBlock = (idx) => blockByIndex ? blockByIndex.get(idx) : ir.blocks?.find((b) => b.index === idx);
  const hasIdom = (ir.idom?.[mergeBlock] != null) || (getBlock(mergeBlock)?.idom != null);
  const domView = ir.dominators?.[mergeBlock];
  if (hasIdom) {
    let cur = mergeBlock;
    let guard = (ir.blocks?.length || 0) + 2;
    const seen = new Set();
    while (cur != null && cur >= 0 && guard-- > 0 && !seen.has(cur)) {
      seen.add(cur);
      const block = getBlock(cur);
      if (block && (!domView?.has || domView.has(block.index))) {
        const term = terminal(block);
        if (term?.op === 'cbr' && (block.succ || []).length >= 2) {
          const arms = branchSuccessors(ir, block, term, opts, passIndex);
          if (arms.exact) {
            const yesIndex = armIndex(ir, block, arms.yes, mergeBlock, predecessors);
            const noIndex = armIndex(ir, block, arms.no, mergeBlock, predecessors);
            if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) {
              return { term, yesIndex, noIndex, depth: domDepth(ir, block.index, passIndex) };
            }
          }
        }
      }
      cur = ir.idom?.[cur] ?? block?.idom ?? -1;
    }
    return null;
  }
  const candidates = [];
  const iterBlocks = domView && typeof domView[Symbol.iterator] === 'function' && blockByIndex
    ? [...domView].map((idx) => blockByIndex.get(idx)).filter(Boolean)
    : (ir.blocks || []);
  for (const block of iterBlocks) {
    if (!dominates(ir, block.index, mergeBlock)) continue;
    const term = terminal(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const arms = branchSuccessors(ir, block, term, opts, passIndex);
    if (!arms.exact) continue;
    const yesIndex = armIndex(ir, block, arms.yes, mergeBlock, predecessors);
    const noIndex = armIndex(ir, block, arms.no, mergeBlock, predecessors);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    candidates.push({ term, yesIndex, noIndex, depth: domDepth(ir, block.index, passIndex) });
  }
  candidates.sort((a, b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function expressionMaps(result) {
  const values = new Map();
  for (const item of result.semanticAst?.values || []) values.set(item.valueId, item.expression);
  const conditions = new Map();
  for (const item of result.semanticAst?.conditions || []) {
    if (item.ir != null) conditions.set(item.ir, item.expression);
  }
  return { values, conditions };
}

function simplify(expression, engine) {
  if (!expression) return null;
  return engine.rewrite(expression).root;
}

function expressionOfValue(value, maps) {
  return value ? maps.values.get(value.id) || null : null;
}

/*
 * Flag-setting ARM64 arithmetic is lifted as a value-producing BIN followed by
 * a same-row CMP/NZCV operation. SSA rename may bind the CMP's first register
 * read to the BIN result (SUBS: (a-b) ? b) rather than the pre-write a. Repair
 * only when the Semantic IR itself proves a unique same-row companion BIN with
 * the same arithmetic sub-op. No ARM64 text is reparsed here.
 */
function sameRowFlagProducer(cmp, ir) {
  if (!cmp || cmp.row == null || !['sub', 'add', 'and'].includes(cmp.sub)) return null;
  const candidates = (ir?.instructions || []).filter((inst) =>
    inst !== cmp && inst.op === 'bin' && inst.row === cmp.row && inst.sub === cmp.sub &&
    (inst.args || []).length >= 2 && inst.dst);
  if (candidates.length !== 1) return null;
  const producer = candidates[0];
  const observed = valueOf(cmp.args?.[0]);
  if (observed?.reg && producer.dst?.reg && observed.reg !== producer.dst.reg) return null;
  return producer;
}

function repairedFlagComparison(flagsValue, cond, maps, ir) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  let leftValue = valueOf(cmp.args?.[0]);
  let rightValue = valueOf(cmp.args?.[1]);
  const shadow = leftValue?.def;
  let producer = null;
  if (shadow?.op === 'bin' && shadow.row === cmp.row && shadow.sub === cmp.sub) producer = shadow;
  if (!producer) producer = sameRowFlagProducer(cmp, ir);
  if (producer) {
    const originalLeft = valueOf(producer.args?.[0]);
    const originalRight = valueOf(producer.args?.[1]);
    if (originalLeft && originalRight) {
      leftValue = originalLeft;
      rightValue = originalRight;
    }
  }

  let left = expressionOfValue(leftValue, maps);
  let right = expressionOfValue(rightValue, maps);
  if (!left || !right) return null;
  const operandBits = [leftValue?.bits, rightValue?.bits]
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const exactOperandBits = operandBits.length === 2 && operandBits[0] === operandBits[1]
    ? operandBits[0]
    : 0;
  const producerBits = Number(cmp.bits || producer?.bits || producer?.dst?.bits || exactOperandBits || 0);
  const bits = producerBits > 0
    ? producerBits
    : Math.max(Number(left.bits || 0), Number(right.bits || 0), 1);
  const fitOperand = (node) => Number(node.bits || bits) > bits
    ? expr.unary('trunc', node, bits, node.signed ?? null, {
      address: cmp.address,
      row: cmp.row,
      ir: cmp.id,
      evidence: [{ reason: `exact ${bits}-bit NZCV producer width` }],
    }, { fromBits: Number(node.bits || bits) })
    : node;
  left = fitOperand(left);
  right = fitOperand(right);
  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: producer ? 'same-row flag producer operands' : 'NZCV comparison' }],
  });
}

function invertCondition(condition) {
  return invertBooleanCondition(condition);
}

function materializedFlagCondition(term, maps, ir) {
  const kind = term?.extra?.kind || term?.sub || '';
  if (!['tbz', 'tbnz', 'cbz', 'cbnz'].includes(kind)) return null;
  const tested = valueOf(term.args?.[0]);
  const select = tested?.def;
  if (select?.op !== 'sel' || !['set', 'setm'].includes(select.sub)) return null;
  if ((kind === 'tbz' || kind === 'tbnz') && select.sub === 'set' && Number(term.extra?.bit) !== 0) return null;

  const flagsValue = valueOf(select.args?.at?.(-1));
  const condition = repairedFlagComparison(flagsValue, select.cond, maps, ir);
  if (!condition) return null;

  // cset/csetm materialize true as a non-zero value and false as zero. Branches
  // on non-zero therefore preserve the condition; zero branches invert it.
  return kind === 'tbz' || kind === 'cbz' ? invertCondition(condition) : condition;
}

function directFlagCondition(term, maps, ir) {
  const cond = term?.cond || term?.extra?.cond;
  if (!cond) return null;
  return repairedFlagComparison(valueOf(term.args?.at?.(-1)), cond, maps, ir);
}

function resolveConditionStackLoads(condition, maps, engine, ir, opts, active, depth = 0, memo = null, passIndex = null, taintState = null) {
  const rewrite = (node, localDepth = depth) => {
    if (!node || localDepth > 64) return node;
    if (node.kind === 'load' && node.location?.kind === 'stack' && node.location?.key) {
      const slot = exactStackLoadSlot(ir, null, node);
      if (!slot) return node;
      const sub = resolveStackBeforeInner(ir, slot.load.block, slot.load.row, slot.key, slot.size,
        maps, opts, engine, active, localDepth + 1, memo, passIndex, slot.load?.loc || null);
      if (taintState) {
        if (sub.cycleTainted) taintState.cycleTainted = true;
        if (sub.aborted) taintState.aborted = true;
      }
      return sub.value || node;
    }
    return mapChildren(node, (child) => rewrite(child, localDepth + 1));
  };
  return rewrite(condition);
}

function controlCondition(term, maps, engine, ir, opts, active, depth, memo = null, passIndex = null, taintState = null) {
  const condition = materializedFlagCondition(term, maps, ir)
    || directFlagCondition(term, maps, ir)
    || maps.conditions.get(term.id);
  if (!condition) return null;
  return simplify(resolveConditionStackLoads(condition, maps, engine, ir, opts, active, depth, memo, passIndex, taintState), engine);
}

function positiveAccessSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactStackLoadSource(ir, value, expression) {
  if (expression?.kind !== 'load' || expression.location?.kind !== 'stack' || !expression.location?.key) return null;
  const direct = value?.def;
  if (direct?.op === 'load' && direct.loc?.kind === 'stack' && direct.loc.key === expression.location.key) return direct;

  // Compatibility may wrap the semantic load with presentation/state provenance.
  // Accept an indirect source only when that provenance identifies exactly one
  // real LOAD for this exact stack slot.
  const ids = new Set((expression.source?.ir || []).map(String));
  const candidates = (ir?.instructions || []).filter((inst) =>
    ids.has(String(inst.id)) && inst?.op === 'load' && inst.loc?.kind === 'stack'
      && inst.loc.key === expression.location.key);
  return candidates.length === 1 ? candidates[0] : null;
}

function exactStackLoadSlot(ir, value, expression) {
  const load = exactStackLoadSource(ir, value, expression);
  const size = positiveAccessSize(load?.loc?.size);
  return load && size != null ? { load, key:load.loc.key, size } : null;
}

function storeAccessSize(inst) {
  const size = positiveAccessSize(inst?.loc?.size ?? inst?.size);
  if (size != null) return size;
  const match = String(inst?.loc?.key || '').match(/:s(\d+)$/);
  return match ? positiveAccessSize(Number(match[1])) : null;
}

function exactStoreExpression(inst, key, size, maps, engine, ir, opts, active, depth, memo = null, passIndex = null, taintState = null) {
  if (inst?.op !== 'store' || inst.loc?.kind !== 'stack' || inst.loc?.key !== key
      || storeAccessSize(inst) !== size) return null;
  const value = valueOf(inst.args?.[0]);
  let expression = value ? maps.values.get(value.id) || null : null;
  if (!expression) return null;

  // Clang -O0 often copies an argument spill into the branch-local return slot.
  // Resolve that nested stack load at its own program point through the same
  // CFG/barrier proof before publishing the outer join. If the source cannot be
  // proven exactly, fail closed instead of emitting a select of unresolved loads.
  if (expression.kind === 'load' && expression.location?.kind === 'stack') {
    const sourceSlot = exactStackLoadSlot(ir, value, expression);
    if (!sourceSlot) return null;
    const sub = resolveStackBeforeInner(ir, sourceSlot.load.block, sourceSlot.load.row,
      sourceSlot.key, sourceSlot.size, maps, opts, engine, active, depth + 1, memo, passIndex, sourceSlot.load?.loc || null);
    if (taintState) {
      if (sub.cycleTainted) taintState.cycleTainted = true;
      if (sub.aborted) taintState.aborted = true;
    }
    expression = sub.value;
    if (!expression) return null;
    retainRecoverySource(maps, sourceSlot.load);
  }

  // A W-register store is an exact truncation boundary. Keep that width in the
  // recovered source value instead of leaking the 64-bit entry-register width
  // through an -O0 spill. This is essential for signed int32 comparisons such
  // as clamp(x,0) when x has bit 31 set.
  const storeBits = size * 8;
  if (storeBits > 0 && Number(expression.bits || storeBits) > storeBits) {
    expression = simplify(expr.unary('trunc', expression, storeBits, expression.signed, {
      address: inst.address,
      row: inst.row,
      ir: inst.id,
      evidence: [{ reason: `exact ${storeBits}-bit stack store width` }],
    }, { fromBits: expression.bits }), engine);
  }
  retainRecoverySource(maps, inst);
  return expression;
}

function instructionsBefore(ir, blockIndex, beforeRow, passIndex = null) {
  if (passIndex?.blockInstsDesc) {
    const list = passIndex.blockInstsDesc.get(blockIndex) || [];
    if (beforeRow == null) return list;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].row < beforeRow) out.push(list[i]);
    }
    return out;
  }
  return (ir.instructions || [])
    .filter((inst) => inst.block === blockIndex && (beforeRow == null || inst.row < beforeRow))
    .sort((a, b) => (b.row ?? -1) - (a.row ?? -1) || (b.id ?? -1) - (a.id ?? -1));
}

function isStackLocationLike(locOrKey) {
  if (!locOrKey) return false;
  if (typeof locOrKey === 'string') {
    return locOrKey.startsWith('stack:') || /^\[[^,\]]+,\s*#?-?\d+\]:s\d+$/.test(locOrKey);
  }
  if (locOrKey.kind === 'stack') return true;
  if (locOrKey.kind != null) return false;
  return typeof locOrKey.key === 'string' && isStackLocationLike(locOrKey.key);
}

function parseStackByteRange(locOrKey, fallbackSize = null) {
  if (!locOrKey) return null;
  const isObj = typeof locOrKey === 'object';
  const key = isObj ? String(locOrKey.key || '') : String(locOrKey);
  if (isObj && locOrKey.kind != null && locOrKey.kind !== 'stack') return null;

  let base = null;
  let scope = null;
  let offset = null;
  let size = null;
  let named = null;

  if (key) {
    let m = /^stack:([^:]+):c(-?\d+):s(\d+)$/.exec(key);
    if (m) {
      base = m[1]; scope = 'c'; offset = BigInt(m[2]); size = Number(m[3]);
    } else if ((m = /^stack:([^:]+):e(\d+):(-?\d+):s(\d+)$/.exec(key))) {
      base = m[1]; scope = `e${m[2]}`; offset = BigInt(m[3]); size = Number(m[4]);
    } else if ((m = /^stack:([^:+-]+)([+-]\d+):s(\d+)$/.exec(key))) {
      base = m[1]; scope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null; offset = BigInt(m[2]); size = Number(m[3]);
    } else if ((m = /^stack:([^:]+):(-?\d+):s(\d+)$/.exec(key))) {
      base = m[1]; scope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null; offset = BigInt(m[2]); size = Number(m[3]);
    } else if ((m = /^stack:(-?\d+):s(\d+)$/.exec(key))) {
      base = isObj && locOrKey.baseReg != null ? String(locOrKey.baseReg) : '$frame';
      scope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null;
      offset = BigInt(m[1]);
      size = Number(m[2]);
    } else if ((m = /^stack:(-?\d+)$/.exec(key))) {
      base = isObj && locOrKey.baseReg != null ? String(locOrKey.baseReg) : '$frame';
      scope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null;
      offset = BigInt(m[1]);
    } else if ((m = /^stack:([^:]+):s(\d+)$/.exec(key))) {
      named = m[1];
      size = Number(m[2]);
    } else if ((m = /^\[([^,\]]+),\s*#?(-?\d+)\]:s(\d+)$/.exec(key))) {
      base = m[1].trim(); scope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null; offset = BigInt(m[2]); size = Number(m[3]);
    }
  }

  const resolvedSize = Number.isSafeInteger(size) && size > 0
    ? size
    : (isObj && Number.isSafeInteger(Number(locOrKey.size)) && Number(locOrKey.size) > 0
      ? Number(locOrKey.size)
      : (Number.isSafeInteger(Number(fallbackSize)) && Number(fallbackSize) > 0 ? Number(fallbackSize) : null));

  if (named != null) {
    if (resolvedSize == null) return null;
    const namedBase = isObj && locOrKey.baseReg != null ? String(locOrKey.baseReg) : '$frame';
    const namedScope = isObj && locOrKey.frameEpoch != null ? `e${locOrKey.frameEpoch}` : null;
    return { kind: 'named', base: namedBase, scope: namedScope, name: named, size: resolvedSize };
  }

  if (isObj && (base == null || offset == null)) {
    if (locOrKey.baseReg != null && locOrKey.disp != null) {
      try {
        base = String(locOrKey.baseReg);
        offset = BigInt(locOrKey.disp);
        if (scope == null && locOrKey.frameEpoch != null) scope = `e${locOrKey.frameEpoch}`;
      } catch {
        return null;
      }
    }
  }

  if (base == null || offset == null || resolvedSize == null) return null;
  return { kind: 'range', base, scope, offset, size: resolvedSize };
}

function stackScopesCompatible(sa, sb) {
  return sa === sb;
}

function stackLocationsOverlap(a, b, aSize = null, bSize = null) {
  const keyA = typeof a === 'string' ? a : a?.key;
  const keyB = typeof b === 'string' ? b : b?.key;
  if (keyA && keyB && keyA === keyB) return true;
  const stackA = isStackLocationLike(a);
  const stackB = isStackLocationLike(b);
  if (!stackA || !stackB) return false;
  const ra = parseStackByteRange(a, aSize);
  const rb = parseStackByteRange(b, bSize);
  if (!ra || !rb) return true;
  if (ra.base !== rb.base || !stackScopesCompatible(ra.scope, rb.scope)) return true;
  if (ra.kind !== rb.kind) return true;
  if (ra.kind === 'named') return ra.name === rb.name;
  return ra.offset < rb.offset + BigInt(rb.size) && rb.offset < ra.offset + BigInt(ra.size);
}

function hasUnsafeBarrier(inst, key, size = null, targetLoc = null) {
  if (inst?.op === 'call' || inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  if (inst?.op !== 'store') return false;
  if (!inst.loc?.key || inst.loc?.kind === 'unknown') return true;
  if (inst.loc.key === key) return false;
  if (inst.loc?.kind === 'global') return false;
  if (!isStackLocationLike(inst.loc)) return true;
  return stackLocationsOverlap(inst.loc, targetLoc || key, storeAccessSize(inst), size);
}

function replayEngineRecords(engine, records, truncated) {
  if (!engine || !records) return;
  for (let i = 0; i < records.length; i++) {
    if (engine.records.length < engine.maximum) engine.records.push(records[i]);
    else engine.truncated = true;
  }
  if (truncated) engine.truncated = true;
}

function resolveStackBeforeInner(ir, blockIndex, beforeRow, key, size, maps, opts, engine, active, depth, memo, passIndex, targetLoc = null) {
  if (blockIndex == null || positiveAccessSize(size) == null || depth > 64) return { value: null, cycleTainted: false };
  if (depth > 0 && opts?.shouldAbort?.()) return { value: null, cycleTainted: true, aborted: true };
  const memoKey = beforeRow == null && memo ? `${blockIndex}:${key}:${size}:${targetLoc?.frameEpoch ?? ''}` : null;
  if (memoKey != null && memo.has(memoKey)) {
    const cached = memo.get(memoKey);
    if (cached.value) {
      if (cached.sources) {
        for (let i = 0; i < cached.sources.length; i++) retainRecoverySource(maps, cached.sources[i]);
      }
      if (cached.sourcesTruncated) maps.recoverySourcesTruncated = true;
      replayEngineRecords(engine, cached.records, cached.engineTruncated);
    }
    return { value: cached.value, cycleTainted: false };
  }
  const visitKey = `${blockIndex}:${beforeRow ?? 'end'}:${key}:${size}`;
  if (active.has(visitKey)) return { value: null, cycleTainted: true };
  active.add(visitKey);
  const mark = engine.mark();
  const sourceCount = maps.recoverySources.size, sourcesTruncated = maps.recoverySourcesTruncated;
  const prevCollector = maps._sourceCollector || null;
  const localCollector = memoKey != null ? new Set() : prevCollector;
  maps._sourceCollector = localCollector;
  let accepted = false;
  let acceptedValue = null;
  const taintState = { cycleTainted: false, aborted: false };
  const accept = value => { accepted = !!value; acceptedValue = value || null; return { value, cycleTainted: taintState.cycleTainted, aborted: taintState.aborted }; };
  try {
    for (const inst of instructionsBefore(ir, blockIndex, beforeRow, passIndex)) {
      if (inst?.op === 'store' && inst.loc?.key === key) {
        return accept(exactStoreExpression(inst, key, size, maps, engine, ir, opts, active, depth, memo, passIndex, taintState));
      }
      if (hasUnsafeBarrier(inst, key, size, targetLoc)) return { value: null, cycleTainted: false };
    }

    const block = passIndex?.blockByIndex.get(blockIndex) ?? ir.blocks?.[blockIndex];
    const predecessors = [...(block?.pred || [])];
    if (!predecessors.length) return { value: null, cycleTainted: false };
    const incoming = [];
    for (let i = 0; i < predecessors.length; i++) {
      const sub = resolveStackBeforeInner(ir, predecessors[i], null, key, size, maps, opts, engine, active, depth + 1, memo, passIndex, targetLoc);
      if (sub.cycleTainted) taintState.cycleTainted = true;
      if (sub.aborted) { taintState.aborted = true; return { value: null, cycleTainted: true, aborted: true }; }
      incoming.push(sub.value);
    }
    if (incoming.some((x) => !x)) return { value: null, cycleTainted: taintState.cycleTainted };
    const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
    if (unique.size === 1) return accept(incoming[0]);
    if (predecessors.length !== 2 || unique.size !== 2) return { value: null, cycleTainted: taintState.cycleTainted };

    const control = controllerForMerge(ir, blockIndex, predecessors, opts, passIndex);
    if (!control) return { value: null, cycleTainted: taintState.cycleTainted };
    const condition = controlCondition(control.term, maps, engine, ir, opts, active, depth + 1, memo, passIndex, taintState);
    if (taintState.aborted) return { value: null, cycleTainted: true, aborted: true };
    if (!condition) return { value: null, cycleTainted: taintState.cycleTainted };
    retainRecoverySource(maps, control.term);
    const bits = size * 8;
    const signed = condition.compareSigned ?? incoming[0]?.signed ?? incoming[1]?.signed ?? null;

    // `yesIndex` is the machine branch target (condition true), `noIndex` is the
    // fallthrough arm. armIndex() handles a direct-to-merge edge by selecting the
    // controller block's value, so the mapping is valid for both diamonds and
    // guard-style shapes such as Clang's O0 clamp.
    return accept(simplify(expr.select(condition, incoming[control.yesIndex], incoming[control.noIndex], bits, signed, {
      address: control.term.address,
      row: control.term.row,
      ir: control.term.id,
      evidence: [{ reason: 'exact stack Memory-SSA/CFG join' }],
    }), engine));
  } finally {
    maps._sourceCollector = prevCollector;
    active.delete(visitKey);
    if (!accepted) {
      engine.rollback(mark);
      let index = 0;
      for (const source of maps.recoverySources) if (index++ >= sourceCount) maps.recoverySources.delete(source);
      maps.recoverySourcesTruncated = sourcesTruncated;
    } else if (memoKey != null && prevCollector && localCollector) {
      for (const src of localCollector) {
        if (prevCollector.size < 512) prevCollector.add(src);
        else break;
      }
    }
    if (memoKey != null && !taintState.cycleTainted && !taintState.aborted) {
      if (accepted) {
        const records = engine.records.length > mark.length ? engine.records.slice(mark.length) : null;
        const engineTruncated = Boolean(engine.truncated && !mark.truncated);
        const addedSourcesTruncated = Boolean(maps.recoverySourcesTruncated && !sourcesTruncated);
        memo.set(memoKey, {
          value: acceptedValue,
          sources: localCollector && localCollector.size ? [...localCollector] : null,
          sourcesTruncated: addedSourcesTruncated,
          records,
          engineTruncated,
        });
      } else {
        memo.set(memoKey, { value: null, sources: null, sourcesTruncated: false, records: null, engineTruncated: false });
      }
    }
  }
}

function resolveStackBefore(ir, blockIndex, beforeRow, key, size, maps, opts, engine, active, depth = 0, memo = new Map(), passIndex = null, targetLoc = null) {
  return resolveStackBeforeInner(ir, blockIndex, beforeRow, key, size, maps, opts, engine, active, depth, memo, passIndex, targetLoc).value;
}

function isReturnNode(node) {
  return node?.semantic?.op === 'return' || /^return\b/.test(String(node?.text || '').trim());
}

function stackReturnSlot(ir, expression) {
  const slot = exactStackLoadSlot(ir, null, expression);
  if (slot) return slot;
  if (expression?.kind === 'load' && expression.location?.kind === 'stack' && expression.location?.key) {
    const size = positiveAccessSize(expression.location?.size)
      || (Number.isSafeInteger(expression.bits) && expression.bits > 0 && expression.bits % 8 === 0 ? expression.bits / 8 : null)
      || positiveAccessSize(Number(String(expression.location.key).match(/:s(\d+)$/)?.[1]));
    if (size != null) return { load: null, key: expression.location.key, size };
  }
  return null;
}

function returnSiteForNode(node, ir, allowSingleFallback = false) {
  const rets = (ir?.instructions || []).filter((inst) => inst.op === 'ret');
  if (!rets.length) return null;
  const source = node?.source || {};
  const rows = new Set((source.rows || []).map(Number));
  const irIds = new Set((source.ir || []).map(Number));
  const addresses = new Set((source.addresses || []).map((x) => String(x)));
  const matches = rets.filter((ret) => rows.has(Number(ret.row)) || irIds.has(Number(ret.id)) || addresses.has(String(ret.address)));
  if (matches.length === 1) return matches[0];
  if (!matches.length && allowSingleFallback && rets.length === 1) return rets[0];
  return null;
}

function recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback, passIndex = null) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  const nodeSlot = stackReturnSlot(result.ir, node?.semantic?.expression);
  const slot = nodeSlot || (allowSingleFallback ? stackReturnSlot(result.ir, output?.expression) : null);
  if (!slot) return null;
  const retInst = returnSiteForNode(node, result.ir, allowSingleFallback);
  if (!retInst) return null;
  retainRecoverySource(maps, slot.load);
  retainRecoverySource(maps, retInst);
  const targetLoc = slot.load?.loc || node?.semantic?.expression?.location || output?.expression?.location || null;
  return resolveStackBefore(result.ir, retInst.block, retInst.row, slot.key, slot.size,
    maps, opts, engine, new Set(), 0, new Map(), passIndex, targetLoc);
}

function rewriteReturnsInAst(result, maps, opts, engine) {
  const nodes = (result.cAst?.body || []).filter(isReturnNode);
  if (!nodes.length) return { changed:0, recovered:[] };
  const passIndex = createPassIndex(result.ir);
  const recovered = [];
  const allowSingleFallback = nodes.length === 1;
  for (const node of nodes) {
    maps.recoverySources = new Set();
    maps.recoverySourcesTruncated = false;
    const mark = engine.mark();
    const before = node.semantic?.expression
      || (allowSingleFallback ? result.semanticAst.outputs?.find(x => x.name === 'return')?.expression : null);
    const expression = recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback, passIndex);
    if (!expression || expression.kind === 'load') { engine.rollback(mark); continue; }
    const record = Object.freeze({ rule:'exact-stack-phi-recovery', phase:'memory-ssa',
      before:before ? structuralKey(before) : null, after:structuralKey(expression),
      evidence:Object.freeze({ kind:'cfg-memory-ssa', detail:'return site reconstructed from exact RET provenance without crossing unknown memory effects' }),
      originHistory:recoveryOriginHistory(before, expression, maps),
    });
    node.text = `return ${printExpression(expression)};`;
    if (node.semantic) node.semantic.expression = expression;
    recovered.push({ node, expression, records:Object.freeze([...engine.recordsSince(mark), record]) });
  }
  if (recovered.length === 1 && nodes.length === 1) {
    const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
    if (output) output.expression = recovered[0].expression;
  }
  return { changed:recovered.length, recovered };
}

export function recoverExactStackPhiExpressions(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const maps = expressionMaps(result);
  const engine = new RewriteHistoryJournal(new RewriteEngine(DEFAULT_RULES, {
    maxIterations: 10,
    nodeBudget: Math.min(2048, Number(opts.decompilerNodeBudget || 12000)),
    timeBudgetMs: Number.isFinite(opts.transformDeadline) ? Math.max(0, opts.transformDeadline - (typeof opts.transformClock === 'function' ? opts.transformClock() : globalThis.performance?.now ? globalThis.performance.now() : Date.now())) : opts.decompilerTimeBudgetMs != null ? Math.min(10, Math.max(3, Number(opts.decompilerTimeBudgetMs) / 5)) : Number(opts.transformSafetyCeilingMs ?? 10),
    deadline: opts.transformDeadline,
    deadlineReason: opts.transformDeadlineReason,
    deterministic: opts.deterministicTransforms === true,
    clock: opts.transformClock,
    shouldAbort: opts.shouldAbort,
    onBudgetExceeded(reason) { const mapped = reason === 'work-budget' ? 'transform-work-budget' : reason === 'transform-safety-ceiling' || reason === 'transform-time-budget' || reason === 'deadline' ? opts.transformDeadlineReason || 'transform-time-budget' : null; if (mapped) { result.degraded = true; result.degradationReasons = [...new Set([...(result.degradationReasons || []), mapped])]; result.warnings = [...new Set([...(result.warnings || []), mapped === 'transform-work-budget' ? 'Decompiler rewrite budget reached; output was conservatively degraded.' : 'Decompiler pass budget exhausted before optional transforms; the result was conservatively degraded.'])]; } },
    maxApplications: 512,
  }), opts.renderProvenanceBudget?.maxTransformRecords);
  const rewrite = rewriteReturnsInAst(result, maps, opts, engine);
  if (!rewrite.changed) return result;

  const printed = printProgram(result.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
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
  result.rewriteProof = [...(result.rewriteProof || []), ...rewrite.recovered.flatMap(item => item.records)];
  if (engine.truncated) result.expressionHistoryBinding = Object.freeze({
    ...result.expressionHistoryBinding, completeness:'incomplete',
    reasons:Object.freeze([...new Set([...(result.expressionHistoryBinding?.reasons || []), 'recovery-rewrite-history-budget'])]),
  });
  bindRecoveries(result, rewrite.recovered, opts);
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
