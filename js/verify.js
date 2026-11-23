/*
 * 検証 — 「そう書いてある」を「本当にそう動く」に上げる層。
 * 実際の命令とdataflowで裏取りできないものは確定扱いしない。
 */
import { findValueUpdates, constantComparisons, regKeyOf, selfRegisters } from './dataflow.js';

const ARG2 = 'x2';
const FP_ARG0 = 'v0';
export { selfRegisters };

function explicitBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return BigInt(value.trim()); } catch { return null; }
}

function memoryTouchesSelf(insn, isSelf, offset, kind = null) {
  const m = insn?.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (kind && m.kind !== kind) return false;
  return isSelf(m.base, insn.row) && m.disp === offset;
}

export function verifyAccessor(model, hyp, opts) {
  const o = opts || {};
  const max = typeof o.maxInstructions === 'number' && Number.isFinite(o.maxInstructions) && o.maxInstructions > 0
    ? Math.floor(o.maxInstructions)
    : 40;
  const out = {
    getter: false, setter: false,
    offset: null, size: null, row: null, address: null,
    exclusive: false, instructions: 0, otherOffsets: 0,
  };
  if (!model || !hyp || hyp.offset == null) return out;
  const offset = explicitBigInt(hyp.offset);
  if (offset == null) return out;
  out.offset = offset;

  const insns = model.instructions || [];
  out.instructions = insns.length;
  if (!insns.length || insns.length > max) return out;

  const { isSelf } = selfRegisters(model);
  let others = 0;
  let hit = null;
  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null) continue;
    if (!isSelf(m.base, insn.row)) continue;
    if (m.disp === offset) {
      if (!hit) hit = { insn, kind: m.kind, size: m.size };
      if (m.kind === 'load') out.getter = true;
      else out.setter = true;
    } else others++;
  }
  if (!hit) return out;

  out.size = hit.size;
  out.row = hit.insn.row;
  out.address = hit.insn.address;
  out.otherOffsets = others;
  out.exclusive = others === 0;

  if (out.getter) {
    // Only verify return-register flow when load instructions actually expose
    // output register writes (preserving #4139 minimal mock compatibility where
    // load instructions have `writes: []`).
    const loads = insns.filter((i) => memoryTouchesSelf(i, isSelf, offset, 'load'));
    const hasLoadWrites = loads.some((l) => (l.writes || []).length > 0);
    if (hasLoadWrites) {
      out.getter = loads.some((l) => (l.writes || []).length === 0 || flowsToReturn(insns, l));
    }
  }

  if (out.setter) {
    // Objective-C property setters have one explicit argument: x2/w2 (GP) or
    // s0/d0 (scalar FP). Always check for intervening overwrites back to entry
    // and check all matching stores.
    const stores = insns.filter((i) => memoryTouchesSelf(i, isSelf, offset, 'store'));
    if (stores.length) {
      out.fromArgument = stores.some((store) => tracesToArgument(insns, store.row, store.ops?.[0]));
    }
  }
  return out;
}

function wideOf(reg) {
  const m = /^[wx](\d+)$/.exec(String(reg || '').toLowerCase());
  return m ? 'x' + m[1] : null;
}

function regNorm(reg) {
  const s = String(reg || '').toLowerCase();
  const gp = /^[wx](\d+)$/.exec(s);
  if (gp) return 'x' + gp[1];
  const fp = /^[sdqv](\d+)$/.exec(s);
  if (fp) return 'v' + fp[1];
  return null;
}

function gpView(value) {
  const text = typeof value === 'string' ? value : value?.text;
  const m = /^([wx])(\d+)$/.exec(String(text || '').toLowerCase());
  return m ? { cls: 'gp', key: 'x' + m[2], bits: m[1] === 'x' ? 64 : 32 } : null;
}

function fpView(value) {
  const text = typeof value === 'string' ? value : value?.text;
  const m = /^([sd])(\d+)$/.exec(String(text || '').toLowerCase());
  return m ? { cls: 'fp', key: 'v' + m[2], bits: m[1] === 'd' ? 64 : 32 } : null;
}

function zeroView(value) {
  const text = typeof value === 'string' ? value : value?.text;
  const s = String(text || '').toLowerCase();
  if (s === 'wzr') return { cls: 'zr', bits: 32 };
  if (s === 'xzr') return { cls: 'zr', bits: 64 };
  return null;
}

function regView(value) {
  return gpView(value) || fpView(value);
}

function isReturnReg(view) {
  if (!view) return false;
  return (view.cls === 'gp' && view.key === 'x0') || (view.cls === 'fp' && view.key === 'v0');
}

function sameWidthCopyPair(insn) {
  const mn = String(insn?.mnemonic || '').toLowerCase();
  const ops = insn?.ops || [];
  if (mn === 'mov') {
    const dst = gpView(ops[0]);
    const src = gpView(ops[1]);
    if (dst && src && dst.bits === src.bits) return { dst, src };
    return null;
  }
  if (mn === 'orr' && ops.length === 3) {
    const dst = gpView(ops[0]);
    const zero = zeroView(ops[1]);
    const src = gpView(ops[2]);
    const shift = ops[2]?.shift;
    const noShift = shift == null || (shift.op === 'lsl' && Number(shift.amount) === 0);
    if (dst && zero && src && dst.bits === zero.bits && dst.bits === src.bits && noShift) {
      return { dst, src };
    }
    return null;
  }
  if (mn === 'fmov') {
    const dst = fpView(ops[0]);
    const src = fpView(ops[1]);
    if (dst && src && dst.bits === src.bits) return { dst, src };
    return null;
  }
  return null;
}

function flowsToReturn(insns, load) {
  const dst = regView(load.ops?.[0]) || regView(load.writes?.[0]);
  if (!dst) return true;
  const start = insns.findIndex((x) => x.row === load.row);
  if (start < 0) return isReturnReg(dst);
  let cur = dst;
  for (let i = start + 1; i < insns.length; i++) {
    const insn = insns[i];
    const mn = String(insn?.mnemonic || '').toLowerCase();
    if (/^(ret|retaa|retab)$/.test(mn)) return isReturnReg(cur);
    if (/^(bl|blr|br)$/.test(mn)) return false;
    if (controlBoundary(insn)) return isReturnReg(cur);
    const copy = sameWidthCopyPair(insn);
    if (copy && copy.src.cls === cur.cls && copy.src.key === cur.key && copy.src.bits === cur.bits) {
      cur = copy.dst;
      continue;
    }
    if ((insn.writes || []).some((written) => regNorm(written) === cur.key)) return false;
  }
  return isReturnReg(cur);
}

function tracesToArgument(insns, row, srcOp) {
  let want = regView(srcOp);
  if (!want) return false;
  const start = insns.findIndex((x) => x.row === row);
  if (start < 0) return false;
  for (let i = start - 1; i >= 0; i--) {
    const insn = insns[i];
    if (controlBoundary(insn)) return false;
    if (!(insn.writes || []).some((written) => regNorm(written) === want.key)) continue;
    if (insn.memory) return false;

    // Setter identity proof is intentionally stricter than general dataflow:
    // only an explicit same-width copy (`mov`, same-width `orr dst, wzr/xzr, src`,
    // or same-width `fmov`) preserves the exact argument value. Width/sign-extend
    // operations (`sxtw`, `uxtw`, `uxtb`, `uxth`, etc.) are transformations, not copies (#813).
    const copy = sameWidthCopyPair(insn);
    if (!copy || copy.dst.cls !== want.cls || copy.dst.key !== want.key || copy.dst.bits !== want.bits) {
      return false;
    }
    if (copy.src.cls === 'gp' && /^x[3-7]$/.test(copy.src.key)) return false;
    if (copy.src.cls === 'fp' && /^v[1-7]$/.test(copy.src.key)) return false;
    want = copy.src;
  }
  return (want.cls === 'gp' && want.key === ARG2) || (want.cls === 'fp' && want.key === FP_ARG0);
}

function controlBoundary(insn) {
  const mn = String(insn?.mnemonic || '').toLowerCase();
  return /^(?:b(?:\.|$)|cbz$|cbnz$|tbz$|tbnz$|br$|blr$|bl$|ret$|retaa$|retab$)/.test(mn);
}

const FLAG_WRITER = /^(cmp|cmn|tst|subs|adds|ands|bics|ccmp|ccmn|fcmp|fcmpe|fccmp|fccmpe)$/;
const FLAG_CONSUMER = /^(b\.[a-z]+|csel|csinc|csinv|csneg|cset|csetm|cinc|cinv|cneg|ccmp|ccmn|fccmp|fccmpe)$/;

function hasFlagConsumer(byRow, startRow) {
  for (let r = startRow + 1; r <= startRow + 8; r++) {
    const insn = byRow.get(r);
    if (!insn) continue;
    const mn = String(insn.mnemonic || '').toLowerCase();
    if (FLAG_CONSUMER.test(mn)) return true;
    if (FLAG_WRITER.test(mn)) return false;
    if (controlBoundary(insn)) return false;
  }
  return false;
}

/** Count how self+offset is used, preserving only proven same-control-path guards. */
export function fieldUse(model, offset, opts) {
  const o = opts || {};
  const want = explicitBigInt(offset);
  const out = { loads: 0, stores: 0, rmw: [], compares: [], sites: [], self: false };
  if (!model || want == null) return out;
  const insns = model.instructions || [];
  const { isSelf: selfAt } = selfRegisters(model);
  const selfOnly = o.selfOnly !== false;

  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.stack || m.indexed || m.disp == null || m.disp !== want) continue;
    const isSelf = selfAt(m.base, insn.row);
    if (selfOnly && !isSelf) continue;
    if (isSelf) out.self = true;
    if (m.kind === 'load') out.loads++; else out.stores++;
    out.sites.push({ row: insn.row, address: insn.address, kind: m.kind, base: m.base, size: m.size, self: isSelf });
  }
  if (!out.sites.length) return out;

  for (const u of findValueUpdates(model)) {
    if (u.kind !== 'read-modify-write' || u.location.disp !== want) continue;
    if (selfOnly && !u.location.self) continue;
    out.rmw.push(u);
  }

  const byRow = new Map(insns.map((i) => [i.row, i]));
  const comparisonByRow = new Map(constantComparisons(model, { allowUnscopedPropagated: true }).map((c) => [c.row, c]));
  for (const site of out.sites) {
    if (site.kind !== 'load') continue;
    const insn = byRow.get(site.row);
    if (!insn) continue;
    const reg = regKeyOf(insn.ops[0]);
    if (!reg) continue;
    for (let r = site.row + 1; r <= site.row + 8; r++) {
      const next = byRow.get(r);
      if (!next) continue;
      const mn = String(next.mnemonic || '').toLowerCase();
      // Check fused compare-and-branch instructions before breaking at controlBoundary.
      if (/^(cbz|cbnz|tbz|tbnz)$/.test(mn)) {
        if ((next.reads || []).includes(reg) || regKeyOf(next.ops?.[0]) === reg) {
          const fact = comparisonByRow.get(next.row) || null;
          const ssaFact = fact && fact.register === reg ? fact : null;
          const isZeroBranch = mn === 'cbz' || mn === 'cbnz';
          const bitOp = !isZeroBranch ? next.ops?.[1] : null;
          const bitImm = bitOp && bitOp.k === 'imm' && bitOp.value != null ? bitOp.value : null;
          out.compares.push({
            row: next.row, address: next.address, mnemonic: mn,
            value: isZeroBranch ? (ssaFact && ssaFact.value != null ? ssaFact.value : 0n) : (bitImm != null ? bitImm : (ssaFact ? ssaFact.value : null)),
            float: ssaFact ? ssaFact.float : null,
            engine: ssaFact ? ssaFact.engine : null,
            propagated: !!(ssaFact && ssaFact.propagated),
          });
        }
        break;
      }
      // Never jump across a call/branch/return just because the numeric row is
      // nearby. That was enough to attach guards from a different CFG path.
      if (controlBoundary(next)) break;
      if (!/^(cmp|cmn|subs|adds|ccmp|fcmp|tst)$/.test(mn)) {
        // An in-place transform such as `sub w8, w8, w2` still carries the
        // loaded field value. A write that does not read the tracked register
        // is a new definition and ends the chain.
        if (next.writes.includes(reg) && !next.reads.includes(reg)) break;
        continue;
      }
      if (!next.reads.includes(reg)) continue;
      if ((mn === 'subs' || mn === 'adds') && !zeroView(next.ops?.[0]) && !hasFlagConsumer(byRow, next.row)) {
        if (next.writes.includes(reg) && !next.reads.includes(reg)) break;
        continue;
      }
      const imm = next.ops.find((op) => op.k === 'imm' && (op.value != null || op.float != null));
      const fact = comparisonByRow.get(next.row) || null;
      const ssaFact = fact && fact.register === reg ? fact : null;
      out.compares.push({
        row: next.row, address: next.address, mnemonic: mn,
        value: imm && imm.value != null ? imm.value : (ssaFact ? ssaFact.value : null),
        float: imm && imm.float != null ? imm.float : (ssaFact ? ssaFact.float : null),
        engine: ssaFact ? ssaFact.engine : null,
        propagated: !!(ssaFact && ssaFact.propagated),
      });
      break;
    }
  }
  return out;
}

export function verifyGuard(model, offset) {
  const use = fieldUse(model, offset);
  return { guards: use.compares.map((c) => ({ row: c.row, address: c.address, value: c.value, float: c.float, mnemonic: c.mnemonic, engine: c.engine || null, propagated: !!c.propagated })), loads: use.loads, stores: use.stores };
}

export function verifyFunctionHandlesField(model, offset) {
  const use = fieldUse(model, offset);
  return { touches: use.sites.length > 0, writes: use.stores > 0, rmw: use.rmw.length > 0, guard: use.compares.length > 0, use };
}

export function callsSelector(model, re) {
  const out = [];
  // Stateful expressions must start each selector at zero without changing
  // the caller's cursor. Retain sticky anchoring as well as the other flags.
  const matcher = re?.global || re?.sticky ? new RegExp(re.source, re.flags) : re;
  for (const c of (model && model.calls) || []) {
    if (!c?.selector) continue;
    if (matcher !== re) matcher.lastIndex = 0;
    if (matcher.test(c.selector)) out.push({ selector: c.selector, row: c.row != null ? c.row : null });
  }
  return out;
}
