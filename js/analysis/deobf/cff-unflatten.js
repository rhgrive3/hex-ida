// JS-parity OLLVM Control Flow Flattening (CFF) Unflattening Engine (§19.1).
// Includes dominator-tree Guard 6 verification, strict single-entry initState check,
// 64-bit state width + env updates, and optional WASM `hex_cff_unflatten` bridge + telemetry.
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import { simplifyMbaDag, evalMbaDag } from './mba-simplifier.js';
import { getHexEngineExports } from '../../core/hex-engine-wasm.js';
import { recordWasmCall, recordFallback } from '../../core/wasm-telemetry.js';

export const CFF_STATUS = Object.freeze({
  RECOVERED: 0,
  NOT_APPLICABLE: 1,
  ABORT_GUARD: 2,
  ABORT_BUDGET: 3,
});

export const CFF_GUARD_REASON = Object.freeze({
  NONE: 0,
  TOO_FEW_REAL_BLOCKS: 1,
  NATURAL_FSM_STATE_ORIGIN: 2,
  STATE_ESCAPE_OR_STACK_ALIAS: 3,
  UNRESOLVED_TRANSITION: 4,
  SPINE_SIDE_EFFECT: 5,
  DRAFT_CFG_INTEGRITY_ERROR: 6,
  BUDGET_EXCEEDED: 7,
});

export const CFF_TRANSITION_KIND = Object.freeze({
  UNRESOLVED: 0,
  UNCOND: 1,
  COND: 2,
  EXIT: 3,
});

export const CFF_DEFAULT_CONFIG = Object.freeze({
  flags: 0x01,
  maxRegionBlocks: 512,
  maxSpineBlocks: 128,
  maxEvalSteps: 4096,
});

const SIDE_EFFECT_OPS = new Set(['call', 'store_global', 'syscall', 'atomic', 'trap']);
const MASK64 = 0xffffffffffffffffn;

function findSccs(blockIds, succMap) {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const succs = succMap.get(v) || [];
    for (const w of succs) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  }

  for (const b of blockIds) {
    if (!indices.has(b)) strongConnect(b);
  }
  return sccs;
}

/**
 * Compute dominator sets for all reachable blocks from `entryId` via iterative dataflow.
 */
function computeDominators(entryId, blockIds, succMap, predMap) {
  const reachable = new Set();
  const q = [entryId];
  reachable.add(entryId);
  while (q.length > 0) {
    const cur = q.shift();
    for (const s of (succMap.get(cur) || [])) {
      if (!reachable.has(s)) {
        reachable.add(s);
        q.push(s);
      }
    }
  }

  const reachList = blockIds.filter((b) => reachable.has(b));
  const dom = new Map();
  for (const b of reachList) {
    dom.set(b, b === entryId ? new Set([entryId]) : new Set(reachList));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of reachList) {
      if (b === entryId) continue;
      const preds = (predMap.get(b) || []).filter((p) => reachable.has(p));
      if (preds.length === 0) continue;
      const nextDom = new Set(dom.get(preds[0]));
      for (let i = 1; i < preds.length; i++) {
        const pDom = dom.get(preds[i]);
        for (const x of nextDom) {
          if (!pDom.has(x)) nextDom.delete(x);
        }
      }
      nextDom.add(b);
      const curDom = dom.get(b);
      if (nextDom.size !== curDom.size || [...nextDom].some((x) => !curDom.has(x))) {
        dom.set(b, nextDom);
        changed = true;
      }
    }
  }

  return dom;
}

function evalRealBlockTransition(block, stateVar, stateVal, opts) {
  const stateMask = opts.stateWidthBits === 32 ? 0xffffffffn : MASK64;
  const env = { [stateVar]: BigInt(stateVal) & stateMask };
  let steps = 0;
  let nextUncond = null;
  let condTransition = null;
  let hasExit = false;

  const insts = Array.isArray(block.insts) ? block.insts : [];
  if (insts.length > 64) {
    return { ok: false, budgetExceeded: true, steps };
  }

  for (const inst of insts) {
    steps++;
    if (opts.evalStepsUsed + steps > opts.maxEvalSteps) {
      return { ok: false, budgetExceeded: true, steps };
    }

    if (
      (inst.op === 'call' || inst.op === 'ret' || inst.op === 'store_global')
      && Array.isArray(inst.srcs)
      && inst.srcs.includes(stateVar)
    ) {
      return { ok: false, guardReason: CFF_GUARD_REASON.STATE_ESCAPE_OR_STACK_ALIAS, steps };
    }

    if (inst.op === 'store_stack' && inst.nonConstOffset === true && opts.stateIsStackSpilled) {
      return { ok: false, guardReason: CFF_GUARD_REASON.STATE_ESCAPE_OR_STACK_ALIAS, steps };
    }

    if (inst.op === 'ret' || inst.op === 'exit') {
      hasExit = true;
      continue;
    }

    if (inst.dst === stateVar) {
      if (inst.op === 'const' || inst.op === 'mov_const') {
        nextUncond = BigInt(inst.value) & stateMask;
        env[stateVar] = nextUncond;
        condTransition = null;
      } else if (inst.op === 'csel' || inst.op === 'select') {
        condTransition = {
          condInstId: inst.condInstId ?? inst.id ?? 0,
          nextStateTrue: BigInt(inst.trueVal) & stateMask,
          nextStateFalse: BigInt(inst.falseVal) & stateMask,
          isInvertedCond: inst.isInvertedCond ? 1 : 0,
        };
        nextUncond = null;
      } else if (inst.op === 'mba_expr' && inst.dag) {
        const dag = (opts.flags & 0x04) ? simplifyMbaDag(inst.dag, { preferWasm: false }).expr : inst.dag;
        nextUncond = evalMbaDag(dag, env, dag.width ?? 64) & stateMask;
        env[stateVar] = nextUncond;
        condTransition = null;
      } else if (inst.op === 'add_const') {
        nextUncond = (env[stateVar] + BigInt(inst.imm ?? 0n)) & stateMask;
        env[stateVar] = nextUncond;
        condTransition = null;
      } else if (inst.op === 'xor_const') {
        nextUncond = (env[stateVar] ^ BigInt(inst.imm ?? 0n)) & stateMask;
        env[stateVar] = nextUncond;
        condTransition = null;
      } else {
        return { ok: false, guardReason: CFF_GUARD_REASON.UNRESOLVED_TRANSITION, steps };
      }
    }
  }

  if (hasExit) {
    return {
      ok: true,
      steps,
      transition: {
        realBlockId: block.id,
        condInstId: 0xffffffff,
        nextStateTrue: 0n,
        nextStateFalse: 0n,
        kind: CFF_TRANSITION_KIND.EXIT,
        isInvertedCond: 0,
      },
    };
  }
  if (condTransition) {
    return {
      ok: true,
      steps,
      transition: {
        realBlockId: block.id,
        condInstId: condTransition.condInstId,
        nextStateTrue: condTransition.nextStateTrue,
        nextStateFalse: condTransition.nextStateFalse,
        kind: CFF_TRANSITION_KIND.COND,
        isInvertedCond: condTransition.isInvertedCond,
      },
    };
  }
  if (nextUncond !== null) {
    return {
      ok: true,
      steps,
      transition: {
        realBlockId: block.id,
        condInstId: 0xffffffff,
        nextStateTrue: nextUncond,
        nextStateFalse: 0n,
        kind: CFF_TRANSITION_KIND.UNCOND,
        isInvertedCond: 0,
      },
    };
  }

  return { ok: false, guardReason: CFF_GUARD_REASON.UNRESOLVED_TRANSITION, steps };
}

/**
 * Optional WASM bridge check for `hex_cff_unflatten` (`cpp/include/hex_deobf.hpp`).
 */
export function runCffUnflattenWasm(blocks, edges, opts = {}) {
  const ex = opts.wasmExports ?? getHexEngineExports(opts);
  if (!ex || typeof ex.hex_cff_unflatten !== 'function' || typeof ex.hex_deobf_scratch_ptr !== 'function') {
    recordFallback('CFF_JS_FALLBACK');
    return null;
  }
  try {
    const base = ex.hex_deobf_scratch_ptr();
    const scratchSize = ex.hex_deobf_scratch_size();
    const blkBytes = blocks.length * 48;
    const inEdgeBytes = edges.length * 16;
    const maxOutEdges = Math.max(64, blocks.length * 4);
    const outEdgeBytes = maxOutEdges * 16;
    const totalNeeded = blkBytes + inEdgeBytes + outEdgeBytes + 64;
    if (scratchSize < totalNeeded) {
      recordFallback('CFF_SCRATCH_OOM');
      return null;
    }

    const blkPtr = base;
    const inEdgePtr = blkPtr + blkBytes;
    const outEdgePtr = inEdgePtr + inEdgeBytes;
    const resPtr = (outEdgePtr + outEdgeBytes + 7) & ~7;

    const dv = new DataView(ex.memory.buffer);
    for (let i = 0; i < blocks.length; i++) {
      const o = blkPtr + i * 48;
      const b = blocks[i];
      dv.setUint32(o + 0x00, b.blockId >>> 0, true);
      dv.setUint32(o + 0x04, b.flags >>> 0, true);
      dv.setUint32(o + 0x08, (b.stateVarId ?? 0) >>> 0, true);
      dv.setUint32(o + 0x0c, (b.condId ?? 0) >>> 0, true);
      dv.setBigUint64(o + 0x10, BigInt(b.matchState ?? 0n) & MASK64, true);
      dv.setBigUint64(o + 0x18, BigInt(b.nextStateTrue ?? 0n) & MASK64, true);
      dv.setBigUint64(o + 0x20, BigInt(b.nextStateFalse ?? 0n) & MASK64, true);
      dv.setUint32(o + 0x28, b.hasMatchState ? 1 : 0, true);
      dv.setUint32(o + 0x2c, 0, true);
    }
    for (let i = 0; i < edges.length; i++) {
      const o = inEdgePtr + i * 16;
      const e = edges[i];
      dv.setUint32(o + 0x00, e.srcBlock >>> 0, true);
      dv.setUint32(o + 0x04, e.dstBlock >>> 0, true);
      dv.setUint32(o + 0x08, (e.kind ?? 1) >>> 0, true);
      dv.setUint32(o + 0x0c, (e.condId ?? 0) >>> 0, true);
    }

    const status = ex.hex_cff_unflatten(blkPtr, blocks.length, inEdgePtr, edges.length, outEdgePtr, maxOutEdges, resPtr);
    if (status !== 0) {
      recordFallback('CFF_WASM_STATUS_ERR');
      return null;
    }
    recordWasmCall('cff_unflatten');

    const result = {
      engine: 'wasm',
      statusCode: dv.getUint32(resPtr + 0x00, true),
      guardFailReason: dv.getUint32(resPtr + 0x04, true),
      dispatcherBlock: dv.getUint32(resPtr + 0x08, true),
      stateVarId: dv.getUint32(resPtr + 0x0c, true),
      realBlockCount: dv.getUint32(resPtr + 0x10, true),
      spineBlockCount: dv.getUint32(resPtr + 0x14, true),
      recoveredEdgeCount: dv.getUint32(resPtr + 0x18, true),
      uncondEdgeCount: dv.getUint32(resPtr + 0x1c, true),
      condEdgeCount: dv.getUint32(resPtr + 0x20, true),
      exitBlockCount: dv.getUint32(resPtr + 0x24, true),
      recoveredEdges: [],
    };
    for (let i = 0; i < result.recoveredEdgeCount; i++) {
      const o = outEdgePtr + i * 16;
      result.recoveredEdges.push({
        srcBlock: dv.getUint32(o + 0x00, true),
        dstBlock: dv.getUint32(o + 0x04, true),
        kind: dv.getUint32(o + 0x08, true),
        condId: dv.getUint32(o + 0x0c, true),
      });
    }
    return result;
  } catch {
    recordFallback('CFF_WASM_EXCEPTION');
    return null;
  }
}

export function unflattenCffIr(irFn, userConfig = {}) {
  const cfg = {
    flags: userConfig.flags ?? CFF_DEFAULT_CONFIG.flags,
    maxRegionBlocks: Math.min(1024, userConfig.maxRegionBlocks ?? CFF_DEFAULT_CONFIG.maxRegionBlocks),
    maxSpineBlocks: userConfig.maxSpineBlocks ?? CFF_DEFAULT_CONFIG.maxSpineBlocks,
    maxEvalSteps: userConfig.maxEvalSteps ?? CFF_DEFAULT_CONFIG.maxEvalSteps,
    stateWidthBits: userConfig.stateWidthBits ?? 64,
  };

  const makeResult = (statusCode, guardFailReason, extra = {}) => ({
    engine: 'js',
    statusCode,
    guardFailReason,
    stats: {
      statusCode,
      guardFailReason,
      dispatchersFixed: extra.dispatchersFixed ?? 0,
      realBlocks: extra.realBlocks ?? 0,
      spineBlocks: extra.spineBlocks ?? 0,
      uncondEdges: extra.uncondEdges ?? 0,
      condEdges: extra.condEdges ?? 0,
      exitEdges: extra.exitEdges ?? 0,
      evalStepsUsed: extra.evalStepsUsed ?? 0,
    },
    transitions: extra.transitions ?? [],
    unflattenedIr: extra.unflattenedIr ?? null,
  });

  if (!(cfg.flags & 0x01) || !irFn || !Array.isArray(irFn.blocks)) {
    return makeResult(CFF_STATUS.NOT_APPLICABLE, CFF_GUARD_REASON.NONE);
  }
  if (irFn.blocks.length > cfg.maxRegionBlocks) {
    return makeResult(CFF_STATUS.ABORT_BUDGET, CFF_GUARD_REASON.BUDGET_EXCEEDED);
  }

  // Record fallback telemetry if caller explicitly requested JS or WASM is unavailable
  if (userConfig._engine === 'js') {
    recordFallback('CFF_JS_FORCED');
  }

  const blockMap = new Map();
  const succMap = new Map();
  const predMap = new Map();
  const blockIds = [];

  for (const b of irFn.blocks) {
    blockMap.set(b.id, b);
    blockIds.push(b.id);
    const succs = Array.isArray(b.succs) ? b.succs : [];
    succMap.set(b.id, succs);
    if (!predMap.has(b.id)) predMap.set(b.id, []);
    for (const s of succs) {
      if (!predMap.has(s)) predMap.set(s, []);
      predMap.get(s).push(b.id);
    }
  }

  const sccs = findSccs(blockIds, succMap).filter((c) => c.length >= 4);
  if (sccs.length === 0) {
    return makeResult(CFF_STATUS.NOT_APPLICABLE, CFF_GUARD_REASON.TOO_FEW_REAL_BLOCKS);
  }

  const targetScc = sccs.sort((a, b) => b.length - a.length)[0];
  const sccSet = new Set(targetScc);

  let dispatcher = null;
  for (const bid of targetScc) {
    const b = blockMap.get(bid);
    if (b?.dispatchCases && Object.keys(b.dispatchCases).length >= 4) {
      dispatcher = b;
      break;
    }
  }
  if (!dispatcher) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.TOO_FEW_REAL_BLOCKS);
  }

  const stateVar = irFn.stateVar || dispatcher.stateVar || 'state';

  if (
    irFn.stateVarOrigin === 'arg'
    || irFn.stateVarOrigin === 'global'
    || irFn.stateVarOrigin === 'call_ret'
  ) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.NATURAL_FSM_STATE_ORIGIN);
  }

  // Strict single pre-entry predecessor & constant initial state S0 check (Fail-Closed!)
  const prePreds = (predMap.get(dispatcher.id) || []).filter((p) => !sccSet.has(p));
  if (prePreds.length !== 1) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);
  }
  let initState = null;
  const preBlock = blockMap.get(prePreds[0]);
  for (const inst of (preBlock?.insts || [])) {
    if (inst.dst === stateVar) {
      if (inst.op === 'const' || inst.op === 'mov_const') {
        initState = BigInt(inst.value) & (cfg.stateWidthBits === 32 ? 0xffffffffn : MASK64);
      } else if (inst.op === 'arg' || inst.op === 'load_global' || inst.op === 'call') {
        return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.NATURAL_FSM_STATE_ORIGIN);
      }
    }
  }
  if (initState === null) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.NATURAL_FSM_STATE_ORIGIN);
  }

  const stateToBlock = new Map();
  const realBlockToState = new Map();
  for (const [kStr, targetBid] of Object.entries(dispatcher.dispatchCases)) {
    const k = BigInt(kStr) & (cfg.stateWidthBits === 32 ? 0xffffffffn : MASK64);
    if (!blockMap.has(targetBid)) {
      return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);
    }
    stateToBlock.set(k, targetBid);
    realBlockToState.set(targetBid, k);
  }

  if (realBlockToState.size < 4 || stateToBlock.size < 4) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.TOO_FEW_REAL_BLOCKS);
  }

  // Guard 6 (Dominance Check): Dispatcher MUST dominate EVERY real block in the CFG!
  const entryId = irFn.entryBlock ?? blockIds[0];
  const domSets = computeDominators(entryId, blockIds, succMap, predMap);
  for (const realBid of realBlockToState.keys()) {
    const rDom = domSets.get(realBid);
    if (!rDom || !rDom.has(dispatcher.id)) {
      return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR);
    }
  }

  const spineIds = new Set([dispatcher.id]);
  for (const bid of targetScc) {
    if (!realBlockToState.has(bid)) {
      spineIds.add(bid);
    }
  }
  if (spineIds.size > cfg.maxSpineBlocks) {
    return makeResult(CFF_STATUS.ABORT_BUDGET, CFF_GUARD_REASON.BUDGET_EXCEEDED);
  }

  // Guard 5: Side-effect inside spine
  for (const sid of spineIds) {
    const sb = blockMap.get(sid);
    for (const inst of (sb?.insts || [])) {
      if (SIDE_EFFECT_OPS.has(inst.op)) {
        return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.SPINE_SIDE_EFFECT);
      }
    }
  }

  // Stage 2: Bounded abstract evaluation
  const transitions = [];
  let evalStepsUsed = 0;
  let uncondEdges = 0;
  let condEdges = 0;
  let exitEdges = 0;

  for (const [realBid, stateKey] of realBlockToState.entries()) {
    const block = blockMap.get(realBid);
    const ev = evalRealBlockTransition(block, stateVar, stateKey, {
      flags: cfg.flags,
      evalStepsUsed,
      maxEvalSteps: cfg.maxEvalSteps,
      stateIsStackSpilled: Boolean(irFn.stateIsStackSpilled),
      stateWidthBits: cfg.stateWidthBits,
    });
    evalStepsUsed += ev.steps;
    if (ev.budgetExceeded) {
      return makeResult(CFF_STATUS.ABORT_BUDGET, CFF_GUARD_REASON.BUDGET_EXCEEDED, { evalStepsUsed });
    }
    if (!ev.ok) {
      return makeResult(CFF_STATUS.ABORT_GUARD, ev.guardReason ?? CFF_GUARD_REASON.UNRESOLVED_TRANSITION, { evalStepsUsed });
    }

    const tr = ev.transition;
    if (tr.kind === CFF_TRANSITION_KIND.UNCOND) {
      if (!stateToBlock.has(tr.nextStateTrue)) {
        return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.UNRESOLVED_TRANSITION, { evalStepsUsed });
      }
      uncondEdges++;
    } else if (tr.kind === CFF_TRANSITION_KIND.COND) {
      if (!stateToBlock.has(tr.nextStateTrue) || !stateToBlock.has(tr.nextStateFalse)) {
        return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.UNRESOLVED_TRANSITION, { evalStepsUsed });
      }
      condEdges += 2;
    } else if (tr.kind === CFF_TRANSITION_KIND.EXIT) {
      exitEdges++;
    }
    transitions.push(tr);
  }

  // Stage 3: Dry-Run draft CFG construction & integrity validation
  const draftBlocks = new Map();
  for (const b of irFn.blocks) {
    draftBlocks.set(b.id, {
      ...b,
      insts: (b.insts || []).map((i) => ({ ...i })),
      succs: [...(b.succs || [])],
      nopped: false,
    });
  }

  const firstReal = stateToBlock.get(initState);
  if (!firstReal) {
    return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR, { evalStepsUsed });
  }
  const preDraft = draftBlocks.get(prePreds[0]);
  preDraft.succs = [firstReal];
  preDraft.insts = preDraft.insts.filter((i) => i.dst !== stateVar);

  for (const tr of transitions) {
    const db = draftBlocks.get(tr.realBlockId);
    db.insts = db.insts.filter((i) => i.dst !== stateVar);
    if (tr.kind === CFF_TRANSITION_KIND.UNCOND) {
      db.succs = [stateToBlock.get(tr.nextStateTrue)];
      db.terminator = { op: 'br', target: db.succs[0] };
    } else if (tr.kind === CFF_TRANSITION_KIND.COND) {
      const trueDst = stateToBlock.get(tr.nextStateTrue);
      const falseDst = stateToBlock.get(tr.nextStateFalse);
      db.succs = tr.isInvertedCond ? [falseDst, trueDst] : [trueDst, falseDst];
      db.terminator = {
        op: 'cbr',
        condInstId: tr.condInstId,
        trueDst: db.succs[0],
        falseDst: db.succs[1],
      };
    } else if (tr.kind === CFF_TRANSITION_KIND.EXIT) {
      db.succs = [];
      db.terminator = { op: 'ret' };
    }
  }

  for (const sid of spineIds) {
    const sb = draftBlocks.get(sid);
    sb.nopped = true;
    sb.insts = [];
    sb.succs = [];
  }

  for (const db of draftBlocks.values()) {
    if (db.nopped) continue;
    for (const s of db.succs) {
      const target = draftBlocks.get(s);
      if (!target || target.nopped) {
        return makeResult(CFF_STATUS.ABORT_GUARD, CFF_GUARD_REASON.DRAFT_CFG_INTEGRITY_ERROR, { evalStepsUsed });
      }
    }
  }

  return makeResult(CFF_STATUS.RECOVERED, CFF_GUARD_REASON.NONE, {
    dispatchersFixed: 1,
    realBlocks: realBlockToState.size,
    spineBlocks: spineIds.size,
    uncondEdges,
    condEdges,
    exitEdges,
    evalStepsUsed,
    transitions,
    unflattenedIr: {
      entryBlock: irFn.entryBlock,
      blocks: [...draftBlocks.values()].filter((b) => !b.nopped),
      removedSpineBlocks: [...spineIds],
    },
  });
}
