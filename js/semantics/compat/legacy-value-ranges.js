import { V1_OP as OP } from './semantic-ir-v2-to-v1-core.js';
import { mergeRangeDomain, normalizeIntegerValue, normalizeRangeDomain, rangeWithDomain } from '../../range-domain.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from '../../core/identity/live-data.js';

const rangeAnnotations = new WeakMap();

// Only the actual range annotator below publishes this history. There is no
// public arbitrary-write registration or projection resealing operation.
export function observedRangeAnnotationsMatch(ir, priorObservation) {
  const annotation = rangeAnnotations.get(ir);
  return annotation?.isCurrent() === true && priorObservation.matchesThroughWrites(annotation.writes);
}

function sealRangeAnnotations(ir, writes, overflow) {
  rangeAnnotations.delete(ir);
  if (overflow || !writes.length) return;
  try {
    const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
    const values = ir.values, latest = new Map();
    for (const write of writes) latest.set(write.object, write.after);
    const indices = new Map();
    for (let index = 0; index < values.length; index++) {
      if (latest.has(values[index]) && !indices.has(values[index])) indices.set(values[index], index);
    }
    const positions = [...latest].map(([value, after]) => {
      const index = indices.get(value);
      if (index == null) throw new Error('range-annotation-value-missing');
      return { value, after, index };
    });
    const captured = captureProjectionIrData([...new Set(writes.map(write => write.after))]);
    rangeAnnotations.set(ir, Object.freeze({ writes:Object.freeze(writes), isCurrent:() => own(ir, 'values') === values
      && positions.every(({ value, after, index }) => own(values, index) === value && own(value, 'range') === after)
      && captured.matches() }));
  } catch { /* Annotation output remains unchanged; observation is unavailable. */ }
}

export function shiftedConst(arg, fallbackBits = null) {
  if (!arg || !arg.value || arg.value.const == null) return null;
  const bits = Math.max(1, Math.min(64, Number(fallbackBits || arg.value.bits || 64)));
  const width = BigInt(bits);
  let v = BigInt.asUintN(bits, BigInt(arg.value.const));
  const s = arg.shift;
  if (!s) return v;
  const n = BigInt(s.amount || 0);
  if (n < 0n || n >= width) return null;
  if (s.op === 'lsl') return BigInt.asUintN(bits, v << n);
  if (s.op === 'lsr') return v >> n;
  if (s.op === 'asr') return BigInt.asUintN(bits, BigInt.asIntN(bits, v) >> n);
  if (s.op === 'ror') {
    if (n === 0n) return v;
    return BigInt.asUintN(bits, (v >> n) | (v << (width - n)));
  }
  return null;
}

export function typeBounds(bits, signed) {
  const n = BigInt(Math.max(1, Math.min(64, bits || 64)));
  if (signed === true) return { min: -(1n << (n - 1n)), max: (1n << (n - 1n)) - 1n };
  return { min: 0n, max: (1n << n) - 1n };
}

function mergeRange(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return mergeRangeDomain(a, b, a.bits || b.bits, a.signed);
}

function rangeEq(a, b) {
  return !!a === !!b && (!a || (
    a.min === b.min && a.max === b.max && Number(a.bits || 64) === Number(b.bits || 64) && a.signed === b.signed
  ));
}

function argumentRange(arg, bits = null, signed = undefined) {
  const range = arg && arg.value ? arg.value.range : null;
  if (!range || bits == null) return range;
  return normalizeRangeDomain(range, bits, signed);
}

export function annotateValueRanges(ir) {
  if (!ir || !ir.values) return ir;
  const previous = rangeAnnotations.get(ir);
  const writes = previous?.isCurrent() ? [...previous.writes] : [];
  let overflow = false;
  const writeRange = (value, range) => {
    const before = Object.getOwnPropertyDescriptor(value, 'range');
    value.range = range;
    const after = Object.getOwnPropertyDescriptor(value, 'range');
    if (writes.length >= PROJECTION_LIMITS.nodes || !before || !Object.hasOwn(before, 'value') || !before.enumerable
      || !after || !Object.hasOwn(after, 'value') || after.value !== range || !after.enumerable) {
      overflow = true; return;
    }
    writes.push(Object.freeze({ object:value, key:'range', before:before.value, after:range }));
  };
  for (const v of ir.values) {
    if (v.const != null) {
      const bits = v.bits || 64;
      const value = normalizeIntegerValue(v.const, bits, v.signed);
      writeRange(v, rangeWithDomain(value, value, bits, v.signed));
    }
  }

  const maxRounds = 6;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const inst of ir.instructions || []) {
      if (!inst.dst || inst.dst.const != null) continue;
      const bits = inst.dst.bits || 64;
      let next = null;
      if (inst.op === OP.MOV && inst.args[0]) next = argumentRange(inst.args[0], bits, inst.dst.signed);
      else if (inst.op === OP.UN && inst.args[0] && /^(uxt8|uxt16|uxt32)$/.test(inst.sub || '')) {
        const b = Number((inst.sub.match(/\d+/) || ['64'])[0]);
        next = rangeWithDomain(0n, (1n << BigInt(b)) - 1n, bits, false);
      } else if (inst.op === OP.BIN && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0], bits, inst.dst.signed);
        const b = argumentRange(inst.args[1], bits, inst.dst.signed);
        const ac = shiftedConst(inst.args[0], bits);
        const bc = shiftedConst(inst.args[1], bits);
        const bounds = typeBounds(bits, inst.dst.signed);
        if (inst.sub === 'and') {
          const rawMask = bc != null ? bc : ac;
          if (rawMask != null) {
            const mask = BigInt.asUintN(bits, rawMask);
            const signBit = 1n << BigInt(bits - 1);
            // A signed result can be negative whenever the mask preserves the
            // sign bit. The contiguous range domain cannot represent {0,MIN}
            // exactly, so retain soundness with the full signed interval.
            if (inst.dst.signed === true && (mask & signBit) !== 0n) {
              next = rangeWithDomain(bounds.min, bounds.max, bits, true);
            } else {
              next = { min: 0n, max: mask < bounds.max ? mask : bounds.max };
            }
          }
        } else if ((inst.sub === 'lshr' || inst.sub === 'ashr') && a && bc != null && bc >= 0n && bc < BigInt(bits)) {
          if (inst.sub === 'lshr' && a.min >= 0n) next = { min: a.min >> bc, max: a.max >> bc };
        } else if (inst.sub === 'shl' && a && bc != null && bc >= 0n && bc < BigInt(bits)) {
          const min = a.min << bc, max = a.max << bc;
          if (min >= bounds.min && max <= bounds.max) next = { min, max };
        } else if (inst.sub === 'add') {
          if (a && bc != null) {
            const min = a.min + bc, max = a.max + bc;
            if (min >= bounds.min && max <= bounds.max) next = { min, max };
          } else if (b && ac != null) {
            const min = b.min + ac, max = b.max + ac;
            if (min >= bounds.min && max <= bounds.max) next = { min, max };
          }
        } else if (inst.sub === 'sub' && a && bc != null) {
          const min = a.min - bc, max = a.max - bc;
          if (min >= bounds.min && max <= bounds.max) next = { min, max };
        }
      } else if (inst.op === OP.PHI && inst.args.length) {
        let merged = null, complete = true;
        for (const a of inst.args) {
          const r = argumentRange(a, bits, inst.dst.signed);
          if (!r) { complete = false; break; }
          merged = mergeRange(merged, r);
        }
        if (complete) next = merged;
      } else if (inst.op === OP.SEL && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0], bits, inst.dst.signed), b = argumentRange(inst.args[1], bits, inst.dst.signed);
        if (a && b) next = mergeRange(a, b);
      }
      if (next && next.bits == null) next = rangeWithDomain(next.min, next.max, bits, inst.dst.signed);
      if (next && !rangeEq(inst.dst.range, next)) { writeRange(inst.dst, { ...next }); changed = true; }
    }
    if (!changed) break;
  }
  sealRangeAnnotations(ir, writes, overflow);
  return ir;
}
