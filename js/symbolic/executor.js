import { prepareMemoryObservations, observeTerminalMemory } from './memory/observations.js';
import { validateExecutionContract } from './memory/execution-contract.js';
/*
 * symbolic/executor.js — bounded light symbolic execution over Semantic IR.
 *
 * It intentionally stops on unsupported semantic operations. The executor does
 * not pretend that an unknown instruction preserved registers/memory.
 */
import { OP, MK, COND, mayAliasProvenance } from '../ir.js';
import { valueBefore } from '../dataflow-semantic.js';
import { createByteMemory, forkByteMemoryForExecution } from './memory/byte-memory.js';
import { QueryFailure, monotonicNow, boundedLimit } from './memory/query-state.js';
import { translateExecutionValue, translateMemoryAccess, translateMemoryScalar } from './translate/memory.js';
import { createBv, createExtract, createConnective, computeStructuralHash } from './expr/index.js';

import { createExecutionCapture } from './memory/execution-snapshot.js';
import { semanticValueIdentity, registerExecutionValue } from './memory/value-identity.js';

const BYTE_EXECUTION_OPS = new Set([OP.CONST,OP.MOV,OP.BIN,OP.UN,OP.CMP,OP.SEL,OP.LOAD,OP.STORE,OP.ADDR,OP.CALL,OP.RET,OP.BR,OP.CBR,OP.PHI,OP.CLOBBER,OP.UNKNOWN]);

export const SYM = Object.freeze({ CONST: 'const', SYMBOL: 'symbol', OP: 'op', ITE: 'ite', UNKNOWN: 'unknown' });

export function symbolic(name, meta) {
  // Caller metadata cannot override the canonical fields that define a symbol
  // expression's semantic identity. Auxiliary metadata (source/index/location)
  // is preserved; `kind` and `name` stay constructor-owned.
  return { ...(meta || {}), kind: SYM.SYMBOL, name: String(name) };
}
export function symbolicArg(index, name) { return symbolic(name || 'arg' + index, { source: 'argument', index }); }
export function symbolicField(location, name) {
  const key = location && (location.key || (location.disp != null ? String(location.disp) : null));
  return symbolic(name || ('field(' + (key || '?') + ')'), { source: 'field', location });
}

function c(value) { return { kind: SYM.CONST, value: BigInt(value) }; }

// Bit width is a semantic authority: only primitive finite safe-integer numbers
// may define it. Structured values must not launder into a canonical width via
// Number() coercion (e.g. Number(['8']) === 8).
function widthOf(bits, fallback = 64) {
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1) return fallback;
  return Math.max(1, Math.min(64, bits));
}
function unknown(reason, detail) { return { kind: SYM.UNKNOWN, reason, detail: detail || null }; }
function op(name, ...args) {
  if (args.every((a) => a && a.kind === SYM.CONST)) {
    const a = args[0].value, b = args[1] && args[1].value;
    try {
      if (name === 'add') return c(a + b);
      if (name === 'sub') return c(a - b);
      if (name === 'and') return c(a & b);
      if (name === 'or' || name === 'orr') return c(a | b);
      if (name === 'xor' || name === 'eor') return c(a ^ b);
      if (name === 'shl') return c(a << b);
      if (name === 'lshr') return c(a >> b);
      if (name === 'mul') return c(a * b);
    } catch { /* symbolic fallback */ }
  }
  return { kind: SYM.OP, op: name, args };
}

function binOp(name, a, b, bits = 64) {
  const width = widthOf(bits);
  if (a && b && a.kind === SYM.CONST && b.kind === SYM.CONST) {
    const av = a.value, bv = b.value;
    try {
      let value;
      if (name === 'add') value = av + bv;
      else if (name === 'sub') value = av - bv;
      else if (name === 'mul') value = av * bv;
      else if (name === 'and') value = av & bv;
      else if (name === 'or' || name === 'orr') value = av | bv;
      else if (name === 'xor' || name === 'eor') value = av ^ bv;
      else if (name === 'shl') value = av << (bv & BigInt(width - 1));
      else if (name === 'lshr') value = BigInt.asUintN(width, av) >> (bv & BigInt(width - 1));
      else if (name === 'ashr') value = BigInt.asIntN(width, av) >> (bv & BigInt(width - 1));
      else return op(name, a, b);
      return c(BigInt.asUintN(width, value));
    } catch { /* symbolic fallback */ }
  }
    if (name === 'shl' || name === 'lshr' || name === 'ashr') {
  const masked = { kind:SYM.OP, op:'and', args:[b, c(BigInt(width - 1))], bits:width };
  return { kind: SYM.OP, op: name, args: [a, masked], bits:width };
}
// Symbolic integer arithmetic is still a fixed-width bitvector. Keep
// that identity even when we cannot fold the operands to constants.
return { kind: SYM.OP, op: name, args: [a, b], bits:width };

}

function cmp(name, a, b, options = {}) {
  const bits = a?.sort?.width ?? b?.sort?.width ?? widthOf(options.bits);
  if (a?.sort || b?.sort) {
    const left = a.sort ? a : createBv(bits, a.value);
    const right = b.sort ? b : createBv(bits, b.value);
    return translateMemoryScalar({ op: OP.CMP, cond: name, signed: options.signed }, [left, right], bits);
  }
  const signed = options.signed === true ? true : options.signed === false ? false : null;
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const au = BigInt.asUintN(bits, a.value), bu = BigInt.asUintN(bits, b.value);
    const av = signed === true ? BigInt.asIntN(bits, au) : au;
    const bv = signed === true ? BigInt.asIntN(bits, bu) : bu;
    const yes = name === '==' ? au === bu : name === '!=' ? au !== bu : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true, bits, signed };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true, bits, signed };
}
function conditionIdentity(condition) {
  if (condition?.kind === SYM.OP && condition.boolean && ['==', '!=', '<', '<=', '>', '>='].includes(condition.op)) {
    const mode = condition.signed === true ? 's' : condition.signed === false ? 'u' : 'n';
    return `${mode}${condition.bits || 64}:${expressionText(condition)}`;
  }
  return expressionText(condition);
}
function negate(condition) {
  if (!condition) return unknown('missing-condition');
  if (condition.sort) return createConnective('not', condition);
  if (condition.kind === SYM.CONST && condition.boolean) return { ...c(condition.value === 0n ? 1n : 0n), boolean:true };
  const inverse = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[condition.op];
  if (condition.kind === SYM.OP && inverse) return { ...condition, op: inverse };
  return { kind: SYM.OP, op: 'not', args: [condition], boolean: true };
}
function constraintAllowed(existing, condition) {
  if (condition?.sort) return !(condition.kind === 'const' && condition.sort.kind === 'bool' && condition.value === false);
  if (condition?.kind === SYM.CONST && condition.boolean) return condition.value !== 0n;
  const key = conditionIdentity(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (conditionIdentity(negate(prior)) === key) return false;
  }
  return true;
}

export function expressionText(e) {
  if (!e) return '?';
  if (e.sort && e.kind !== 'const') return `Expr<${e.sort.kind}${e.sort.width ?? ''}>#${computeStructuralHash(e)}`;
  if (e.kind === SYM.CONST) return e.value.toString();
  if (e.kind === SYM.SYMBOL) return e.name;
  if (e.kind === SYM.UNKNOWN) return 'unknown(' + e.reason + ')';
  if (e.kind === SYM.ITE) return '(' + expressionText(e.condition) + ' ? ' + expressionText(e.then) + ' : ' + expressionText(e.else) + ')';
    if (e.kind === SYM.OP) {
  let body;
  if (e.op === 'not') body = 'not ' + expressionText(e.args[0]);
  else if (e.args.length === 1) body = e.op + '(' + expressionText(e.args[0]) + ')';
  else body = '(' + expressionText(e.args[0]) + ' ' + e.op + ' ' + expressionText(e.args[1]) + ')';
  const bits = typeof e.bits === 'number' ? e.bits : null;
  return Number.isSafeInteger(bits) && bits > 0 ? `i${bits}${body}` : body;
}

  return '?';
}

function cloneState(s) {
  s.byteMemory?.chargeExecution(1, s.values.size + (s.scalarCache?.size ?? 0) + s.constraints.length + s.branches.length + s.touchedFields.length + s.visits.size);
  return {
    block: s.block,
    prevBlock: s.prevBlock,
    memory: new Map(s.memory),
    byteMemory: s.byteMemory?.fork(),
    scalarCache: new Map(s.scalarCache), inputExpressions: s.inputExpressions, valueIdentities: s.valueIdentities, semanticIdentities: s.semanticIdentities,
    taint: s.taint, control: s.control,
    enforceExecutionOrder: s.enforceExecutionOrder, executingInstruction: null,
    values: new Map(s.values),
    constraints: s.constraints.slice(),
    branches: s.branches.slice(),
    touchedFields: s.touchedFields.slice(),
    visits: new Map(s.visits),
    steps: s.steps,
  };
}

function fieldName(opts, loc) {
  const configured = opts && opts.symbolicFields;
  if (configured) {
    const keys = [loc && loc.key, loc && loc.disp != null ? String(loc.disp) : null].filter(Boolean);
    for (const k of keys) {
      if (configured instanceof Map && configured.has(k)) return configured.get(k);
      if (typeof configured === 'object' && Object.prototype.hasOwnProperty.call(configured, k)) return configured[k];
    }
  }
  return null;
}

function argExpr(value, opts) {
  const reg = String(value && value.reg || '');
  const m = /^x([0-7])$/.exec(reg);
  if (!m) return unknown('undefined-entry-register', { reg });
  const index = Number(m[1]);
  const configured = opts && opts.symbolicArgs;
  if (configured && typeof configured === 'object') {
    const v = configured[index] != null ? configured[index] : configured[reg];
    if (typeof v === 'bigint' || typeof v === 'number') return c(v);
    if (typeof v === 'string') return symbolicArg(index, v);
    if (v && typeof v === 'object' && v.kind) return v;
  }
  return symbolicArg(index);
}

function locationKey(loc) {
  if (!loc) return null;
  return loc.key || (loc.kind === MK.GLOBAL && loc.address != null ? 'global:' + loc.address.toString(16) : null);
}

function phiValue(inst, state) {
  if (!inst || !inst.incoming || !inst.incoming.length) return null;
  const hit = inst.incoming.find((x) => x.from === state.prevBlock);
  return hit ? hit.value : (inst.incoming.length === 1 ? inst.incoming[0].value : null);
}

function loadExpression(inst, state, opts) {
  if (state.byteMemory) return translateMemoryAccess(inst, state, opts);
  if (!inst || !inst.loc) return unknown('missing-load-location', { instruction: inst && inst.id });
  const key = locationKey(inst.loc);
  if (key && state.memory.has(key)) {
    const remembered = state.memory.get(key);
    return remembered && remembered.value ? remembered.value : remembered;
  }
  if (inst.loc.kind === MK.UNKNOWN) return unknown('unknown-load-alias', { instruction: inst.id });
  return symbolicField(inst.loc, fieldName(opts, inst.loc));
}

function evalValue(value, state, ir, opts, memo, active) {
  if (!value) return unknown('missing-value');
  if (state.byteMemory) return translateExecutionValue(value, state, opts);
  if (state.values.has(value.id)) return state.values.get(value.id);
  const stateKey = value.id + '@' + state.prevBlock + '@' + state.block;
  if (memo.has(stateKey)) return memo.get(stateKey);
  if (active.has(value.id)) return unknown('symbolic-cycle', { value: value.id });
  active.add(value.id);
  let out = null;
  if (value.const != null) out = c(value.const);
  else if (value.kind === 'arg') out = argExpr(value, opts);
  else if (!value.def) out = unknown('value-without-definition', { value: value.id });
  else {
    const d = value.def;
    if (d.op === OP.MOV && d.args[0]) out = evalValue(d.args[0].value, state, ir, opts, memo, active);
    else if (d.op === OP.PHI) {
      const chosen = phiValue(d, state);
      out = chosen ? evalValue(chosen, state, ir, opts, memo, active) : unknown('ambiguous-phi', { instruction: d.id });
    } else if (d.op === OP.BIN && d.args.length >= 2 && ['add', 'sub', 'and', 'or', 'xor', 'orr', 'eor', 'shl', 'lshr', 'ashr', 'mul'].includes(d.sub)) {
      out = binOp(d.sub,
        evalValue(d.args[0].value, state, ir, opts, memo, active),
        evalValue(d.args[1].value, state, ir, opts, memo, active),
        widthOf(d.dst?.bits, widthOf(value?.bits, 64)));
    } else if (d.op === OP.UN && d.args[0] && /^(sxt|uxt|fmov|neg)/.test(d.sub || '')) {
      const x = evalValue(d.args[0].value, state, ir, opts, memo, active);
      const toBits = widthOf(d.dst?.bits, widthOf(value?.bits, 64));
      const m = /^(sxt|uxt)(8|16|32|64)?/.exec(d.sub || '');
      if (d.sub === 'neg') out = binOp('sub', c(0n), x, toBits);
      else if (m) {
        // m[2] comes from the canonical op-name grammar, not decoder evidence.
        const fromBits = m[2] != null
          ? Number(m[2])
          : widthOf(d.args[0].bits, widthOf(d.args[0].value?.bits, toBits));
        if (x.kind === SYM.CONST) {
          const narrowed = m[1] === 'sxt' ? BigInt.asIntN(fromBits, x.value) : BigInt.asUintN(fromBits, x.value);
          out = c(BigInt.asUintN(toBits, narrowed));
        } else out = { kind:SYM.OP, op:m[1] === 'sxt' ? 'sext' : 'zext', args:[x], fromBits, toBits };
      } else out = x;
    } else if (d.op === OP.LOAD && d.loc) {
      out = loadExpression(d, state, opts);
    } else if (d.op === OP.SEL && d.args.length >= 2) {
      const condition = conditionFromFlags(d, state, ir, opts, memo, active);
      out = {
        kind: SYM.ITE,
        condition,
        then: evalValue(d.args[0].value, state, ir, opts, memo, active),
        else: evalValue(d.args[1].value, state, ir, opts, memo, active),
      };
    } else if (d.op === OP.ADDR && value.const != null) out = c(value.const);
    else out = unknown('unsupported-value-op', { op: d.op, sub: d.sub, instruction: d.id });
  }
  active.delete(value.id);
  memo.set(stateKey, out);
  return out;
}

function conditionFromCmp(cmpInst, condCode, state, ir, opts, memo, active) {
  if (!cmpInst || cmpInst.op !== OP.CMP || cmpInst.args.length < 2) return unknown('unsupported-compare');
  const info = COND[condCode];
  if (!info || !info.op) return unknown('unsupported-condition', { condition: condCode });
  const a = evalValue(cmpInst.args[0].value, state, ir, opts, memo, active);
  const b = evalValue(cmpInst.args[1].value, state, ir, opts, memo, active);
  const bits = widthOf(
    cmpInst.args[0]?.bits,
    widthOf(cmpInst.args[0]?.value?.bits,
      widthOf(cmpInst.args[1]?.bits,
        widthOf(cmpInst.args[1]?.value?.bits, 64))));
  return cmp(info.op, a, b, { bits, signed: info.signed });
}

function conditionFromFlags(inst, state, ir, opts, memo, active) {
  // Semantic-v2 compatibility carries the comparison result explicitly as a
  // value whose defining instruction is CMP. Prefer that architecture-neutral
  // proof. SEL has two data arms before its flags carrier, while CBR keeps its
  // flags carrier at the last argument; choosing the first CMP would let a
  // data arm hijack the condition. The legacy nzcv register identity remains
  // a fallback for old IR that does not retain the defining CMP.
  const args = inst.args || [];
  const positionalCarrier = inst.op === OP.SEL ? args[2]
    : inst.op === OP.CBR ? args.at(-1)
      : null;
  const carrierArg = positionalCarrier?.value?.def?.op === OP.CMP
    ? positionalCarrier
    : args.find((a) => a?.value?.reg === 'nzcv');
  const carrier = carrierArg?.value ?? null;
  // Reusing a CMP definition is only valid after that carrier executed on the
  // current path. Recomputing its operands is not proof of execution.
  if (state.byteMemory && carrier) evalValue(carrier, state, ir, opts, memo, active);
  return conditionFromCmp(carrier?.def, inst.cond, state, ir, opts, memo, active);
}

function branchCondition(inst, state, ir, opts, memo) {
  if (state.byteMemory && inst.args?.length !== 1) throw new QueryFailure('branch-operand-arity');
  const kind = inst.extra && inst.extra.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && inst.args[0]) {
    const a = evalValue(inst.args[0].value, state, ir, opts, memo, new Set());
    return cmp(kind === 'cbz' ? '==' : '!=', a, c(0n));
  }
  if (state.byteMemory && (kind === 'tbz' || kind === 'tbnz')) {
    const value=inst.args[0]?.value;
    const a=value?evalValue(value,state,ir,opts,memo,new Set()):null;
    const bit=inst.extra.bit;
    if(!a || a.sort?.kind!=='bv' || typeof bit!=='number' || !Number.isSafeInteger(bit) || bit<0 || bit>=a.sort.width) throw new QueryFailure('invalid-bit-test');
    return cmp(kind==='tbz'?'==':'!=',createExtract(a,bit,bit),createBv(1,0n));
  }
  if (kind === 'tbz' || kind === 'tbnz') {
    const a = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-test-value');
    const bit = BigInt(inst.extra && inst.extra.bit != null ? inst.extra.bit : 0);
    const masked = op('and', op('lshr', a, c(bit)), c(1n));
    return cmp(kind === 'tbz' ? '==' : '!=', masked, c(0n));
  }
  return conditionFromFlags(inst, state, ir, opts, memo, new Set());
}

function addressBlockMap(ir) {
  const m = new Map();
  for (const block of ir.blocks || []) {
    let first = null;
    for (const inst of block.insts || []) {
      if (inst.address != null && (first == null || inst.row < first.row)) first = inst;
    }
    if (first && first.address != null) m.set(first.address.toString(), block.index);
  }
  return m;
}

function successorsForBranch(ir, block, inst, addressMap) {
  const succ = (block && block.succ || []).slice();
  const target = inst.extra && inst.extra.target != null ? addressMap.get(inst.extra.target.toString()) : null;
  if (inst.op === OP.BR) return { target: target == null ? null : target, fallthrough: null };
  if (inst.op !== OP.CBR) return { target: null, fallthrough: null };
  let fallthrough = succ.find((b) => b !== target);
  if (target == null && succ.length === 2) return { target: null, fallthrough: null };
  if (fallthrough == null && succ.length === 1 && target !== succ[0]) fallthrough = succ[0];
  return { target, fallthrough: fallthrough == null ? null : fallthrough };
}

function stopResult(state, reason, inst) {
  return {
    status: 'unknown',
    reason,
    at: inst ? { row: inst.row, address: inst.address, op: inst.op, sub: inst.sub || null } : null,
    constraints: state.constraints.slice(),
    constraintText: state.constraints.map(expressionText),
    takenBranches: state.branches.slice(),
    touchedFields: state.touchedFields.slice(),
    returnValue: null,
  };
}

function executionBudget(value, fallback, min, max, name) {
  // Execution budgets are resource authorities. Only a primitive finite safe
  // integer may define one; structured values must not coerce into a regular
  // limit (Number(['1']) === 1). null/undefined still take the fallback.
  const n = value == null ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new TypeError(`${name} must be a finite safe integer`);
  }
  if (n < min) return min;
  return Math.min(n, max);
}

/** Explore bounded Semantic IR paths. */
function executePaths(ir, opts) {
  const cancelledFn = opts?.isCancelled ?? (() => false);
  if (typeof cancelledFn !== 'function') throw new TypeError('isCancelled must be a function');
  if (!ir || !ir.blocks || !ir.blocks.length) return { paths: [], truncated: false, engine: 'semantic-ir-symbolic' };
  const maxPaths = opts?._byteMemory ? boundedLimit(opts.maxPaths, 16, 16, 'maxPaths') : executionBudget(opts && opts.maxPaths, 16, 1, 64, 'maxPaths');
  const maxSteps = opts?._byteMemory ? boundedLimit(opts.maxSteps, 2000, 2000, 'maxSteps') : executionBudget(opts && opts.maxSteps, 2000, 8, 20000, 'maxSteps');
  const maxBranches = opts?._byteMemory ? boundedLimit(opts.maxBranches, 32, 32, 'maxBranches') : executionBudget(opts && opts.maxBranches, 32, 1, 256, 'maxBranches');
  const maxBlockVisits = opts?._byteMemory ? boundedLimit(opts.maxBlockVisits, 3, 3, 'maxBlockVisits') : executionBudget(opts && opts.maxBlockVisits, 3, 1, 32, 'maxBlockVisits');
  const timeoutMs = executionBudget(opts && opts.timeoutMs, 250, 10, 5000, 'timeoutMs');
  const signal = opts && opts.signal || null;
  const cancelled = () => !!(signal && signal.aborted) || cancelledFn();
  const deadline = Date.now() + timeoutMs;
  const addressMap = opts?._addressMap ?? addressBlockMap(ir);
  const stats = opts?._executionMetrics ?? { paths: 0, stepsPerPath: 0, branches: 0, blockVisitsPerBlock: 0 };
  const queue = [{ enforceExecutionOrder: !!opts?._byteMemory, executingInstruction: null, byteMemory: opts?._byteMemory, scalarCache: new Map(), inputExpressions: new Map(), valueIdentities: new Map(), semanticIdentities:new Map(), taint: opts?._taint, control: null, block: ir.entry || 0, prevBlock: -1, memory: new Map(), values: new Map(), constraints: [], branches: [], touchedFields: [], visits: new Map(), steps: 0 }];
  const paths = [];
  let branchCount = 0;
  let truncated = false;

  while (queue.length && paths.length < maxPaths) {
    if (cancelled() || Date.now() > deadline) { truncated = true; break; }
    stats.paths = Math.max(stats.paths, paths.length + queue.length);
    const state = queue.shift();
    if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget')); continue; }
    const n = (state.visits.get(state.block) || 0) + 1;
    if (state.byteMemory && n > maxBlockVisits) { paths.push(stopResult(state, 'loop-budget')); continue; }
    state.visits.set(state.block, n);
    stats.blockVisitsPerBlock = Math.max(stats.blockVisitsPerBlock, n);
    if (n > maxBlockVisits) { paths.push(stopResult(state, 'loop-budget')); continue; }
    const block = ir.blocks[state.block];
    if (!block) { paths.push(stopResult(state, 'missing-block')); continue; }
    const memo = new Map();
    state.executingInstruction = null;
    let transferred = false;

        // PHIs are parallel assignments at block entry. Evaluate every
  // incoming value against the previous iteration's state, then commit
  // the new PHI values together. Reusing the cached destination here
  // would freeze a loop-carried value after its first visit.
  const phiUpdates = [];
  for (const phi of block.phis || []) {
    if (!phi.dst) continue;
    if (state.byteMemory) registerExecutionValue(phi.dst,state);
    const matches = state.byteMemory ? (phi.incoming || []).filter(item => item.from === state.prevBlock) : null;
    const chosen = state.byteMemory ? (matches.length === 1 ? matches[0].value : null) : phiValue(phi, state);
    if (state.byteMemory && !chosen) throw new QueryFailure('ambiguous-phi');
    const value = chosen
      ? evalValue(chosen, state, ir, opts, memo, new Set())
      : unknown('ambiguous-phi', { instruction: phi.id });
    phiUpdates.push([phi.dst.id, value]);
    state.taint?.value(semanticValueIdentity(phi.dst), chosen ? [semanticValueIdentity(chosen)] : [], 'phi', { unknown: !chosen, control: state.control });
  }
  // PHIs read the predecessor iteration in parallel. Ordinary definitions of
  // a revisited block must then execute again, not reuse last iteration's value.
  if (state.byteMemory) {
    state.byteMemory.chargeExecution(block.insts.length);
    for (const instruction of block.insts) if (instruction.dst) state.values.delete(instruction.dst.id);
  }
  for (const [id, value] of phiUpdates) state.values.set(id, value);


    for (const inst of block.insts || []) {
      state.executingInstruction = inst;
      if (state.byteMemory) {
        state.byteMemory.check();
        if (!BYTE_EXECUTION_OPS.has(inst.op)) throw new QueryFailure('unsupported-instruction');
      }
      if (state.byteMemory) state.byteMemory.chargeExecution();
      if (state.byteMemory && state.steps >= maxSteps) { paths.push(stopResult(state, 'step-budget', inst)); transferred = true; break; }
      state.steps++;
      stats.stepsPerPath = Math.max(stats.stepsPerPath, state.steps);
      if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget', inst)); transferred = true; break; }

      if (inst.op === OP.LOAD) {
        if (!inst.dst || !inst.loc) {
          paths.push(stopResult(state, 'unsupported-load', inst)); transferred = true; break;
        }
        if (state.byteMemory) registerExecutionValue(inst.dst, state);
        const value = loadExpression(inst, state, opts);
        if (value.kind === SYM.UNKNOWN) {
          paths.push(stopResult(state, value.reason, inst)); transferred = true; break;
        }
        state.values.set(inst.dst.id, value);
        continue;
      }
      if (inst.op === OP.STORE && state.byteMemory) {
        const value = translateMemoryAccess(inst, state, opts);
        state.touchedFields.push({ instructionId: inst.id, value });
        continue;
      }
      if (inst.op === OP.STORE) {
        if (!inst.loc || inst.loc.kind === MK.UNKNOWN) {
          paths.push(stopResult(state, 'unknown-store-alias', inst)); transferred = true; break;
        }
        const key = locationKey(inst.loc);
        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-store-value');
        for (const [knownKey, remembered] of Array.from(state.memory.entries())) {
          const knownLocation = remembered && remembered.location ? remembered.location : null;
          if (!knownLocation || mayAliasProvenance(knownLocation, inst.loc)) state.memory.delete(knownKey);
        }
        if (key) state.memory.set(key, { location: inst.loc, value });
        if (inst.loc.kind === MK.FIELD || inst.loc.kind === MK.GLOBAL) {
          state.touchedFields.push({ key, location: inst.loc, row: inst.row, address: inst.address, value, valueText: expressionText(value) });
        }
        continue;
      }
      if (inst.op === OP.CALL) {
        if (state.byteMemory) {
          state.byteMemory.barrier('unknown-call');
          if (inst.dst) state.taint?.value(semanticValueIdentity(inst.dst), [], 'unknown-call', { unknown: true });
        }
        paths.push(stopResult(state, 'unsupported-call', inst)); transferred = true; break;
      }
      if (inst.op === OP.UNKNOWN || inst.op === OP.CLOBBER) {
        state.byteMemory?.barrier('unknown-clobber');
        paths.push(stopResult(state, 'unsupported-instruction', inst)); transferred = true; break;
      }
      if (state.byteMemory && inst.dst && ![OP.PHI, OP.RET, OP.CBR, OP.BR].includes(inst.op)) {
        state.values.delete(inst.dst.id);
        const translated = evalValue(inst.dst, state, ir, opts, new Map(), new Set());
        if (!translated?.sort || translated.kind === 'unknown_semantic') throw new QueryFailure(translated?.reason ?? 'unsupported-value-op');
        state.byteMemory.validateExpression(translated);
        state.values.set(inst.dst.id, translated);
      }
      if (inst.op === OP.RET) {
        const explicit = inst.args[0]?.value || null;
        let candidate = explicit;
        let inferredReturn = false;
        if (!candidate) {
          const terminal = valueBefore(ir, inst, 'x0');
          // Keep #130's ABI truth intact: RET has no implicit x0 operand. The
          // symbolic layer may expose a local terminal x0 expression only when
          // it was actually defined inside this function and evaluates to a
          // non-constant expression. This preserves field/dataflow experiments
          // while refusing the weakest `mov x0,#imm; ret` void-like ambiguity.
          if (terminal?.def && terminal.kind !== 'arg' && terminal.def.row != null && inst.row != null && terminal.def.row < inst.row) {
            const evaluated = evalValue(terminal, state, ir, opts, memo, new Set());
            if (evaluated && evaluated.kind !== SYM.UNKNOWN && evaluated.kind !== SYM.CONST) {
              candidate = terminal; inferredReturn = true;
            }
          }
        }
        const value = candidate ? evalValue(candidate, state, ir, opts, memo, new Set()) : null;
        if (state.byteMemory && value) state.byteMemory.validateExpression(value);
        const observations = state.byteMemory ? observeTerminalMemory(opts._memoryObservations, state, opts) : null;
        paths.push({
          ...(observations ? {memoryObservations:observations} : {}),
          status: value && (value.kind === SYM.UNKNOWN || value.kind === 'unknown_semantic') ? 'unknown' : 'complete',
          reason: value && (value.kind === SYM.UNKNOWN || value.kind === 'unknown_semantic') ? value.reason : null,
          ...(opts._executionCapture ? {snapshot:opts._executionCapture.capture(state,paths.length,observations)} : {}),
          returnValue: value,
          returnText: expressionText(value),
          returnInferred: inferredReturn,
          constraints: state.constraints.slice(),
          constraintText: state.constraints.map(expressionText),
          takenBranches: state.branches.slice(),
          touchedFields: state.touchedFields.slice(),
        });
        transferred = true;
        break;
      }
      if (inst.op === OP.CBR) {
        if (state.byteMemory && branchCount >= maxBranches) { paths.push(stopResult(state, 'branch-budget', inst)); transferred = true; break; }
        if (state.taint) state.control = state.taint.joinHandles(state.control, ...(inst.args || []).map(a => semanticValueIdentity(a.value)));
        stats.branches++;
        if (++branchCount > maxBranches) { paths.push(stopResult(state, 'branch-budget', inst)); transferred = true; break; }
        const cond = branchCondition(inst, state, ir, opts, memo);
        if (state.byteMemory && (cond.kind === 'unknown_semantic' || cond.sort?.kind !== 'bool')) throw new QueryFailure(cond.reason ?? 'unsupported-branch-condition');
        if (cond.kind === SYM.UNKNOWN) { paths.push(stopResult(state, cond.reason, inst)); transferred = true; break; }
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null || next.fallthrough == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        const inverse = cond.sort && cond.kind === 'const' ? Object.freeze({ ...cond, value: !cond.value }) : negate(cond);
        if (state.byteMemory) {
          const needed = Number(constraintAllowed(state.constraints, cond)) + Number(constraintAllowed(state.constraints, inverse));
          if (paths.length + queue.length + needed > maxPaths) throw new QueryFailure('budget:paths');
        }
        if (constraintAllowed(state.constraints, cond)) {
          const yes = cloneState(state);
          yes.prevBlock = state.block; yes.block = next.target;
          yes.constraints.push(cond);
          yes.branches.push({ row: inst.row, address: inst.address, taken: true, condition: expressionText(cond) });
          queue.push(yes);
        }
        if (constraintAllowed(state.constraints, inverse)) {
          const no = cloneState(state);
          no.prevBlock = state.block; no.block = next.fallthrough;
          no.constraints.push(inverse);
          no.branches.push({ row: inst.row, address: inst.address, taken: false, condition: expressionText(inverse) });
          queue.push(no);
        }
        transferred = true;
        break;
      }
      if (inst.op === OP.BR) {
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        state.prevBlock = state.block; state.block = next.target; queue.push(state);
        transferred = true;
        break;
      }
    }

    if (!transferred) {
      const succ = block.succ || [];
      if (succ.length === 1) {
        state.prevBlock = state.block; state.block = succ[0]; queue.push(state);
      } else if (!succ.length) paths.push(stopResult(state, 'fell-off-function'));
      else paths.push(stopResult(state, 'ambiguous-control-flow'));
    }
  }
  if (queue.length) truncated = true;
  return { paths, truncated, engine: 'semantic-ir-symbolic', ...(opts?._byteMemory ? { metrics: { ...stats, paths: paths.length } } : {}) };
}
/** Opt-in query identity preserves the legacy facade while enabling canonical byte state.
 * No results of a cancelled/stale/budgeted exploration are published as complete paths.
 */
export function symbolicExecute(ir, opts = {}) {
  if (opts == null) opts = {};
  if (!opts.byteMemory) return executePaths(ir, opts);
  const started = monotonicNow();
  let memory, capture;
  const executionMetrics = { paths: 0, stepsPerPath: 0, branches: 0, blockVisitsPerBlock: 0 };
  try {
    const timeoutMs = Math.min(
      boundedLimit(opts.timeoutMs, 250, 5000, 'timeoutMs'),
      boundedLimit(opts.byteMemory.timeoutMs, 250, 5000, 'byteMemory.timeoutMs'));
    const memoryOptions = { ...opts.byteMemory, timeoutMs, signal: opts.signal ?? opts.byteMemory.signal,
      isCancelled: opts.isCancelled ?? opts.byteMemory.isCancelled };
    memory = opts.byteMemory.initialState == null ? createByteMemory(memoryOptions)
      : forkByteMemoryForExecution(opts.byteMemory.initialState, memoryOptions);
    // The caller cannot change canonical argument bindings during execution.
    let argumentExpressions;
    if (opts.argumentExpressions != null) {
      if (Object.getPrototypeOf(opts.argumentExpressions) !== Map.prototype) throw new QueryFailure('invalid-canonical-arguments');
      const count = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(opts.argumentExpressions);
      memory.chargeExecution(count, count);
      argumentExpressions = new Map(Map.prototype.entries.call(opts.argumentExpressions));
      for (const expression of argumentExpressions.values()) memory.validateExpression(expression);
    }
    opts = { ...opts, argumentExpressions };
    const memoryAssumptions = new Map();
    // Validate data properties before preflight reads any caller-owned IR field.
    capture = createExecutionCapture(ir, memory, {...opts, memoryAssumptions});
    if (!ir || !Array.isArray(ir.blocks) || !ir.blocks.length) throw new QueryFailure('invalid-or-empty-ir');
    // Preflight limits precede address-map construction and operand-array copies.
    memory.chargeExecution(ir.blocks.length, ir.blocks.length);
    for (const block of ir.blocks) {
      if (!block || !Array.isArray(block.insts) || !Array.isArray(block.succ ?? [])) throw new QueryFailure('invalid-ir-block');
      const phis = block.phis ?? [];
      if (!Array.isArray(phis)) throw new QueryFailure('invalid-ir-phis');
      memory.chargeExecution(block.insts.length + phis.length + (block.succ?.length ?? 0), block.insts.length + phis.length);
      for (const list of [block.insts, phis]) for (const inst of list) {
        if (!inst || !Array.isArray(inst.args ?? []) || !Array.isArray(inst.incoming ?? [])) throw new QueryFailure('invalid-ir-instruction');
        memory.chargeExecution((inst.args?.length ?? 0) + (inst.incoming?.length ?? 0));
      }
    }
    const validatedAddressMap = validateExecutionContract(ir, memory);
    const observations = prepareMemoryObservations(opts.memoryObservations, memory);
    const semanticValues=new Map();
    if (ir.values!=null && !Array.isArray(ir.values)) throw new QueryFailure('invalid-ir-values');
    memory.chargeExecution(ir.values?.length??0,ir.values?.length??0);
    for(const value of ir.values??[]) {
      for(const key of [value?.semanticValueId,value?.semanticSsaValueId]) if(key!=null) {
        if(typeof key!=='string' || !key || key.length>1024) throw new QueryFailure('invalid-semantic-value-id');
        if(semanticValues.has(key) && semanticValues.get(key)!==value) throw new QueryFailure('ambiguous-semantic-address-value');
        semanticValues.set(key,value);
      }
    }
    if (opts.byteMemory.accessSemantics != null && opts.byteMemory.accessSemantics !== 'canonical-normal-completion') throw new QueryFailure('unsupported-memory-access-semantics');
    const result = executePaths(ir, { ...opts, _sourceIr:ir, _memoryAssumptions:memoryAssumptions, _byteMemory: memory, _executionMetrics: executionMetrics, _semanticValues:semanticValues, _addressMap:validatedAddressMap, _memoryObservations:observations, _executionCapture:opts.captureValues?capture:null });
    capture?.check();
    memory.check();
    const partial = result.truncated || result.paths.some(path => path.status !== 'complete');
    const metrics = Object.freeze({ ...memory.metrics(), ...result.metrics, wallClock: monotonicNow() - started });
    const paths = partial ? [] : result.paths.map(path => Object.freeze({ ...path,
      constraints: Object.freeze(path.constraints), constraintText: Object.freeze(path.constraintText),
      takenBranches: Object.freeze(path.takenBranches.map(Object.freeze)),
      touchedFields: Object.freeze(path.touchedFields.map(Object.freeze)) }));
    return capture.publish(Object.freeze({ ...result, assumptions:Object.freeze([...memoryAssumptions.values()]), memoryObservationRequests:observations, identity: memory.identity, status: partial ? 'partial' : 'complete',
      reason: partial ? (result.paths.find(path => path.status !== 'complete')?.reason ?? 'budget:exploration') : null, paths: Object.freeze(paths), metrics }));
  } catch (error) {
    if (!(error instanceof QueryFailure)) throw error;
    const failure = reason => Object.freeze({ engine: 'semantic-ir-symbolic', status: 'partial', reason,
      identity: memory?.identity ?? null, paths: Object.freeze([]), truncated: true,
      metrics: Object.freeze({ ...(memory?.metrics() ?? {}), ...executionMetrics, wallClock: monotonicNow() - started }) });
    if (capture && !/budget|deadline|cancel|stale/.test(error.reason)) {
      try { return capture.publish(failure(error.reason)); }
      catch (publicationError) {
        if (!(publicationError instanceof QueryFailure)) throw publicationError;
        // Publication revalidates the IR and may itself exhaust the remaining
        // allowance. Do not escape or issue a capability after that failure.
        return failure(publicationError.reason);
      }
    }
    return failure(error.reason);
  }
}
