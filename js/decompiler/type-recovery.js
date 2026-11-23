/*
 * Typed Semantic IR recovery for the decompiler.
 * Type recovery is evidence fusion: width alone never implies pointer identity.
 */

import { OP, MK, COND } from '../ir.js';
import { abiAdapterForIr } from '../ir-core.js';
import { currentCppReceiver } from './cxx-evidence.js';
import { knownCallPrototype, knownCallSignature } from './call-prototypes.js';

const INTEGER_NAMES = new Map([
  ['8:s', 'int8'], ['8:u', 'uint8'], ['16:s', 'int16'], ['16:u', 'uint16'],
  ['32:s', 'int32'], ['32:u', 'uint32'], ['64:s', 'int64'], ['64:u', 'uint64'],
]);

// Known standard-library callees whose GP argument slots accept `const char *`.
const VARIADIC_FORMAT_SPECS = new Map([
  ['printf', { fmtArgIdx: 0, fixedArgs: 1, family: 'printf' }],
  ['fprintf', { fmtArgIdx: 1, fixedArgs: 2, family: 'printf' }],
  ['sprintf', { fmtArgIdx: 1, fixedArgs: 2, family: 'printf' }],
  ['snprintf', { fmtArgIdx: 2, fixedArgs: 3, family: 'printf' }],
  ['dprintf', { fmtArgIdx: 1, fixedArgs: 2, family: 'printf' }],
  ['asprintf', { fmtArgIdx: 1, fixedArgs: 2, family: 'printf' }],
  ['sprintf_chk', { fmtArgIdx: 3, fixedArgs: 4, family: 'printf' }],
  ['snprintf_chk', { fmtArgIdx: 4, fixedArgs: 5, family: 'printf' }],
  ['scanf', { fmtArgIdx: 0, fixedArgs: 1, family: 'scanf' }],
  ['fscanf', { fmtArgIdx: 1, fixedArgs: 2, family: 'scanf' }],
  ['sscanf', { fmtArgIdx: 1, fixedArgs: 2, family: 'scanf' }],
  ['isoc99_scanf', { fmtArgIdx: 0, fixedArgs: 1, family: 'scanf' }],
  ['isoc99_fscanf', { fmtArgIdx: 1, fixedArgs: 2, family: 'scanf' }],
  ['isoc99_sscanf', { fmtArgIdx: 1, fixedArgs: 2, family: 'scanf' }],
]);

function countFormatSpecifiers(fmt, family = 'printf') {
  if (typeof fmt !== 'string') return null;
  let gp = 0;
  let fp = 0;
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') { i++; continue; }
    i++;
    if (i >= fmt.length) return null;
    if (fmt[i] === '%') { i++; continue; }
    if (family === 'scanf') {
      let suppressed = false;
      if (fmt[i] === '*') { suppressed = true; i++; }
      // Reject positional arguments (%1$d)
      if (i < fmt.length && fmt[i] >= '1' && fmt[i] <= '9') {
        let j = i;
        while (j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9') j++;
        if (fmt[j] === '$') return null;
      }
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i++;
      if (i + 1 < fmt.length && (fmt.slice(i, i + 2) === 'hh' || fmt.slice(i, i + 2) === 'll')) i += 2;
      else if (i < fmt.length && 'hljztL'.includes(fmt[i])) i++;
      if (i >= fmt.length) return null;
      const conv = fmt[i++];
      if (conv === '[') {
        if (i < fmt.length && fmt[i] === '^') i++;
        if (i < fmt.length && fmt[i] === ']') i++;
        while (i < fmt.length && fmt[i] !== ']') i++;
        if (i >= fmt.length) return null;
        i++;
        if (!suppressed) gp++;
      } else if ('diuoxXaAeEfFgGcspn'.includes(conv)) {
        if (!suppressed) gp++;
      } else {
        return null;
      }
      continue;
    }
    while (i < fmt.length && "-+ #0'".includes(fmt[i])) i++;
    if (i < fmt.length && fmt[i] >= '1' && fmt[i] <= '9') {
      let j = i;
      while (j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9') j++;
      if (fmt[j] === '$') return null;
    }
    if (i < fmt.length && fmt[i] === '*') {
      gp++;
      i++;
    } else {
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i++;
    }
    if (i < fmt.length && fmt[i] === '.') {
      i++;
      if (i < fmt.length && fmt[i] === '*') {
        gp++;
        i++;
      } else {
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i++;
      }
    }
    if (i + 1 < fmt.length && (fmt.slice(i, i + 2) === 'hh' || fmt.slice(i, i + 2) === 'll')) i += 2;
    else if (i < fmt.length && 'hljztL'.includes(fmt[i])) i++;
    if (i >= fmt.length) return null;
    const conv = fmt[i++];
    if ('aAeEfFgG'.includes(conv)) fp++;
    else if ('diuoxXcspn'.includes(conv)) gp++;
    else return null;
  }
  return { gp, fp };
}

function resolveConstantAddressOfValue(val, depth = 0, seen = null) {
  if (!val || depth > 8) return null;
  const visited = seen || new Set();
  if (val.id != null) {
    if (visited.has(val.id)) return null;
    visited.add(val.id);
  }
  if (val.const != null) {
    try { return BigInt(val.const); } catch { /* ignore */ }
  }
  const def = val.def;
  if (!def) return null;
  if (def.op === OP.ADDR || def.op === OP.CONST) {
    const raw = def.extra?.value ?? def.extra?.target ?? null;
    if (raw != null) {
      try { return BigInt(raw); } catch { /* ignore */ }
    }
  }
  if (def.op === OP.MOV) {
    return resolveConstantAddressOfValue(valueOf(def.args?.[0]), depth + 1, visited);
  }
  if (def.op === OP.BIN && (def.sub === 'add' || def.sub === 'sub')) {
    const a = resolveConstantAddressOfValue(valueOf(def.args?.[0]), depth + 1, visited);
    const b = resolveConstantAddressOfValue(valueOf(def.args?.[1]), depth + 1, visited);
    if (a != null && b != null) return def.sub === 'add' ? a + b : a - b;
  }
  return null;
}

const CONST_CHAR_PTR_PARAMS = new Map([
  ['strlen', [0]],
  ['strcmp', [0, 1]],
  ['strncmp', [0, 1]],
  ['strchr', [0]],
  ['strrchr', [0]],
  ['strstr', [0, 1]],
  ['strtod', [0]],
  ['strtol', [0]],
  ['atoi', [0]],
  ['strcpy', [1]],
  ['strdup', [0]],
]);

function evidence() {
  return {
    widths: new Map(), signed: 0, unsigned: 0, bool: 0, floating: 0,
    pointer: 0, object: 0, objc: 0, swift: 0, fnptr: 0, closure: 0,
    array: 0, nullable: null, nominal: null, enumName: null, structName: null,
    sources: [],
  };
}
function addSource(e, source, weight = 1) { if (e && source && e.sources.length < 16) e.sources.push({ source, weight }); }
function width(e, bits, weight = 1, source = null) {
  bits = Number(bits || 0);
  if (!e || ![8, 16, 32, 64, 128].includes(bits)) return;
  e.widths.set(bits, (e.widths.get(bits) || 0) + weight);
  addSource(e, source || `width:${bits}`, weight);
}
function score(e, key, weight, source) {
  if (!e) return;
  e[key] = (e[key] || 0) + weight;
  addSource(e, source, weight);
}
function valueOf(arg) { return arg && arg.value ? arg.value : null; }
function bestWidth(e, fallback = 64) {
  let bits = fallback, best = -1;
  for (const [b, s] of e.widths) if (s > best) { bits = b; best = s; }
  return bits;
}
function confidence(top, second, base = 0.5) {
  if (!(top > 0)) return 0.25;
  const margin = Math.max(0, top - Math.max(0, second));
  return Math.min(0.98, base + Math.min(0.42, margin / Math.max(3, top + 2)));
}

export function typeNameOf(t) {
  if (!t) return 'unknown';
  if (typeof t === 'string') return t;
  if (t.name) return t.name;
  if (t.kind === 'pointer') return (t.pointee || 'void') + ' *';
  if (t.kind === 'objc') return (t.className || 'id') + (t.className ? ' *' : '');
  if (t.kind === 'swift') return t.nominal || 'SwiftObject *';
  return 'unknown';
}

export function mergeRecoveredTypes(a, b) {
  if (!a) return b;
  if (!b) return a;
  const flatten = (t) => {
    if (!t) return [];
    if (t.kind === 'ambiguous' && Array.isArray(t.candidates) && t.candidates.length) {
      return t.candidates.flatMap((x) => x && x.kind === 'ambiguous' && Array.isArray(x.candidates) && x.candidates.length ? x.candidates : [x]).filter(Boolean);
    }
    return [t];
  };
  const byName = new Map();
  for (const candidate of [...flatten(a), ...flatten(b)]) {
    if (!candidate || (candidate.name === 'unknown' && candidate.kind !== 'ambiguous')) continue;
    const key = candidate.name || candidate.kind || 'unknown';
    const prev = byName.get(key);
    if (!prev || (candidate.confidence || 0) > (prev.confidence || 0)) byName.set(key,candidate);
  }
  if (!byName.size) return b || a;
  const all = [...byName.values()].sort((x,y)=>(y.confidence||0)-(x.confidence||0));
  if (all.length === 1) return { ...all[0], candidates:all };
  const top=all[0], second=all[1], ac=top.confidence||0, bc=second.confidence||0;
  if (Math.abs(ac-bc) < 0.12) return { name:'unknown',kind:'ambiguous',confidence:Math.max(ac,bc)*0.7,candidates:all,warning:'conflicting type evidence: '+all.map((x)=>x.name).join(' vs ') };
  return { ...top, candidates:all };
}

function decide(e, fallbackBits = 64) {
  const bits = bestWidth(e, fallbackBits), signed = e.signed, unsigned = e.unsigned;
  const candidates = [];
  const push = (name, kind, s, extra = {}) => candidates.push({ name, kind, score:s, ...extra });
  if (e.nominal) {
    const k = e.objc >= e.swift ? 'objc' : 'swift';
    push(k === 'objc' ? `${e.nominal} *` : e.nominal, k, 12 + e.objc + e.swift, k === 'objc' ? {className:e.nominal} : {nominal:e.nominal});
  }
  if (e.closure) push('closure', 'closure', e.closure + e.pointer + 2);
  if (e.fnptr) push('function *', 'function-pointer', e.fnptr + e.pointer + 1);
  if (e.objc) push('id', 'objc', e.objc + e.object + e.pointer + 1);
  if (e.swift) push('SwiftObject *', 'swift', e.swift + e.object + e.pointer + 1);
  if (e.pointer || e.object) push('void *', 'pointer', e.pointer + e.object);
  if (e.floating) push(bits <= 32 ? 'float' : 'double', 'float', e.floating + 1);
  if (e.bool) push('bool', 'bool', e.bool + Math.max(0, 2 - Math.max(signed, unsigned)));
  if (e.enumName) push(e.enumName, 'enum', 7, { enumName:e.enumName });
  if (e.structName) push(e.structName, 'struct', 7, { structName:e.structName });
  const signKnown = Math.max(signed, unsigned) >= 2 || Math.abs(signed - unsigned) >= 2;
  const isSigned = signKnown ? signed > unsigned : null;
  const intName = INTEGER_NAMES.get(`${bits}:${isSigned === false ? 'u' : 's'}`) || (bits > 32 ? 'int64' : 'int32');
  push(intName, 'integer', Math.max(1, signed, unsigned), { bits, signed:isSigned });
  candidates.sort((x, y) => y.score - x.score);
  const top = candidates[0], next = candidates[1];
  if (!top) return { name:'unknown', kind:'unknown', bits, confidence:0.2, evidence:e.sources };
  if (top.kind === 'integer' && signed === 0 && unsigned === 0 && e.bool === 0 && e.floating === 0) { top.name = 'unknown'; top.kind = 'unknown'; }
  return { ...top, bits, nullable:e.nullable, confidence:confidence(top.score, next ? next.score : 0, top.kind === 'unknown' ? 0.25 : 0.5), evidence:e.sources.slice(), candidates:candidates.slice(0, 4).map(({score:_score, ...c}) => c) };
}

function branchSignedness(ir) {
  const signedCmpIds = new Set(), unsignedCmpIds = new Set();
  for (const inst of (ir && ir.instructions) || []) {
    if (inst.op !== OP.CBR || !inst.cond) continue;
    const info = COND[inst.cond];
    if (!info || info.signed == null) continue;
    const flagsArg = (inst.args || []).find((a) => a && a.value && a.value.reg === 'nzcv');
    const cmp = flagsArg && flagsArg.value && flagsArg.value.def;
    if (!cmp || cmp.op !== OP.CMP) continue;
    (info.signed ? signedCmpIds : unsignedCmpIds).add(cmp.id);
  }
  return { signedCmpIds, unsignedCmpIds };
}

function blockDominates(ir, from, to) {
  if (from === to) return true;
  const dom = ir.dominators?.[to];
  if (dom && typeof dom.has === 'function') return dom.has(from);
  let cur = to, guard = 0;
  while (cur != null && cur >= 0 && guard++ <= (ir.blocks?.length || 0) + 1) {
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
    if (cur === from) return true;
  }
  return false;
}

const TYPE_REACH_CACHE = new WeakMap();

function getTypeReachIndex(ir) {
  const values = ir?.values || [];
  const blocks = ir?.blocks || [];
  const cached = TYPE_REACH_CACHE.get(ir);
  if (cached && cached.valuesLen === values.length && cached.blocksLen === blocks.length && cached.idomRef === ir.idom) {
    return cached;
  }
  const valuesByReg = new Map();
  for (const value of values) {
    if (!value?.reg || !value.def) continue;
    let list = valuesByReg.get(value.reg);
    if (!list) { list = []; valuesByReg.set(value.reg, list); }
    list.push(value);
  }
  const entry = {
    valuesLen: values.length,
    blocksLen: blocks.length,
    idomRef: ir.idom,
    valuesByReg,
    domDepth: new Int32Array(blocks.length),
  };
  TYPE_REACH_CACHE.set(ir, entry);
  return entry;
}

function getTypeDomDepth(ir, domDepth, block) {
  if (block == null || block < 0) return 0;
  if (block < domDepth.length && domDepth[block] > 0) return domDepth[block];
  const maxSteps = (ir.blocks?.length || 0) + 1;
  let depth = 0, cur = block, guard = 0;
  const path = [];
  while (cur != null && cur >= 0 && guard++ <= maxSteps) {
    if (cur < domDepth.length && domDepth[cur] > 0) {
      depth += domDepth[cur];
      break;
    }
    path.push(cur);
    depth++;
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
  }
  if (guard <= maxSteps) {
    for (let i = 0; i < path.length; i++) {
      const b = path[i];
      if (b >= 0 && b < domDepth.length) domDepth[b] = depth - i;
    }
  }
  return depth;
}

/** The SSA value of a physical register that reaches this exact call site. */
export function reachingRegisterTypeValue(ir, atInst, reg) {
  if (!ir || !atInst || !reg) return null;
  const { valuesByReg, domDepth } = getTypeReachIndex(ir);
  const regValues = valuesByReg.get(reg) || [];
  let best = ir.args?.get?.(reg) || null;
  let bestDepth = -1;
  let bestRow = -1;
  for (const value of regValues) {
    if (value.reg !== reg || !value.def || value.clobbered) continue;
    const def = value.def;
    if (def === atInst) continue;
    if (def.block === atInst.block) {
      if (def.row == null || atInst.row == null || def.row >= atInst.row) continue;
      const rank = 1_000_000 + def.row;
      if (rank > bestDepth) { best = value; bestDepth = rank; bestRow = def.row; }
      continue;
    }
    if (!blockDominates(ir, def.block, atInst.block)) continue;
    const depth = getTypeDomDepth(ir, domDepth, def.block);
    const row = def.row ?? -1;
    if (depth > bestDepth || (depth === bestDepth && row > bestRow)) {
      best = value;
      bestDepth = depth;
      bestRow = row;
    }
  }
  return best;
}

/*
 * Distinguish genuine uses of an incoming argument register from dead SSA
 * bookkeeping (self-looping/dead PHIs, dead register copies, clobber markers,
 * or live-through argument slots past a known fixed-arity callee's signature).
 */
function buildCallDominanceIndex(ir) {
  const firstCallRowByBlock = new Map();
  const callBlocks = [];
  const callBlockSet = new Set();
  for (const inst of ir?.instructions || []) {
    if (!inst || inst.op !== OP.CALL) continue;
    const blk = inst.block ?? null;
    if (inst.row != null) {
      const prev = firstCallRowByBlock.get(blk);
      if (prev == null || inst.row < prev) firstCallRowByBlock.set(blk, inst.row);
    }
    if (blk != null && !callBlockSet.has(blk)) {
      callBlockSet.add(blk);
      callBlocks.push(blk);
    }
  }
  return { firstCallRowByBlock, callBlocks };
}

function dominatedByEarlierCall(ir, atInst, callIndex = null) {
  if (!ir || !atInst) return false;
  const { firstCallRowByBlock, callBlocks } = callIndex || buildCallDominanceIndex(ir);
  const blk = atInst.block ?? null;
  if (atInst.row != null) {
    const firstRow = firstCallRowByBlock.get(blk);
    if (firstRow != null && firstRow < atInst.row) return true;
  }
  if (atInst.block != null) {
    for (const cb of callBlocks) {
      if (cb !== atInst.block && blockDominates(ir, cb, atInst.block)) return true;
    }
  }
  return false;
}

function hasRealValueUse(value, ir, visited = new Set(), resolveCalleeName = null, callCtx = null, allowPhi = true) {
  if (!value || visited.has(value)) return false;
  visited.add(value);
  const uses = Array.isArray(value.uses) ? value.uses : [];
  for (const inst of uses) {
    if (!inst) continue;
    if (inst.op === OP.CLOBBER) continue;
    if (inst.op === OP.PHI) {
      if (!allowPhi) continue;
      if (inst.dst && hasRealValueUse(inst.dst, ir, visited, resolveCalleeName, callCtx, true)) return true;
      continue;
    }
    if (inst.op === OP.MOV) {
      if (inst.dst && hasRealValueUse(inst.dst, ir, visited, resolveCalleeName, callCtx, allowPhi)) return true;
      continue;
    }
    if (inst.op === OP.CALL) {
      if (!value.def && dominatedByEarlierCall(ir, inst, callCtx?.callIndex)) continue;
      const name = resolveCalleeName
        ? resolveCalleeName(inst)
        : String((inst.extra && inst.extra.name) || (inst.insn && inst.insn.callName) || '');
      const proto = knownCallPrototype(name);
      if (proto && !inst.extra?.indirect) {
        if (!proto.variadic) {
          const callArgs = Array.isArray(inst.args) ? inst.args : [];
          const matchedIdx = callArgs.findIndex((a) => valueOf(a) === value);
          if (matchedIdx >= proto.arity) continue;
          if (matchedIdx < 0 && typeof value.reg === 'string') {
            if (callCtx ? callCtx.isAArch64ArgSet : true) {
              const rm = /^[xdsvq](\d+)$/.exec(value.reg);
              if (rm && Number(rm[1]) >= proto.arity) continue;
            } else if (Array.isArray(callCtx.argumentRegisters) && callCtx.argumentRegisters.length) {
              const argIdx = callCtx.argumentRegisters.indexOf(value.reg);
              if (argIdx >= proto.arity) continue;
            }
          }
        } else if (callCtx?.variadicArity) {
          const bounds = callCtx.variadicArity(inst, proto);
          if (bounds) {
            const isA64 = callCtx.isAArch64ArgSet;
            if (typeof value.reg === 'string') {
              if (isA64) {
                const fpM = /^[dsvq](\d+)$/.exec(value.reg);
                if (fpM) {
                  if (Number(fpM[1]) >= bounds.fpArity) continue;
                } else {
                  const gpM = /^[xw](\d+)$/.exec(value.reg);
                  if (gpM && Number(gpM[1]) >= bounds.gpArity) continue;
                }
              } else if (Array.isArray(callCtx.argumentRegisters) && callCtx.argumentRegisters.length) {
                const argIdx = callCtx.argumentRegisters.indexOf(value.reg);
                if (argIdx >= bounds.gpArity) continue;
              }
            } else {
              const callArgs = Array.isArray(inst.args) ? inst.args : [];
              const matchedIdx = callArgs.findIndex((a) => valueOf(a) === value);
              if (matchedIdx >= bounds.gpArity) continue;
            }
          }
        }
      }
      return true;
    }
    return true;
  }
  return false;
}

function applyRuntimeHints(ir, evidences, runtime) {
  if (!runtime) return;
  const hints = runtime.valueTypes || runtime.typesByValue || null;
  if (hints && typeof hints.get === 'function') {
    for (const v of ir.values || []) {
      const h = hints.get(v.id) || hints.get(v.vid) || hints.get(v);
      if (!h) continue;
      const e = evidences.get(v.id);
      if (!e) continue;
      const origin = h.runtime || h.origin || h.kind;
      if (origin === 'objc') score(e, 'objc', 8, 'Objective-C runtime metadata');
      if (origin === 'swift') score(e, 'swift', 8, 'Swift runtime metadata');
      if (h.className || h.nominal || h.name) e.nominal = h.className || h.nominal || h.name;
      if (h.nullable != null) e.nullable = !!h.nullable;
    }
  }
}

export function inferSemanticTypes(ir, model, opts = {}) {
  if (!ir) return { args:[], locals:[], ret:{type:'void',conf:0.2}, values:new Map(), locations:new Map(), warnings:['Semantic IR unavailable'] };
  const effectiveAbiAdapter = opts.abiAdapter != null ? opts.abiAdapter : abiAdapterForIr(ir);
  const legacyAArch64 = opts.legacyAArch64 === true
    || (!effectiveAbiAdapter && ir?.compat?.projection !== 'semantic-ir-v2-to-v1');
  const argumentRegisters = effectiveAbiAdapter?.supported === true
    ? (effectiveAbiAdapter.argumentRegisters?.() ?? [])
    : legacyAArch64
      ? Array.from({ length:8 }, (_unused, i) => `x${i}`)
      : [];
  const firstArgumentRegister = argumentRegisters[0] ?? null;
  const isAArch64ArgSet = argumentRegisters.length > 0 && argumentRegisters[0] === 'x0';
  const ev = new Map(), locEv = new Map();
  const eFor = (v) => { if (!v) return null; if (!ev.has(v.id)) ev.set(v.id, evidence()); return ev.get(v.id); };
  const lFor = (loc) => { if (!loc) return null; if (!locEv.has(loc.key)) locEv.set(loc.key, evidence()); return locEv.get(loc.key); };
  for (const v of ir.values || []) {
    const e = eFor(v); width(e, v.bits || 64, 0.5, 'SSA value width');
    if (v.signed === true) score(e, 'signed', 3, 'IR signedness');
    if (v.signed === false) score(e, 'unsigned', 3, 'IR unsignedness');
    if (v.nullable != null) e.nullable = !!v.nullable;
    if (isAArch64ArgSet && typeof v.reg === 'string') {
      if (/^d\d+$/.test(v.reg)) {
        score(e, 'floating', 2, 'scalar double register');
        width(e, 64, 1, 'scalar double register width');
      } else if (/^s\d+$/.test(v.reg)) {
        score(e, 'floating', 2, 'scalar float register');
        width(e, 32, 1, 'scalar float register width');
      }
    }
  }

  const modelCallByRow = new Map();
  for (const c of (model && model.calls) || []) {
    if (c && c.row != null && !modelCallByRow.has(c.row)) modelCallByRow.set(c.row, c);
  }
  const calleeNameOf = (inst) => {
    if (!inst) return '';
    const mc = inst.row != null ? modelCallByRow.get(inst.row) : null;
    return String(
      (inst.extra && (inst.extra.name || inst.extra.targetName))
      || (inst.insn && (inst.insn.callName || inst.insn.targetName))
      || (mc && (mc.name || mc.targetName))
      || ''
    );
  };
  const callIndex = buildCallDominanceIndex(ir);
  const variadicArityCache = new Map();
  const resolveStaticFormatString = (val) => {
    if (!val) return null;
    if (typeof val.extra?.stringLiteral === 'string') return val.extra.stringLiteral;
    if (typeof val.def?.extra?.stringLiteral === 'string') return val.def.extra.stringLiteral;
    if (typeof val.def?.extra?.string === 'string') return val.def.extra.string;
    const addr = resolveConstantAddressOfValue(val);
    if (addr != null) {
      try {
        const direct = opts?.stringFor?.(addr);
        if (typeof direct === 'string') return direct;
      } catch { /* optional resolver */ }
      for (const ref of model?.addressRefs || []) {
        if (ref?.addr == null || typeof ref.text !== 'string') continue;
        try { if (BigInt(ref.addr) === addr) return ref.text; } catch { /* malformed ref */ }
      }
    }
    const defRow = val.def?.row;
    if (defRow != null) {
      for (const ref of model?.addressRefs || []) {
        if (ref?.row === defRow && typeof ref.text === 'string') return ref.text;
      }
    }
    return null;
  };
  const variadicArity = (inst, proto) => {
    if (!inst || !proto) return null;
    if (variadicArityCache.has(inst)) return variadicArityCache.get(inst);
    const spec = VARIADIC_FORMAT_SPECS.get(proto.name);
    if (!spec) { variadicArityCache.set(inst, null); return null; }
    const fmtReg = argumentRegisters[spec.fmtArgIdx] ?? null;
    const fmtVal = (fmtReg ? reachingRegisterTypeValue(ir, inst, fmtReg) : null)
      ?? valueOf(inst.args?.[spec.fmtArgIdx]);
    const fmtStr = resolveStaticFormatString(fmtVal);
    const counts = fmtStr != null ? countFormatSpecifiers(fmtStr, spec.family) : null;
    const result = counts
      ? { gpArity: spec.fixedArgs + counts.gp, fpArity: counts.fp }
      : null;
    variadicArityCache.set(inst, result);
    return result;
  };
  const callUseCtx = { isAArch64ArgSet, argumentRegisters, callIndex, variadicArity };
  const callRetTypeToSemantic = (retType) => {
    if (retType === 'void') return 'void';
    if (retType === 'double') return 'double';
    if (retType === 'float') return 'float';
    if (retType === 'ptr') return 'void *';
    if (retType === 'size') return 'uint64';
    if (retType === 'long') return 'int64';
    if (retType === 'int') return 'int32';
    return 'uint64';
  };
  const callParamTypeToSemantic = (pType) => {
    if (pType === 'double') return 'double';
    if (pType === 'float') return 'float';
    if (pType === 'ptr') return 'void *';
    if (pType === 'size') return 'uint64';
    if (pType === 'long') return 'int64';
    if (pType === 'int') return 'int32';
    return 'uint64';
  };
  const hasEarlierOrNonDomRegDef = (atInst, regNames) => {
    const { valuesByReg } = getTypeReachIndex(ir);
    for (const rn of regNames) {
      const list = valuesByReg.get(rn);
      if (!list) continue;
      for (const v of list) {
        if (!v?.def || v.clobbered) continue;
        const def = v.def;
        if (def === atInst) continue;
        if (def.block === atInst.block) {
          if (def.row != null && atInst.row != null && def.row < atInst.row) return true;
          continue;
        }
        if (atInst.block != null && def.block != null && blockDominates(ir, atInst.block, def.block)) {
          continue;
        }
        return true;
      }
    }
    return false;
  };
  const passThroughGpArgs = new Map();
  const passThroughFpArgs = new Map();
  const passThroughRegs = new Set();
  const constCharPtrValueIds = new Set();
  const traceMovRoot = (val) => {
    let cur = val;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (cur.def?.op === OP.MOV && !cur.def.sub && cur.def.args?.[0]?.value) {
        cur = cur.def.args[0].value;
      } else {
        break;
      }
    }
    return cur;
  };
  const markConstCharPtrArg = (val) => {
    if (!val) return;
    if (val.id != null) constCharPtrValueIds.add(val.id);
    const root = traceMovRoot(val);
    if (root && root.id != null) constCharPtrValueIds.add(root.id);
  };
  const recordPassThroughForCall = (inst, name) => {
    if (!argumentRegisters.length || dominatedByEarlierCall(ir, inst, callIndex)) return;
    const callSig = knownCallSignature(name);
    const proto = callSig || knownCallPrototype(name);
    if (!proto || !proto.arity) return;
    const paramTypes = Array.isArray(callSig?.paramTypes) && callSig.paramTypes.length
      ? callSig.paramTypes
      : Array.from({ length: proto.arity }, () => null);
    let gpIdx = 0;
    let fpIdx = 0;
    for (const pType of paramTypes) {
      if (pType === 'double' || pType === 'float') {
        if (isAArch64ArgSet && fpIdx < 8) {
          const fpNames = pType === 'float' ? [`s${fpIdx}`, `d${fpIdx}`, `v${fpIdx}`] : [`d${fpIdx}`, `v${fpIdx}`];
          const fpAliases = [`d${fpIdx}`, `s${fpIdx}`, `v${fpIdx}`, `q${fpIdx}`];
          let fpVal = null;
          let matchedReg = fpNames[0];
          for (const rn of fpNames) {
            const rv = reachingRegisterTypeValue(ir, inst, rn);
            if (rv) { fpVal = rv; matchedReg = rn; break; }
          }
          const isIncoming = !hasEarlierOrNonDomRegDef(inst, fpAliases)
            && (fpVal ? (!fpVal.def && ir.args?.get?.(matchedReg) === fpVal) : true);
          if (isIncoming) {
            passThroughRegs.add(matchedReg);
            if (!passThroughFpArgs.has(fpIdx)) {
              passThroughFpArgs.set(fpIdx, { reg: matchedReg, type: pType, callName: proto.name, value: fpVal });
            }
          }
        }
        fpIdx++;
      } else {
        const gpRegName = argumentRegisters[gpIdx];
        if (gpRegName) {
          const gpAliases = isAArch64ArgSet && /^x(\d+)$/.test(gpRegName)
            ? [gpRegName, `w${gpRegName.slice(1)}`]
            : [gpRegName];
          const gpVal = reachingRegisterTypeValue(ir, inst, gpRegName);
          const isIncoming = !hasEarlierOrNonDomRegDef(inst, gpAliases)
            && (gpVal ? (!gpVal.def && ir.args?.get?.(gpRegName) === gpVal) : true);
          if (isIncoming) {
            const constCharIndices = CONST_CHAR_PTR_PARAMS.get(proto.name);
            const semanticParamType = constCharIndices?.includes(gpIdx) ? 'const char *' : callParamTypeToSemantic(pType);
            if (constCharIndices?.includes(gpIdx) && gpVal) markConstCharPtrArg(gpVal);
            passThroughRegs.add(gpRegName);
            if (!passThroughGpArgs.has(gpIdx)) {
              passThroughGpArgs.set(gpIdx, { reg: gpRegName, type: semanticParamType, callName: proto.name, value: gpVal });
            }
          }
        }
        gpIdx++;
      }
    }
  };
  const branches = branchSignedness(ir);
  for (const inst of ir.instructions || []) {
    const dst = eFor(inst.dst);
    if (dst && inst.dst) width(dst, inst.dst.bits || 64, 1, `row ${inst.row}: result width`);

    if (inst.op === OP.LOAD || inst.op === OP.STORE) {
      const le = lFor(inst.loc);
      const bits = Number(((inst.loc && inst.loc.size) || (inst.addr && inst.addr.size) || 8) * 8);
      width(le, bits, 3, `row ${inst.row}: memory access width`);
      if (inst.op === OP.LOAD && dst) width(dst, bits, 3, `row ${inst.row}: load width`);
      if (inst.op === OP.STORE) { const ve = eFor(valueOf(inst.args && inst.args[0])); if (ve) width(ve, bits, 2, `row ${inst.row}: store width`); }
      const base = inst.addr && inst.addr.base, be = eFor(base);
      if (be && !(inst.loc && inst.loc.kind === MK.STACK)) score(be, 'pointer', 5, `row ${inst.row}: used as memory base`);
      if (inst.addr && inst.addr.index) {
        const ie = eFor(inst.addr.index); if (ie) score(ie, 'unsigned', 1, `row ${inst.row}: address index`);
        if (le) score(le, 'array', 2, `row ${inst.row}: indexed access`);
      }
    }

    if (inst.op === OP.BIN) {
      const args = (inst.args || []).map(valueOf).filter(Boolean);
      const signedIntegerOp = /^s(div|mul)|ashr/.test(inst.sub || '');
      const unsignedIntegerOp = /^u(div|mul)|lshr/.test(inst.sub || '');
      if (signedIntegerOp) {
        for (const a of args) score(eFor(a), 'signed', 4, `row ${inst.row}: ${inst.sub}`);
        if (dst) score(dst, 'signed', 4, `row ${inst.row}: ${inst.sub} result`);
      }
      if (unsignedIntegerOp) {
        for (const a of args) score(eFor(a), 'unsigned', 4, `row ${inst.row}: ${inst.sub}`);
        if (dst) score(dst, 'unsigned', 4, `row ${inst.row}: ${inst.sub} result`);
      }
      if (/^f(add|sub|mul|div|min|max|madd|msub|nmadd|nmsub|rem)/.test(inst.sub || '')) {
        for (const a of args) score(eFor(a), 'floating', 5, `row ${inst.row}: ${inst.sub}`);
        if (dst) score(dst, 'floating', 5, `row ${inst.row}: ${inst.sub}`);
      }
      if (/^(and|or|xor|bic)$/.test(inst.sub || '') && inst.dst && inst.dst.bits === 1) score(dst, 'bool', 3, `row ${inst.row}: bitwise boolean`);
    }

    if (inst.op === OP.UN) {
      const a = eFor(valueOf(inst.args && inst.args[0]));
      if (/^sxt/.test(inst.sub || '')) score(a, 'signed', 5, `row ${inst.row}: sign extension`);
      if (/^uxt/.test(inst.sub || '')) score(a, 'unsigned', 5, `row ${inst.row}: zero extension`);
      const unSub = inst.sub || '';
      const isI2F = /^(?:i2f|scvtf)/.test(unSub);
      const isU2F = /^(?:u2f|ucvtf)/.test(unSub);
      const isF2I = /^(?:f2i|fcvt[zpmna]s)/.test(unSub);
      const isF2U = /^(?:f2u|fcvt[zpmna]u)/.test(unSub);
      if (!isF2I && !isF2U && /^f(abs|neg|sqrt|cvt|rint|floor|ceil|round|trunc)/.test(unSub)) {
        if (a) score(a, 'floating', 5, `row ${inst.row}: ${unSub}`);
        if (dst) score(dst, 'floating', 5, `row ${inst.row}: ${unSub}`);
      }
      // Numeric conversions type each side independently (#5494). i2f/u2f
      // (and AArch64 scvtf/ucvtf) prove the source's integer signedness and a
      // floating result; f2i/f2u (and AArch64 fcvtzs/fcvtzu) prove a floating
      // source and the result's integer signedness. Scoring the f2i/f2u source
      // as integer evidence inverted the conversion's meaning and left the
      // destination's signedness unrecovered.
      if (isI2F) { if (a) score(a, 'signed', 3, `row ${inst.row}: numeric conversion`); if (dst) score(dst, 'floating', 5, `row ${inst.row}: float conversion`); }
      if (isU2F) { if (a) score(a, 'unsigned', 3, `row ${inst.row}: numeric conversion`); if (dst) score(dst, 'floating', 5, `row ${inst.row}: float conversion`); }
      if (isF2I) { if (a) score(a, 'floating', 5, `row ${inst.row}: float conversion`); if (dst) score(dst, 'signed', 5, `row ${inst.row}: numeric conversion`); }
      if (isF2U) { if (a) score(a, 'floating', 5, `row ${inst.row}: float conversion`); if (dst) score(dst, 'unsigned', 5, `row ${inst.row}: numeric conversion`); }
    }

    if (inst.op === OP.CMP) {
      const args = (inst.args || []).map(valueOf).filter(Boolean);
      const isFloatCmp = /^fcmp/i.test(inst.sub || '');
      const signedBranch = branches.signedCmpIds.has(inst.id), unsignedBranch = branches.unsignedCmpIds.has(inst.id);
      for (const a of args) {
        if (isFloatCmp) score(eFor(a), 'floating', 5, `row ${inst.row}: floating comparison`);
        if (signedBranch) score(eFor(a), 'signed', 5, `row ${inst.row}: signed conditional branch`);
        if (unsignedBranch) score(eFor(a), 'unsigned', 5, `row ${inst.row}: unsigned conditional branch`);
      }
    }

    if (inst.op === OP.CBR) {
      const kind = inst.extra && inst.extra.kind, a = eFor(valueOf(inst.args && inst.args[0]));
      if ((kind === 'tbz' || kind === 'tbnz') && a) score(a, 'unsigned', 2, `row ${inst.row}: bit test`);
      if ((kind === 'cbz' || kind === 'cbnz') && a && a.pointer > 0) a.nullable = true;
    }

    if (inst.op === OP.CALL) {
      const name = calleeNameOf(inst);
      recordPassThroughForCall(inst, name);
      if (/objc_msgSend/.test(name) && firstArgumentRegister) {
        const recv = reachingRegisterTypeValue(ir, inst, firstArgumentRegister);
        const re = eFor(recv); if (re) score(re, 'objc', 6, `row ${inst.row}: Objective-C message receiver`);
      }
      if (/^_?swift_/.test(name) && dst) score(dst, 'swift', 2, `row ${inst.row}: Swift runtime call`);
      if (/(?:^|_)Block_(?:copy|release)$/.test(name) && firstArgumentRegister) {
        const block = reachingRegisterTypeValue(ir, inst, firstArgumentRegister);
        const ce = eFor(block); if (ce) score(ce, 'closure', 7, `row ${inst.row}: Objective-C block runtime`);
      }
      const callSig = knownCallSignature(name);
      if (callSig) {
        if (dst) {
          if (callSig.retType === 'double') { score(dst, 'floating', 5, `row ${inst.row}: ${callSig.name} return`); width(dst, 64, 2, `row ${inst.row}: ${callSig.name} return width`); }
          else if (callSig.retType === 'float') { score(dst, 'floating', 5, `row ${inst.row}: ${callSig.name} return`); width(dst, 32, 2, `row ${inst.row}: ${callSig.name} return width`); }
          else if (callSig.retType === 'ptr') score(dst, 'pointer', 4, `row ${inst.row}: ${callSig.name} return`);
          else if (callSig.retType === 'size') { score(dst, 'unsigned', 3, `row ${inst.row}: ${callSig.name} return`); width(dst, 64, 1, `row ${inst.row}: ${callSig.name} return width`); }
          else if (callSig.retType === 'long') { score(dst, 'signed', 3, `row ${inst.row}: ${callSig.name} return`); width(dst, 64, 2, `row ${inst.row}: ${callSig.name} return width`); }
        }
        if (Array.isArray(callSig.paramTypes) && argumentRegisters.length) {
          let gpIdx = 0;
          let fpIdx = 0;
          for (const pType of callSig.paramTypes) {
            if (pType === 'double' || pType === 'float') {
              if (isAArch64ArgSet && fpIdx < 8) {
                const fpReg = pType === 'float'
                  ? (reachingRegisterTypeValue(ir, inst, `s${fpIdx}`) ?? reachingRegisterTypeValue(ir, inst, `d${fpIdx}`) ?? reachingRegisterTypeValue(ir, inst, `v${fpIdx}`))
                  : (reachingRegisterTypeValue(ir, inst, `d${fpIdx}`) ?? reachingRegisterTypeValue(ir, inst, `v${fpIdx}`));
                const pe = eFor(fpReg);
                if (pe) {
                  score(pe, 'floating', 5, `row ${inst.row}: ${callSig.name} fp arg`);
                  width(pe, pType === 'float' ? 32 : 64, 2, `row ${inst.row}: ${callSig.name} fp arg width`);
                }
              }
              fpIdx++;
            } else {
              const gpRegName = argumentRegisters[gpIdx];
              if (gpRegName) {
                const gpVal = reachingRegisterTypeValue(ir, inst, gpRegName) ?? valueOf(inst.args?.[gpIdx]);
                const pe = eFor(gpVal);
                if (pe) {
                  if (pType === 'ptr') score(pe, 'pointer', 4, `row ${inst.row}: ${callSig.name} ptr arg`);
                  else if (pType === 'size') score(pe, 'unsigned', 2, `row ${inst.row}: ${callSig.name} size arg`);
                }
                const constCharIndices = CONST_CHAR_PTR_PARAMS.get(callSig.name);
                if (constCharIndices?.includes(gpIdx) && gpVal) markConstCharPtrArg(gpVal);
              }
              gpIdx++;
            }
          }
        }
      }
    }

    if ((inst.op === OP.BR || inst.op === 'jmp') && !inst.dst) {
      const tailName = calleeNameOf(inst);
      if (tailName) recordPassThroughForCall(inst, tailName);
    }
  }

  applyRuntimeHints(ir, ev, opts.runtime || opts.appleRuntime);
  const values = new Map();
  for (const v of ir.values || []) values.set(v.id, decide(eFor(v), v.bits || 64));
  const locations = new Map();
  for (const [key, e] of locEv) locations.set(key, decide(e, 64));

  // Which physical registers carry incoming arguments is a property of the
  // calling convention, not of the decompiler. `x0..x7` is the AAPCS64 answer
  // and is kept only for legacy callers that supply no ABI adapter; on RISC-V
  // those same ids name the zero register, ra, sp, gp, tp and temporaries, so
  // assuming them would report the stack pointer as an argument.
  const anyUseTracked = (ir.values || []).some((val) => Array.isArray(val?.uses) && val.uses.length > 0);
  const gpArgumentRegisters = isAArch64ArgSet
    ? argumentRegisters.filter((reg) => /^x[0-7]$/.test(reg))
    : argumentRegisters;
  const args = [];
  const acceptedGpIndices = new Set();
  gpArgumentRegisters.forEach((reg, i) => {
    const v = ir.args && ir.args.get ? ir.args.get(reg) : null;
    const pt = passThroughGpArgs.get(i) || null;
    if (!v) {
      if (pt) {
        acceptedGpIndices.add(i);
        args.push({
          reg,
          index: i,
          valueId: null,
          type: pt.type || 'uint64',
          conf: 0.65,
          why: [`pass-through argument to ${pt.callName}`],
        });
      }
      return;
    }
    const t = values.get(v.id) || { name:'unknown', confidence:0.2 };
    const used = (v.uses || []).length > 0
      ? (hasRealValueUse(v, ir, new Set(), calleeNameOf, callUseCtx) || pt != null)
      : (pt != null || (!anyUseTracked && ((model && model.argRegs) || []).includes(i)));
    if (!used) return;
    // Reject discontiguous uninitialized-PHI parameter seeds: do not promote xK (K > 0)
    // when x(K-1) has no real use and xK only enters via a PHI without a direct non-PHI read.
    if (i > 0 && !acceptedGpIndices.has(i - 1) && pt == null && (v.uses || []).length > 0) {
      const hasDirectRead = hasRealValueUse(v, ir, new Set(), calleeNameOf, callUseCtx, false);
      if (!hasDirectRead) return;
    }
    acceptedGpIndices.add(i);
    const wantsConstCharPtr = constCharPtrValueIds.has(v.id) || pt?.type === 'const char *';
    const canAdoptConstCharPtr = wantsConstCharPtr && (t.kind === 'unknown' || t.name === 'unknown' || t.name === 'void *');
    let resolvedType = canAdoptConstCharPtr ? 'const char *' : (t.name === 'unknown' && pt?.type ? pt.type : t.name);
    let resolvedConf = canAdoptConstCharPtr
      ? Math.max(t.confidence || 0.2, 0.78)
      : (t.name === 'unknown' && pt?.type ? Math.max(t.confidence || 0.2, 0.65) : t.confidence);
    const resolvedSemanticType = canAdoptConstCharPtr
      ? { ...t, name: 'const char *', kind: 'pointer', pointee: 'const char', confidence: resolvedConf }
      : t;
    args.push({ reg, index:i, valueId:v.id, type:resolvedType, conf:resolvedConf, why:t.evidence || [], semanticType:resolvedSemanticType });
  });

  // Fill positional parameter gaps for GP arguments (e.g., unused x0 when x1 is used).
  if (args.length > 0) {
    const maxGpIdx = Math.max(...args.map((a) => a.index));
    if (maxGpIdx > 0) {
      const presentGp = new Set(args.map((a) => a.index));
      for (let i = 0; i < maxGpIdx; i++) {
        if (presentGp.has(i)) continue;
        const reg = gpArgumentRegisters[i];
        if (!reg) continue;
        args.push({
          reg,
          index: i,
          valueId: ir.args?.get?.(reg)?.id ?? null,
          type: 'uint64',
          conf: 0.3,
          why: ['positional ABI argument slot'],
        });
      }
      args.sort((a, b) => a.index - b.index);
    }
  }

  // Collect AArch64 floating-point incoming arguments (`d0..d7` / `s0..s7` / `v0..v7` / `q0..q7`).
  if (isAArch64ArgSet) {
    const fpPicked = new Map();
    for (let k = 0; k < 8; k++) {
      let pickedReg = null;
      let pickedVal = null;
      if (ir.args && typeof ir.args.get === 'function') {
        for (const candidateReg of [`d${k}`, `s${k}`, `v${k}`, `q${k}`]) {
          const v = ir.args.get(candidateReg);
          if (v && (hasRealValueUse(v, ir, new Set(), calleeNameOf, callUseCtx) || passThroughRegs.has(candidateReg))) {
            pickedReg = candidateReg;
            pickedVal = v;
            break;
          }
        }
      }
      const ptFp = passThroughFpArgs.get(k) || null;
      if (!pickedVal && !ptFp) continue;
      if (!pickedVal && ptFp) {
        fpPicked.set(k, {
          reg: ptFp.reg,
          valueId: null,
          type: ptFp.type || 'double',
          conf: 0.65,
          why: [`pass-through FP argument to ${ptFp.callName}`],
        });
        continue;
      }
      let t = values.get(pickedVal.id) || { name:'unknown', confidence:0.2 };
      if (t.name === 'unknown') {
        if (pickedReg.startsWith('s') || ptFp?.type === 'float') t = { ...t, name: 'float', kind: 'float', bits: 32 };
        else if (pickedReg.startsWith('d') || ptFp?.type === 'double') t = { ...t, name: 'double', kind: 'float', bits: 64 };
      }
      fpPicked.set(k, { reg: pickedReg, valueId: pickedVal.id, type: t.name, conf: t.confidence, why: t.evidence || [], semanticType: t });
    }
    if (fpPicked.size > 0) {
      let nextArgIndex = args.length ? Math.max(...args.map((a) => a.index)) + 1 : 0;
      const maxFpIdx = Math.max(...fpPicked.keys());
      for (let k = 0; k <= maxFpIdx; k++) {
        if (fpPicked.has(k)) {
          args.push({ ...fpPicked.get(k), index: nextArgIndex++ });
        } else {
          const fallbackReg = `d${k}`;
          args.push({
            reg: fallbackReg,
            index: nextArgIndex++,
            valueId: ir.args?.get?.(fallbackReg)?.id ?? ir.args?.get?.(`s${k}`)?.id ?? null,
            type: 'double',
            conf: 0.3,
            why: ['positional ABI argument slot'],
          });
        }
      }
    }
  }

  const locals = [];
  for (const slot of ir.stackSlots || []) {
    const key = slot.key || [...(ir.locations || new Map()).keys()].find((k) => k === slot.key);
    const t = (key && locations.get(key)) || { name:'unknown', confidence:0.25, evidence:[] };
    locals.push({ slot:slot.name || key || 'var', offset:Number(slot.offset || slot.disp || 0), type:t.name, conf:t.confidence, why:t.evidence || [], semanticType:t });
  }

  let ret = { type:'void', conf:0.55, why:[] };
  const rets = (ir.instructions || []).filter((i) => i.op === OP.RET);
  const returnRegister = effectiveAbiAdapter?.returnRegister?.({ returnType:'int64' })
    ?? (isAArch64ArgSet ? 'x0' : null);
  const fpRetReg = effectiveAbiAdapter?.returnRegister?.({ returnType:'double' })
    ?? (isAArch64ArgSet ? 'd0' : null);
  const fpCandidates = isAArch64ArgSet
    ? [...new Set([fpRetReg, 'd0', 's0', 'v0'].filter(Boolean))]
    : [fpRetReg].filter(Boolean);

  const findFpReturnVals = () => {
    for (const regName of fpCandidates) {
      const found = rets.map((r) => reachingRegisterTypeValue(ir, r, regName))
        .filter((value) => {
          if (!value || !value.def) return false;
          if (regName === 'v0') {
            const vt = values.get(value.id);
            return vt && (vt.kind === 'float' || vt.name === 'double' || vt.name === 'float');
          }
          return true;
        });
      if (found.length) return found;
    }
    return [];
  };

  if (rets.length) {
    let vals = rets.map((r) => valueOf(r.args && r.args[0])).filter(Boolean);
    if (!vals.length && returnRegister) {
      vals = rets.map((r) => reachingRegisterTypeValue(ir, r, returnRegister))
        .filter((value) => {
          if (!value) return false;
          if (value.def) return true;
          if (ir.args?.get?.(returnRegister) === value && !value.clobbered) {
            return (value.uses || []).length > 0 || passThroughRegs.has(returnRegister);
          }
          return (value.uses || []).length > 0;
        });
    }
    const fpVals = findFpReturnVals();
    if (!vals.length && fpVals.length) {
      vals = fpVals;
    } else if (vals.length && fpVals.length) {
      // If GP return register is only defined by an earlier helper call (e.g. malloc/free)
      // before a floating-point computation in d0/s0 that is the latest definition before RET,
      // prefer the FP return value over the stale GP register.
      const allGpFromHelperCall = vals.every((v) => v?.def?.op === OP.CALL);
      const allGpConsumedInternally = vals.every((v) => (v?.uses || []).some((u) => u && u.op !== OP.RET && u.op !== OP.CLOBBER));
      const allFpFreshReturn = fpVals.every((v) => !(v?.uses || []).some((u) => u && u.op !== OP.RET && u.op !== OP.CLOBBER));
      const maxGpRow = Math.max(...vals.map((v) => v.def?.row ?? -1));
      const maxFpRow = Math.max(...fpVals.map((v) => v.def?.row ?? -1));
      const allGpVoidCall = allGpFromHelperCall && vals.every((v) => knownCallSignature(calleeNameOf(v.def))?.retType === 'void');
      if (allGpVoidCall || (maxFpRow > maxGpRow && (allGpFromHelperCall || (allGpConsumedInternally && allFpFreshReturn)))) {
        vals = fpVals;
      }
    }
    const is32BitIntReturnValue = (val, seen = new Set()) => {
      if (!val || seen.has(val)) return false;
      seen.add(val);
      const vt = values.get(val.id);
      if (vt && vt.kind !== 'unknown' && vt.name !== 'int32' && vt.name !== 'uint32' && vt.name !== 'bool') return false;
      if (vt?.name === 'int32') return true;
      if (typeof val.reg === 'string' && /^w\d+$/.test(val.reg)) return true;
      if (val.bits === 32) return true;
      const def = val.def;
      if (!def) return false;
      if (def.op === OP.CONST) return val.bits === 32 || val.const === 0xffffffffn;
      if (def.op === OP.MOV) {
        if (def.sub === 'zext' && Number(def.extra?.sourceBits) === 32) return true;
        if (def.sub === 'trunc' && (Number(def.extra?.targetBits) === 32 || val.bits === 32)) return true;
        if (val.const === 0xffffffffn) return true;
        const src = valueOf(def.args?.[0]);
        return src ? is32BitIntReturnValue(src, seen) : false;
      }
      if (def.op === OP.PHI) {
        const incoming = (def.args || []).map(valueOf).filter((arg) => arg && !seen.has(arg));
        return incoming.length > 0 && incoming.every((arg) => is32BitIntReturnValue(arg, new Set(seen)));
      }
      if (def.op === OP.SEL) {
        const arms = (def.args || []).slice(0, 2).map(valueOf).filter(Boolean);
        return arms.length === 2 && arms.every((arg) => is32BitIntReturnValue(arg, new Set(seen)));
      }
      if (def.op === OP.LOAD) {
        return Number(def.extra?.size) === 4 || Number(def.extra?.widthBits) === 32 || val.bits === 32;
      }
      if (def.op === OP.CALL) {
        const sig = knownCallSignature(calleeNameOf(def));
        return sig?.retType === 'int';
      }
      return false;
    };
    if (vals.length) {
      let picked = null;
      for (const v of vals) picked = mergeRecoveredTypes(picked, values.get(v.id));
      if ((!picked || picked.kind === 'unknown' || picked.name === 'unknown')
          && vals.every((v) => is32BitIntReturnValue(v))) {
        picked = {
          name: 'int32',
          kind: 'integer',
          bits: 32,
          signed: true,
          confidence: Math.max(picked?.confidence || 0.25, 0.72),
          evidence: [...(picked?.evidence || []), { source: '32-bit integer return value', weight: 3 }],
        };
      }
      if (picked) ret = { type:picked.name, conf:picked.confidence, why:picked.evidence || [], semanticType:picked };
    }
  } else {
    // Tail-call function with no OP.RET (e.g. `b strlen` or tail OP.CALL):
    // inspect the final instruction of the last block / instruction list.
    const insts = ir.instructions || [];
    const blocks = ir.blocks || [];
    const tailCandidates = [];
    for (const b of blocks) {
      if (Array.isArray(b?.succ) && b.succ.length > 0) continue;
      const bInsts = Array.isArray(b?.insts) && b.insts.length
        ? b.insts
        : insts.filter((i) => i.block === b.index || i.block === b.id);
      if (bInsts.length) tailCandidates.push(bInsts[bInsts.length - 1]);
    }
    if (!tailCandidates.length && insts.length) tailCandidates.push(insts[insts.length - 1]);
    for (const tailInst of tailCandidates) {
      if (!tailInst) continue;
      const isCall = tailInst.op === OP.CALL;
      const tailName = calleeNameOf(tailInst);
      const isTailBranch = (tailInst.op === OP.BR || tailInst.op === 'jmp') && Boolean(tailName);
      if (!isCall && !isTailBranch) continue;
      const sig = tailName ? knownCallSignature(tailName) : null;
      const rt = sig?.retType ? callRetTypeToSemantic(sig.retType) : 'uint64';
      ret = {
        type: rt,
        conf: sig?.retType ? 0.75 : 0.5,
        why: [tailName ? `tail call to ${tailName}` : 'tail call return'],
      };
      break;
    }
  }

  const warnings = [];
  for (const t of values.values()) if (t.kind === 'ambiguous' && t.warning) warnings.push(t.warning);
  return { args, locals, ret, values, locations, warnings };
}

function sanitizeCxxTypeIdent(name, fallback = 'cxx_obj') {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  const clean = raw
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1');
  return clean || fallback;
}

export function semanticSignature(name, recovered, notes = null, funcAddr = null, opts = null, ir = null) {
  const rt = (notes && notes.typeOf && notes.typeOf(funcAddr, 'ret')) || (recovered.ret && recovered.ret.type) || 'void';
  const cxxRec = currentCppReceiver(opts || {}, ir);
  const recoveredArgs = recovered.args || [];
  const args = recoveredArgs.map((a) => {
    const authoritativeType = notes?.typeOf?.(funcAddr, 'a' + a.index) || null;
    let t = authoritativeType || (a.type === 'unknown' ? 'uint64' : a.type);
    let n = (notes && notes.varName && notes.varName(funcAddr, 'a' + a.index)) || `a${a.index + 1}`;
    const isThis = a.index === 0 && cxxRec;
    if (isThis) {
      n = 'this';
      if (!authoritativeType) {
        const className = cxxRec.classIdentity?.className;
        if (className) t = `${sanitizeCxxTypeIdent(className)} *`;
      }
    }
    return `${t} ${n}`;
  });
  if (cxxRec && !recoveredArgs.some((a) => a.index === 0)) {
    const authoritativeType = notes?.typeOf?.(funcAddr, 'a0') || null;
    const className = cxxRec.classIdentity?.className;
    const type = authoritativeType || (className ? `${sanitizeCxxTypeIdent(className)} *` : 'uint64');
    args.unshift(`${type} this`);
  }
  return `${rt === 'unknown' ? 'uint64' : rt} ${name || 'sub'}(${args.length ? args.join(', ') : 'void'})`;
}
