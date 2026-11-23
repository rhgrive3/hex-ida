import { expr, structuralKey, mergeSource } from '../ast/nodes.js';
import { RewriteEngine, RewriteHistoryJournal, expressionOriginHistory } from '../rewrite/engine.js';
import { captureRecoveryIrData, PROJECTION_LIMITS } from '../phase8/projection-origin.js';
import { readStackPhiHistoryConsumer } from './stack-phi-recovery.js';
import { readLegacyStackHistoryConsumer } from './legacy-stack-recovery.js';
import { readExpressionHistoryConsumer } from '../pipeline-core.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression, invertBooleanCondition } from '../flag-semantics.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../../semantics/memoryssa/queries.js';
import { uniqueReachableMergePredecessorIndex } from './stack-join-arm-proof.js';

const EXACT_VIEW_MOV_SUBS = new Set([null, 'copy', 'bitcast', 'trunc', 'zext']);

const returnHistoryConsumers = new WeakMap();
export function readStackReturnHistoryConsumer(semantic, ir) {
  const binding = returnHistoryConsumers.get(semantic);
  if (!binding || binding.ir !== ir) return null;
  const data = key => Object.getOwnPropertyDescriptor(semantic, key)?.value;
  return data('expression') === binding.expression && data('op') === binding.op
    && data('ir') === binding.instructionId && data('location') === binding.location
    && binding.isCurrent() ? binding : null;
}

function bindReturnHistory(result, transitions, opts) {
  const cap = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : max;
  const budget = opts.renderProvenanceBindingBudget;
  const reasons = new Set(result.expressionHistoryBinding?.reasons || []);
  const ir = result.ir;
  try {
    const observation = captureRecoveryIrData(ir, [
      transitions.map(item => [item.before, item.node.semantic?.expression, item.records])], opts.shouldAbort);
    if (observation.metrics.edges > cap(budget?.maxEdges, PROJECTION_LIMITS.edges)) reasons.add('recovery-binding-budget');
    else {
      let remaining = cap(budget?.maxConsumers, 4096);
      for (const item of transitions) {
        const semantic = item.node.semantic;
        if (!semantic || (item.prior && !item.prior.isCurrent())) { reasons.add('recovery-consumer-unavailable'); continue; }
        if (remaining-- <= 0) { reasons.add('recovery-binding-budget'); continue; }
        const upstreamChecks = item.prior?.upstreamChecks || Object.freeze(item.prior ? [item.prior.isCurrent] : []);
        returnHistoryConsumers.set(semantic, Object.freeze({ ir,
          expression:semantic.expression, op:semantic.op, instructionId:semantic.ir,
          location:semantic.location, records:item.records,
          // Re-observe current IR once while retaining the original producer's
          // displaced before-images. Repeated return recovery reuses this fixed
          // check list rather than nesting all earlier return closures.
          upstreamChecks,
          isCurrent:() => observation.matches() && upstreamChecks.every(check => check()),
        }));
      }
    }
  } catch { reasons.add('recovery-binding-observation-unavailable'); }
  if (reasons.size) result.expressionHistoryBinding = Object.freeze({
    completeness:'incomplete', reasons:Object.freeze([...reasons].sort()),
  });
}

function valueOf(a) { return a?.value || null; }

function mapsOf(result) {
  return new Map((result.semanticAst?.values || []).map((v) => [v.valueId, v.expression]));
}

function fitWidth(node, bits, source = null) {
  bits = Number(bits || 0);
  if (!node || !bits || Number(node.bits || bits) <= bits) return node;
  return expr.unary('trunc', node, bits, node.signed ?? null, source || node.source, { fromBits:Number(node.bits || bits) });
}

function expressionOf(value, values) {
  const node = value ? values.get(value.id) || null : null;
  return node ? fitWidth(node, value?.bits, {
    row:value?.def?.row ?? null,
    address:value?.def?.address ?? null,
    ir:value?.def?.id ?? null,
    ssaUse:value?.id ?? null,
    evidence:[{ reason:'SSA value-width boundary' }],
  }) : null;
}

function simplify(node, engine) {
  return node ? engine.rewrite(node).root : null;
}

function invert(node) {
  return invertBooleanCondition(node);
}

function sameRowArithmetic(ir, cmp) {
  const row = ir.byRow?.get?.(cmp.row) || (ir.instructions || []).filter((i) => i.row === cmp.row);
  let best = null;
  for (const inst of row) {
    if (inst.id >= cmp.id) continue;
    if (inst.op !== 'bin' || inst.sub !== cmp.sub) continue;
    if (!best || inst.id > best.id) best = inst;
  }
  return best;
}

function compareFromFlags(ir, flagsValue, cond, values) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  // Flag-setting arithmetic is lifted as BIN then CMP on the same ARM64 row.
  // SSA renaming can make CMP read the just-written destination. The preceding
  // same-row BIN is an exact proof of the original flag-producing operands.
  const arithmetic = sameRowArithmetic(ir, cmp);
  const leftValue = valueOf(arithmetic?.args?.[0] || cmp.args?.[0]);
  const rightValue = valueOf(arithmetic?.args?.[1] || cmp.args?.[1]);
  const left = expressionOf(leftValue, values);
  const right = expressionOf(rightValue, values);
  if (!left || !right) return null;
  const bits = Number(cmp.bits || leftValue?.bits || rightValue?.bits || left.bits || right.bits || 64);

  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: arithmetic ? 'same-row flag-producing arithmetic operands' : 'NZCV compare operands' }],
  });
}

function branchCondition(ir, term, values) {
  const kind = term?.extra?.kind || term?.sub || '';
  const tested = valueOf(term?.args?.[0]);

  if (kind === 'cbz' || kind === 'cbnz') {
    const x = expressionOf(tested, values);
    return x ? expr.compare(kind === 'cbz' ? 'eq' : 'ne', x, expr.constant(0, x.bits || 64), null, term.source) : null;
  }

  if (kind === 'tbz' || kind === 'tbnz') {
    const select = tested?.def;
    if (select?.op === 'sel' && (select.sub === 'setm' || (select.sub === 'set' && Number(term.extra?.bit) === 0))) {
      const flags = valueOf(select.args?.[select.args.length - 1]);
      const materialized = compareFromFlags(ir, flags, select.cond, values);
      if (materialized) return kind === 'tbz' ? invert(materialized) : materialized;
    }

    const x = expressionOf(tested, values);
    if (!x) return null;
    const bit = Number(term.extra?.bit ?? 0);
    const bits = Number(tested?.bits || x.bits || 64);
    if (bit === bits - 1) {
      return expr.compare(kind === 'tbz' ? 'ge' : 'lt', x, expr.constant(0, bits, true), true, term.source);
    }
    const shifted = expr.binary('lshr', x, expr.constant(bit, bits, false), bits, false, term.source);
    const masked = expr.binary('and', shifted, expr.constant(1, bits, false), bits, false, term.source);
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', masked, expr.constant(0, bits, false), false, term.source);
  }

  if (kind === 'cond' || term?.cond) {
    const flags = valueOf(term.args?.[term.args.length - 1]);
    return compareFromFlags(ir, flags, term.cond || term.extra?.cond, values);
  }
  return null;
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
      blockInstsDesc.set(block.index, [...insts].sort((a, b) => (b.row ?? -1) - (a.row ?? -1)));
    }
  } else {
    for (const inst of ir?.instructions || []) {
      if (inst?.block == null) continue;
      let list = blockInstsDesc.get(inst.block);
      if (!list) { list = []; blockInstsDesc.set(inst.block, list); }
      list.push(inst);
    }
    for (const list of blockInstsDesc.values()) {
      list.sort((a, b) => (b.row ?? -1) - (a.row ?? -1));
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
  const row = opts.rowOfAddress?.(address);
  if (row == null) return null;
  return blockForRow(ir, row, passIndex);
}

function terminal(block) {
  const xs = block?.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if (['cbr','br','ret'].includes(xs[i]?.op)) return xs[i];
  return null;
}

function branchArms(ir, block, term, opts, passIndex = null) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null, exact:term?.op !== 'cbr' };
  const yes = targetBlock(ir, term, opts, passIndex);
  return yes != null && succ.includes(yes)
    ? { yes, no:succ.find((x) => x !== yes) ?? null, exact:true }
    : { yes:null, no:null, exact:false };
}

function armPredecessorIndex(ir, controller, successor, merge, predecessors) {
  return uniqueReachableMergePredecessorIndex(
    ir, controller.index, successor, merge, predecessors,
  );
}

function dominates(ir, candidate, node) {
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

function controller(ir, merge, predecessors, opts, passIndex = null) {
  const blockByIndex = passIndex?.blockByIndex;
  const getBlock = (idx) => blockByIndex ? blockByIndex.get(idx) : ir.blocks?.find((b) => b.index === idx);
  const hasIdom = (ir.idom?.[merge] != null) || (getBlock(merge)?.idom != null);
  const domView = ir.dominators?.[merge];
  if (hasIdom) {
    let cur = merge;
    let guard = (ir.blocks?.length || 0) + 2;
    const seen = new Set();
    while (cur != null && cur >= 0 && guard-- > 0 && !seen.has(cur)) {
      seen.add(cur);
      const block = getBlock(cur);
      if (block && (!domView?.has || domView.has(block.index))) {
        const term = terminal(block);
        if (term?.op === 'cbr' && (block.succ || []).length >= 2) {
          const arms = branchArms(ir, block, term, opts, passIndex);
          if (arms.exact) {
            const yesIndex = armPredecessorIndex(ir, block, arms.yes, merge, predecessors);
            const noIndex = armPredecessorIndex(ir, block, arms.no, merge, predecessors);
            if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) {
              return { term, yesIndex, noIndex, depth:domDepth(ir, block.index, passIndex) };
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
    if (!dominates(ir, block.index, merge)) continue;
    const term = terminal(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const arms = branchArms(ir, block, term, opts, passIndex);
    if (!arms.exact) continue;
    const yesIndex = armPredecessorIndex(ir, block, arms.yes, merge, predecessors);
    const noIndex = armPredecessorIndex(ir, block, arms.no, merge, predecessors);
    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, depth:domDepth(ir, block.index, passIndex) });
  }
  candidates.sort((a,b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function storeValue(inst, key, values, expectedBytes = null) {
  if (inst?.op !== 'store' || inst.loc?.kind !== 'stack' || inst.loc?.key !== key) return null;
  const bytes = Number(inst.size || inst.loc?.size || inst.addr?.size || 0);
  if (expectedBytes != null && expectedBytes > 0 && bytes > 0 && bytes !== expectedBytes) return null;
  let node = expressionOf(valueOf(inst.args?.[0]), values);
  if (!node) return null;
  const bits = bytes > 0 ? bytes * 8 : 0;
  if (bits) node = fitWidth(node, bits, {
    address:inst.address,
    row:inst.row,
    ir:inst.id,
    evidence:[{ reason:`exact ${bits}-bit stack-store boundary` }],
  });
  return node;
}

function reachingRegisterDefinition(ir, atInst, reg) {
  let best = null, bestDepth = -1, bestRow = -Infinity;
  for (const value of ir?.values || []) {
    if (value?.reg !== reg || !value.def || value.clobbered) continue;
    const def = value.def;
    if (def.block === atInst.block) {
      if (def.row == null || atInst.row == null || def.row >= atInst.row) continue;
      if (def.row > bestRow) { best = value; bestRow = def.row; bestDepth = Number.MAX_SAFE_INTEGER; }
      continue;
    }
    if (!dominates(ir, def.block, atInst.block)) continue;
    const depth = domDepth(ir, def.block);
    if (bestDepth !== Number.MAX_SAFE_INTEGER && (depth > bestDepth || (depth === bestDepth && (def.row ?? -Infinity) > bestRow))) {
      best = value; bestDepth = depth; bestRow = def.row ?? -Infinity;
    }
  }
  return best;
}

function exactViewTrace(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  let current = value;
  const steps = [];
  while (current?.def?.op === 'mov' && current.def.args?.length === 1) {
    const def = current.def;
    const sub = def.sub ?? null;
    const exactIdentity = sub == null || sub === 'copy' || sub === 'bitcast'
      || def.extra?.stateRead || def.extra?.stateWrite;
    if (!exactIdentity && !EXACT_VIEW_MOV_SUBS.has(sub)) break;
    const source = valueOf(def.args[0]);
    if (!source || active.has(source.id)) break;
    if (sub === 'trunc' || sub === 'zext') {
      steps.push(`${sub}:${Number(source.bits || 0)}>${Number(current.bits || 0)}`);
    }
    active.add(source.id);
    current = source;
  }
  return { root: current, bits:Number(value.bits || 0), steps };
}

function storedViewProjectsValue(stored, expected, store) {
  if (!stored || !expected || !store) return false;
  if (stored === expected || stored.id === expected.id) return true;
  const a = exactViewTrace(stored), b = exactViewTrace(expected);
  if (!a?.root || !b?.root || a.root.id !== b.root.id) return false;
  const widthBits = Number((store.loc?.size ?? store.addr?.size ?? store.extra?.size ?? 0) * 8);
  if (widthBits > 0 && Number(stored.bits || 0) !== widthBits) return false;
  if (a.steps.length < b.steps.length) return false;
  const suffix = a.steps.slice(a.steps.length - b.steps.length);
  return suffix.every((step, index) => step === b.steps[index]);
}

function committedStoreBarrier(inst, key) {
  if (inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  if (inst?.op === 'call') return (inst.memKills || []).some((loc) => loc?.key === key);
  if (inst?.op !== 'store') return false;
  return !inst.loc?.key || inst.loc?.kind === 'unknown' || inst.loc.key === key;
}

function storeOfExactValue(ir, blockIndex, value) {
  let current = blockIndex;
  const seen = new Set();
  const later = [];
  let guard = Math.min(64, (ir?.blocks?.length || 0) + 2);
  while (current != null && current >= 0 && guard-- > 0 && !seen.has(current)) {
    seen.add(current);
    const instructions = [...(ir?.blocks?.[current]?.insts || [])]
      .sort((a,b) => (b.row ?? -1) - (a.row ?? -1) || (b.id ?? -1) - (a.id ?? -1));
    for (const inst of instructions) {
      if (inst?.op === 'store' && inst.loc?.kind !== 'stack' && inst.loc?.kind !== 'unknown'
          && inst.loc?.key && storedViewProjectsValue(valueOf(inst.args?.[0]), value, inst)) {
        if (!dominates(ir, current, blockIndex)) return null;
        if (later.some((candidate) => committedStoreBarrier(candidate, inst.loc.key))) return null;
        return inst;
      }
      later.push(inst);
    }
    const predecessors = [...(ir?.blocks?.[current]?.pred || [])];
    if (predecessors.length !== 1) return null;
    current = predecessors[0];
  }
  return null;
}

function semanticLocationForStore(result, store) {
  return (result.semanticAst?.stores || []).find((item) =>
    (item.source?.ir || []).some((id) => Number(id) === Number(store?.id)))?.location || null;
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

function semanticLocationForProvenSnapshot(result, definition) {
  const projected = (result.semanticAst?.values || []).find((item) =>
    String(item?.valueId ?? '') === String(definition?.dst?.id ?? ''))?.expression ?? null;
  if (projected?.kind === 'load'
      && projected.location?.kind !== 'stack' && projected.location?.kind !== 'unknown') return projected.location;

  const key = definition?.extra?.committedLocationKey ?? definition?.loc?.key;
  if (!key) return null;
  const rows = new Set((definition.extra?.committedStoreRows || [])
    .map(Number).filter(Number.isFinite));
  const locations = (result.ir?.instructions || [])
    .filter((store) => store?.op === 'store'
      && store.loc?.kind !== 'stack' && store.loc?.kind !== 'unknown'
      && store.loc?.key === key
      && (rows.size === 0 || rows.has(Number(store.row))))
    .map((store) => semanticLocationForStore(result, store));
  if (!locations.length || locations.some((location) => !location)) return null;
  const identity = locationIdentity(locations[0]);
  if (!identity || locations.some((location) => locationIdentity(location) !== identity)) return null;
  return locations[0];
}

function committedLocationForPhi(result, value) {
  const definition = value?.def;
  if (definition?.op === 'load'
      && (definition.extra?.committedPhiSnapshot === true || definition.extra?.committedSnapshotView === true)
      && definition.loc?.kind !== 'stack' && definition.loc?.kind !== 'unknown') {
    const location = semanticLocationForProvenSnapshot(result, definition);
    if (location) return location;
  }

  const phi = definition;
  if (phi?.op !== 'phi' || !(phi.incoming || []).length) return null;
  const locations = [];
  for (const incoming of phi.incoming || []) {
    const store = storeOfExactValue(result.ir, incoming.from, incoming.value);
    if (!store) return null;
    const location = semanticLocationForStore(result, store);
    if (!location) return null;
    locations.push(location);
  }
  const identity = locationIdentity(locations[0]);
  if (!identity || locations.some((loc) => locationIdentity(loc) !== identity)) return null;
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
        && locations[0]?.kind === 'register' && locations[0]?.aggregate !== true
        ? String(locations[0].reg || '') || null : null;
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

function committedReturnValue(result, root, ret, opts = {}) {
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return null;
  const returnRegister = canonicalReturnRegister(result, root, opts);
  if (!returnRegister) return null;
  const reaching = reachingRegisterDefinition(result.ir, ret, returnRegister);
  const load = reaching?.def;
  if (load?.op !== 'load' || load.loc?.key !== root.location.key) return null;
  if (!isCanonicalExactMemoryForwarding(load.memoryForwarding,
    canonicalMemoryForwardingContextForLoad(load.memoryForwarding, load,
      load.memoryForwardingContext ?? load.extra?.memoryForwardingContext))) return null;
  const definitionIds = new Set(load.memoryForwarding.contributingDefinitionIds.map(String));
  const stackStores = (result.ir.instructions || []).filter((candidate) => {
    const definitionId = candidate?.memDef?.definitionId ?? candidate?.extra?.memoryDefinitionId ?? null;
    return candidate?.op === 'store'
      && candidate?.loc?.kind === 'stack'
      && candidate.loc.key === root.location.key
      && definitionId != null
      && definitionIds.has(String(definitionId));
  });
  if (stackStores.length !== 1) return null;
  const stackStore = stackStores[0];
  const spilled = valueOf(stackStore?.args?.[0]);
  const location = committedLocationForPhi(result, spilled);
  if (!location) return null;
  return expr.load(location, root.bits || 64, root.source, {
    signed: root.signed ?? null,
    proof: 'all SSA phi predecessors committed the exact spilled value to one lvalue',
  });
}

function unsafeBarrier(inst, key) {
  if (inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  if (inst?.op === 'call') {
    // buildMemorySSA has already proven which locations this call can kill.
    // A private caller stack slot is absent from memKills and is safe to carry
    // through the call; an escaped stack address is present and remains a barrier.
    return (inst.memKills || []).some((loc) => loc?.key === key);
  }
  return inst?.op === 'store' && inst.loc?.key !== key && (!inst.loc?.key || inst.loc?.kind === 'unknown');
}

function before(ir, block, row, passIndex = null) {
  if (passIndex?.blockInstsDesc) {
    const list = passIndex.blockInstsDesc.get(block) || [];
    if (row == null) return list;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].row < row) out.push(list[i]);
    }
    return out;
  }
  return (ir.instructions || [])
    .filter((i) => i.block === block && (row == null || i.row < row))
    .sort((a,b) => (b.row ?? -1) - (a.row ?? -1));
}

function replayEngineRecords(engine, records, truncated) {
  if (!engine || !records) return;
  for (let i = 0; i < records.length; i++) {
    if (engine.records.length < engine.maximum) engine.records.push(records[i]);
    else engine.truncated = true;
  }
  if (truncated) engine.truncated = true;
}

function resolveInner(ir, blockIndex, beforeRow, key, values, opts, engine, active, depth, expectedBytes, memo, passIndex) {
  if (blockIndex == null || depth > 64) return { value:null, cycleTainted:false };
  if (depth > 0 && opts?.shouldAbort?.()) return { value:null, cycleTainted:true, aborted:true };
  const memoKey = beforeRow == null && memo ? `${blockIndex}:${key}:${expectedBytes ?? ''}` : null;
  if (memoKey != null && memo.has(memoKey)) {
    const cached = memo.get(memoKey);
    replayEngineRecords(engine, cached.records, cached.engineTruncated);
    return { value:cached.value, cycleTainted:false };
  }
  const token = `${blockIndex}:${beforeRow ?? 'end'}:${key}`;
  if (active.has(token)) return { value:null, cycleTainted:true };
  active.add(token);
  const mark = memoKey != null ? engine.mark() : null;
  let cycleTainted = false;
  let aborted = false;
  let resultValue = null;
  try {
    for (const inst of before(ir, blockIndex, beforeRow, passIndex)) {
      if (inst?.op === 'store' && inst.loc?.kind === 'stack' && inst.loc?.key === key) {
        const stored = storeValue(inst, key, values, expectedBytes);
        resultValue = stored || null;
        return { value:resultValue, cycleTainted:false };
      }
      if (unsafeBarrier(inst, key)) return { value:null, cycleTainted:false };
    }

    const block = passIndex?.blockByIndex.get(blockIndex) ?? ir.blocks?.[blockIndex];
    const predecessors = [...(block?.pred || [])];
    if (!predecessors.length) return { value:null, cycleTainted:false };
    const incoming = [];
    for (let i = 0; i < predecessors.length; i++) {
      const sub = resolveInner(ir, predecessors[i], null, key, values, opts, engine, active, depth + 1, expectedBytes, memo, passIndex);
      if (sub.cycleTainted) cycleTainted = true;
      if (sub.aborted) { aborted = true; return { value:null, cycleTainted:true, aborted:true }; }
      incoming.push(sub.value);
    }
    if (incoming.some((x) => !x)) return { value:null, cycleTainted };
    const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
    if (unique.size === 1) {
      resultValue = incoming[0];
      return { value:resultValue, cycleTainted };
    }
    if (predecessors.length !== 2 || unique.size !== 2) return { value:null, cycleTainted };

    const control = controller(ir, blockIndex, predecessors, opts, passIndex);
    if (!control) return { value:null, cycleTainted };
    const condition = simplify(branchCondition(ir, control.term, values), engine);
    if (!condition) return { value:null, cycleTainted };
    const bits = incoming[0]?.bits || incoming[1]?.bits || 64;
    const signed = condition.compareSigned ?? incoming[0]?.signed ?? incoming[1]?.signed ?? null;
    resultValue = simplify(expr.select(condition, incoming[control.yesIndex], incoming[control.noIndex], bits, signed, {
      address:control.term.address,
      row:control.term.row,
      ir:control.term.id,
      evidence:[{ reason:'exact stack CFG join' }],
    }), engine);
    return { value:resultValue, cycleTainted };
  } finally {
    active.delete(token);
    if (memoKey != null && !cycleTainted && !aborted) {
      const records = engine.records.length > mark.length ? engine.records.slice(mark.length) : null;
      const engineTruncated = Boolean(engine.truncated && !mark.truncated);
      memo.set(memoKey, { value:resultValue, records, engineTruncated });
    }
  }
}

function resolve(ir, blockIndex, beforeRow, key, values, opts, engine, active, depth = 0, expectedBytes = null, memo = new Map(), passIndex = null) {
  return resolveInner(ir, blockIndex, beforeRow, key, values, opts, engine, active, depth, expectedBytes, memo, passIndex).value;
}

function matchesTargetReturnNode(node, ret, singleRet) {
  if (!(node?.semantic?.op === 'return' || /^return\b/.test(String(node?.text || '').trim()))) return false;
  if (!ret || singleRet) return true;
  if (node.semantic?.ir != null && ret.id != null) {
    return String(node.semantic.ir) === String(ret.id);
  }
  if (node.row != null && ret.row != null) {
    return Number(node.row) === Number(ret.row);
  }
  if (ret.id != null && Array.isArray(node.source?.ir) && node.source.ir.some((id) => String(id) === String(ret.id))) {
    return true;
  }
  if (ret.row != null && Array.isArray(node.source?.rows) && node.source.rows.some((r) => Number(r) === Number(ret.row))) {
    return true;
  }
  return false;
}

function rewriteReturn(result, expression, opts, ret = null, singleRet = true) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  if (!output) return false;
  let changed = false;
  for (const node of result.cAst?.body || []) {
    if (matchesTargetReturnNode(node, ret, singleRet)) {
      node.text = `return ${printExpression(expression)};`;
      // Retain the predecessor descriptor observed by the incoming consumer.
      // The owning recovery below binds this new descriptor to that preimage;
      // mutating the old descriptor would revoke the history being carried.
      if (node.semantic) node.semantic = { ...node.semantic, expression };
      changed = true;
    }
  }
  if (!changed) return false;
  output.expression = expression;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  return true;
}

function committedStackSpillOnExactReturnPath(result, root, ret, passIndex = null) {
  for (const inst of before(result.ir, ret.block, ret.row, passIndex)) {
    if (inst?.op === 'store' && inst.loc?.kind === 'stack' && inst.loc.key === root.location.key) {
      const location = committedLocationForPhi(result, valueOf(inst.args?.[0]));
      return location ? { stackStore:inst, location } : null;
    }
    if (unsafeBarrier(inst, root.location.key)) return null;
  }
  return null;
}

function removeProofOnlyStackSpill(result, stackStore, expression, opts) {
  const body = result.cAst?.body;
  if (!Array.isArray(body) || !stackStore) return [];
  const removed = [];
  const storeRow = Number(stackStore.row);
  const storeId = String(stackStore.id);
  const filtered = body.filter((node, lineIndex) => {
    const text = String(node?.text || '');
    if (!/^\s*local_[A-Za-z0-9_]+\s*=/.test(text)) return true;
    const rows = node?.source?.rows || [];
    const ir = node?.source?.ir || [];
    const isSpill = rows.some((row) => Number(row) === storeRow) || ir.some((id) => String(id) === storeId);
    if (isSpill) {
      const maximum = Number.isSafeInteger(opts.renderProvenanceBudget?.maxTransformRecords)
        ? Math.max(0, Math.min(1024, opts.renderProvenanceBudget.maxTransformRecords)) : 1024;
      if (removed.length < maximum) removed.push(Object.freeze({
        rule:'remove-proof-only-stack-spill', phase:'render',
        evidence:Object.freeze({ kind:'committed-return-spill', detail:'existing return recovery removed this proof-only C statement' }),
        originHistory:expressionOriginHistory({ source:mergeSource(node.source,
          { ir:stackStore.id, row:stackStore.row, address:stackStore.address }) }, expression),
        renderedRemoval:Object.freeze({ scope:'pre-transform-render', operation:'remove', lineIndex, kind:node.kind || 'null' }),
      }));
      else result.expressionHistoryBinding = Object.freeze({ ...result.expressionHistoryBinding, completeness:'incomplete',
        reasons:Object.freeze([...new Set([...(result.expressionHistoryBinding?.reasons || []), 'render-removal-history-budget'])]) });
    }
    return !isSpill;
  });
  if (filtered.length === body.length) return [];
  result.cAst.body = filtered;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  return removed;
}

export function recoverExactStackReturn(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  const root = output?.expression;
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return result;
  const retInstructions = (result.ir.instructions || []).filter((i) => i.op === 'ret');
  const ret = retInstructions[retInstructions.length - 1] || null;
  if (!ret) return result;
  const singleRet = retInstructions.length <= 1;

  const values = mapsOf(result);
  const engine = new RewriteHistoryJournal(new RewriteEngine(DEFAULT_RULES, {
    maxIterations:10,
    nodeBudget:Math.min(2048, Number(opts.decompilerNodeBudget || 12000)),
    timeBudgetMs:Number.isFinite(opts.transformDeadline) ? Math.max(0, opts.transformDeadline - (typeof opts.transformClock === 'function' ? opts.transformClock() : globalThis.performance?.now ? globalThis.performance.now() : Date.now())) : opts.decompilerTimeBudgetMs != null ? Math.min(12, Math.max(4, Number(opts.decompilerTimeBudgetMs) / 4)) : Number(opts.transformSafetyCeilingMs ?? 12),
    deadline:opts.transformDeadline,
    deadlineReason:opts.transformDeadlineReason,
    deterministic:opts.deterministicTransforms === true,
    clock:opts.transformClock,
    shouldAbort:opts.shouldAbort,
    onBudgetExceeded(reason) { const mapped = reason === 'work-budget' ? 'transform-work-budget' : reason === 'transform-safety-ceiling' || reason === 'transform-time-budget' || reason === 'deadline' ? opts.transformDeadlineReason || 'transform-time-budget' : null; if (mapped) { result.degraded = true; result.degradationReasons = [...new Set([...(result.degradationReasons || []), mapped])]; result.warnings = [...new Set([...(result.warnings || []), mapped === 'transform-work-budget' ? 'Decompiler rewrite budget reached; output was conservatively degraded.' : 'Decompiler pass budget exhausted before optional transforms; the result was conservatively degraded.'])]; } },
    maxApplications:512,
  }), opts.renderProvenanceBudget?.maxTransformRecords);
  const passIndex = createPassIndex(result.ir);
  let committed = committedReturnValue(result, root, ret, opts);
  let committedSpill = null;
  if (!committed) {
    const proof = committedStackSpillOnExactReturnPath(result, root, ret, passIndex);
    if (proof) {
      committedSpill = proof.stackStore;
      committed = expr.load(proof.location, root.bits || 64, root.source, {
        signed:root.signed ?? null,
        proof:'exact return-path spill carries an SSA phi whose predecessors commit one lvalue',
      });
    }
  }
  const expectedBytes = Number(root.location?.size || (Number(root.bits) > 0 ? Number(root.bits) / 8 : 0)) || null;
  const recovered = committed || resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set(), 0, expectedBytes, new Map(), passIndex);
  const transitions = (result.cAst.body || [])
    .filter(node => matchesTargetReturnNode(node, ret, singleRet))
    .map(node => ({ node, before:node.semantic?.expression || root,
      prior:readStackReturnHistoryConsumer(node.semantic, result.ir)
        || readStackPhiHistoryConsumer(node.semantic, result.ir)
        || readLegacyStackHistoryConsumer(node.semantic, result.ir)
        || readExpressionHistoryConsumer(node.semantic, result.ir) }));
  // A stack load means no useful reconstruction happened. A committed non-stack
  // field/global load is an intentional high-level return and must be retained.
  if (!recovered || (recovered.kind === 'load' && recovered.location?.kind === 'stack') || !rewriteReturn(result, recovered, opts, ret, singleRet)) return result;
  const removals = committedSpill ? removeProofOnlyStackSpill(result, committedSpill, recovered, opts) : [];

  const records = transitions.map(item => {
    const record = Object.freeze({ rule:'exact-stack-return-recovery', phase:'memory-ssa',
      before:structuralKey(item.before), after:structuralKey(recovered),
      evidence:Object.freeze({ kind:'cfg-memory-ssa', detail:'exact stack return reconstructed from predecessor stores and flag-producing SSA evidence' }),
      originHistory:expressionOriginHistory({ source:mergeSource(item.before?.source, root.source) }, recovered),
    });
    item.records = Object.freeze([...(item.prior?.records || []), ...engine.records, record, ...removals]);
    return record;
  });
  result.rewriteProof = [...(result.rewriteProof || []), ...engine.records, ...records, ...removals];
  if (engine.truncated) result.expressionHistoryBinding = Object.freeze({
    ...result.expressionHistoryBinding, completeness:'incomplete',
    reasons:Object.freeze([...new Set([...(result.expressionHistoryBinding?.reasons || []), 'recovery-rewrite-history-budget'])]),
  });
  bindReturnHistory(result, transitions, opts);
  result.metrics = { ...(result.metrics || {}), rewrittenExpressions:(result.metrics?.rewrittenExpressions || 0) + 1, sourceMappedNodes:result.sourceMap?.length || 0 };
  result.ctx = { ...(result.ctx || {}), decompilerPipeline:{ ...(result.ctx?.decompilerPipeline || {}), exactStackReturnRecovered:true } };
  return result;
}
