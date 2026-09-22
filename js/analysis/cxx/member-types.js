/**
 * Phase 4 member type-category evidence.
 *
 * This module does NOT infer a layout and does not name fields. Layout grouping
 * (which offsets belong to one object, array detection) is owned by
 * `js/decompiler/types/layout.js`; naming is owned by the existing `fieldFor` /
 * `objcIvar` projections. What is added here is the missing middle: a **type
 * category** for a receiver-member offset, derived only from binary access
 * evidence that is already present in the semantic IR.
 *
 * Evidence used:
 * - memory access width (`loc.size`),
 * - machine sign-extension of the load (`extra.signed`) — note this is machine
 *   signedness, so a plain `ldr w` proves "32-bit integer", not "signed int",
 * - a value flowing into a vector register, the only in-IR witness that a
 *   4/8-byte member is a float/double,
 * - an 8-byte loaded value later used as an address base or call/return
 *   argument, the witness for a pointer or object pointer,
 * - indexed access with an element scale, the witness for array-like,
 * - a 1-byte member compared against 0/1 or stored from a literal 0/1, the
 *   witness for bool-like.
 *
 * The signedness of a plain word/halfword/byte access is NOT derivable from the
 * instruction alone, so those members report `category: 'intN'` (width proven)
 * with an explicit candidate list and `signedness: null`. Only a sign-extending
 * load (`ldrsw`, `ldrsb`, ...) proves signed.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';

export const CPP_MEMBER_TYPE_SCHEMA = 'cpp-member-type-evidence/v1';

const FP_REGISTER = /^[vsdq]\d+$/;
// Loads/stores are reached through several compiler-inserted width casts
// (byte -> word -> doubleword -> register move -> truncate), so the chain walk
// must cover normal codegen without becoming unbounded.
const MAX_CHAIN_DEPTH = 8;

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function valueId(value) {
  if (value == null) return null;
  const id = value.id ?? value.valueId ?? null;
  return id == null ? null : id;
}

/** The one fail-closed shape: no category, no label, and an explicit reason. */
function unclassified(reason) {
  return { category: null, label: null, signedness: null, candidates: [], rule: null, reason };
}

/**
 * Classifies one member access from its binary evidence.
 *
 * `category` is one of `float`, `double`, `pointer`, `bool-like`, `array-like`,
 * `int8`, `int16`, `int32`, `int64`. `signedness` is `true`/`false` only when
 * the access itself proves it, otherwise null.
 */
export function classifyMemberAccess({ size = 0, signed = null, fp = false, pointerUse = false, indexed = false, boolLike = false } = {}) {
  if (!Number.isSafeInteger(size) || size <= 0) return unclassified('unknown-access-width');
  if (indexed) {
    const element = classifyMemberAccess({ size, signed, fp, pointerUse: false });
    return {
      category: 'array-like',
      label: element.label ? `${element.label}[]` : `${size * 8}-bit array-like`,
      signedness: null,
      candidates: [],
      rule: 'indexed-access-with-element-scale',
      evidence: { elementCategory: element.category, elementLabel: element.label, elementSize: size },
    };
  }
  if (fp) {
    if (size === 4) return { category: 'float', label: 'float', signedness: null, candidates: ['float'], rule: 'vector-register-flow' };
    if (size === 8) return { category: 'double', label: 'double', signedness: null, candidates: ['double'], rule: 'vector-register-flow' };
    return unclassified('vector-register-width-unmatched');
  }
  if (pointerUse && size === 8) {
    return { category: 'pointer', label: 'pointer', signedness: null, candidates: ['object-pointer', 'pointer'], rule: 'loaded-value-used-as-address-or-argument' };
  }
  if (size === 1 && boolLike) {
    return { category: 'bool-like', label: 'bool-like', signedness: null, candidates: ['bool', 'uint8_t'], rule: 'byte-access-used-as-boolean' };
  }
  if (size === 1) {
    if (signed === true) return { category: 'int8', label: 'int8_t', signedness: true, candidates: ['int8_t', 'signed char'], rule: 'sign-extended-byte-load' };
    return { category: 'int8', label: 'uint8_t|char', signedness: null, candidates: ['uint8_t', 'char'], rule: 'byte-access' };
  }
  if (size === 2) {
    if (signed === true) return { category: 'int16', label: 'int16_t', signedness: true, candidates: ['int16_t'], rule: 'sign-extended-halfword-load' };
    return { category: 'int16', label: 'int16_t|uint16_t', signedness: null, candidates: ['int16_t', 'uint16_t'], rule: 'halfword-access' };
  }
  if (size === 4) {
    if (signed === true) return { category: 'int32', label: 'int32_t', signedness: true, candidates: ['int32_t'], rule: 'sign-extended-word-load' };
    return { category: 'int32', label: 'int32_t|uint32_t', signedness: null, candidates: ['int32_t', 'uint32_t'], rule: 'word-access' };
  }
  if (size === 8) {
    if (signed === true) return { category: 'int64', label: 'int64_t', signedness: true, candidates: ['int64_t'], rule: 'sign-extended-doubleword-load' };
    return { category: 'int64', label: 'int64_t|uint64_t|pointer', signedness: null, candidates: ['int64_t', 'uint64_t', 'pointer'], rule: 'doubleword-access' };
  }
  return unclassified('unclassified-access-width');
}

/** Width-only categories: the access proves the width but not the meaning. */
const WIDTH_ONLY = new Set(['int8', 'int16', 'int32', 'int64']);

function buildChains(ir, maxInstructions) {
  const sources = new Map();
  const consumers = new Map();
  const constants = new Map();
  const vectorTargets = new Set();
  const conditionValues = new Set();
  const addressUsed = new Set();
  const instructions = [];
  let scanned = 0;

  // Constants first: a comparison's other operand can only be recognised as the
  // literal 0/1 once every `const` definition is known, and a `cmp` may be
  // visited before the definition it reads.
  for (const inst of ir?.instructions || []) {
    if (scanned++ >= maxInstructions) break;
    instructions.push(inst);
    if (inst.op !== 'const') continue;
    const dstId = valueId(inst.dst);
    if (dstId == null) continue;
    const raw = inst.extra?.value ?? inst.extra?.constant?.value ?? null;
    const parsed = raw == null ? null : toBigInt(raw);
    if (parsed != null) constants.set(dstId, parsed);
  }

  for (const inst of instructions) {
    const dstId = valueId(inst.dst);
    if (dstId != null && (inst.op === 'mov' || inst.op === 'un') && inst.args?.length) {
      const source = valueId(inst.args[0]?.value ?? inst.args[0]);
      if (source != null) {
        sources.set(dstId, source);
        const list = consumers.get(source);
        if (list) list.push(dstId); else consumers.set(source, [dstId]);
      }
      const reg = inst.dst?.reg;
      if (typeof reg === 'string' && FP_REGISTER.test(reg)) vectorTargets.add(dstId);
    }
    if (inst.op === 'cmp' || inst.op === 'cbr') {
      const kind = inst.extra?.kind ?? inst.cond ?? null;
      const ids = (inst.args || [])
        .map((arg) => valueId(arg?.value ?? arg))
        .filter((id) => id != null);
      if (inst.op === 'cbr' && (kind === 'cbz' || kind === 'cbnz')) {
        // `cbz` / `cbnz` compare their operand against zero implicitly: the
        // comparison is the instruction itself, so there is no separate
        // literal operand to inspect. Only a test of bit 0 of a *single byte*
        // is admitted as boolean; every other bit test stays out.
        for (const id of ids) conditionValues.add(id);
      } else {
        // A `cmp` plus a conditional branch is only boolean evidence when the
        // other operand is the literal 0 or 1. A byte member compared with 42
        // is not bool-like, so the compared value is recorded only then.
        const literal = ids.filter((id) => { const value = constants.get(id); return value === 0n || value === 1n; });
        if (literal.length) {
          for (const id of ids) if (!literal.includes(id)) conditionValues.add(id);
        }
      }
    }
    // Pointer evidence requires the value to actually be used as an address.
    // Passing a loaded value as a call argument or returning it by value proves
    // nothing about its type: a `uint64_t` member and a pointer member look
    // identical there, so that use is deliberately not collected.
    const baseId = valueId(inst.loc?.base ?? inst.addr?.base);
    if (baseId != null) addressUsed.add(baseId);
  }
  return { sources, consumers, constants, vectorTargets, conditionValues, addressUsed };
}

/** Breadth-first walk over mov/unary chains, bounded by MAX_CHAIN_DEPTH. */
function flowsInto(seedId, targets, consumers) {
  if (seedId == null || !targets.size) return false;
  const seen = new Set([seedId]);
  let frontier = [seedId];
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const consumer of consumers.get(id) || []) {
        if (seen.has(consumer)) continue;
        seen.add(consumer);
        if (targets.has(consumer)) return true;
        next.push(consumer);
      }
    }
    frontier = next;
  }
  return false;
}

function constantValueOf(seedId, chains) {
  if (seedId == null) return null;
  const seen = new Set();
  let current = seedId;
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
    if (current == null || seen.has(current)) return null;
    seen.add(current);
    const constant = chains.constants.get(current);
    if (constant != null) return constant;
    current = chains.sources.get(current) ?? null;
  }
  return null;
}

/**
 * Recovers per-offset member type evidence for accesses through a receiver.
 *
 * @param {object} input
 * @param {object} input.ir
 * @param {(value: object) => boolean} input.isReceiverBase  Predicate deciding whether an SSA value is a `this` alias.
 * @param {number} [input.maxFields]
 * @param {number} [input.maxInstructions]
 */
export function recoverMemberTypeEvidence({
  ir = null,
  isReceiverBase = null,
  maxFields = 256,
  maxInstructions = 8192,
} = {}) {
  if (typeof isReceiverBase !== 'function') throw new TypeError('cpp-member-type-receiver-predicate-required');
  const chains = buildChains(ir, maxInstructions);
  const byOffset = new Map();
  let accesses = 0;
  let truncated = false;
  let scanned = 0;

  for (const inst of ir?.instructions || []) {
    if (scanned++ >= maxInstructions) { truncated = true; break; }
    if (inst.op !== 'load' && inst.op !== 'store') continue;
    const loc = inst.loc ?? null;
    const addrLoc = inst.addr ?? null;
    const indexed = (loc?.index ?? addrLoc?.index) != null;
    // An indexed access has no field location of its own: the decoder reports
    // an unknown location with the index in the address operand.
    if (!indexed && (!loc || loc.kind !== 'field')) continue;
    const base = loc?.base ?? addrLoc?.base ?? null;
    if (!base || !isReceiverBase(base)) continue;
    const offset = toBigInt(loc?.disp ?? addrLoc?.disp ?? 0n) ?? 0n;
    if (offset < 0n) continue;

    const accessBits = inst.dst?.bits ?? inst.args?.[0]?.value?.bits ?? null;
    const size = Number(loc?.size ?? inst.extra?.size
      ?? (Number.isSafeInteger(accessBits) && accessBits > 0 ? accessBits / 8 : 0));
    const signed = inst.op === 'load' ? (typeof inst.extra?.signed === 'boolean' ? inst.extra.signed : null) : null;
    const scale = indexed ? Number(addrLoc?.scale ?? loc?.scale ?? 0) : null;
    const loadValueId = inst.op === 'load' ? valueId(inst.dst) : null;

    let fp = false;
    let boolLike = false;
    let pointerUse = false;
    if (inst.op === 'load') {
      fp = flowsInto(loadValueId, chains.vectorTargets, chains.consumers);
      pointerUse = size === 8 && !indexed && loadValueId != null && (
        chains.addressUsed.has(loadValueId) || flowsInto(loadValueId, chains.addressUsed, chains.consumers)
      );
      if (size === 1 && !fp) boolLike = flowsInto(loadValueId, chains.conditionValues, chains.consumers);
    } else {
      const storedId = valueId(inst.args?.[0]?.value ?? inst.args?.[0]);
      const storedConstant = constantValueOf(storedId, chains);
      if (size === 1 && storedConstant != null && (storedConstant === 0n || storedConstant === 1n)) boolLike = true;
      const storedSource = storedId != null ? chains.sources.get(storedId) : null;
      if (size <= 8) {
        // A store of a value that came straight out of a vector register is
        // float/double evidence for the member.
        fp = [...chains.vectorTargets].some((id) => id === storedId || id === storedSource);
      }
    }

    let entry = byOffset.get(offset);
    if (!entry) {
      if (byOffset.size >= maxFields) { truncated = true; continue; }
      entry = { offset, accesses: [], readCount: 0, writeCount: 0 };
      byOffset.set(offset, entry);
    }
    entry.accesses.push({ size, signed, fp, pointerUse, indexed, scale, boolLike });
    if (inst.op === 'load') entry.readCount++; else entry.writeCount++;
    accesses++;
  }

  const fields = [];
  for (const entry of [...byOffset.values()].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0))) {
    const widths = [...new Set(entry.accesses.map((access) => access.size).filter((size) => Number.isSafeInteger(size) && size > 0))];
    const mixedWidths = widths.length > 1;
    const representative = entry.accesses.find((access) => access.fp)
      || entry.accesses.find((access) => access.pointerUse)
      || entry.accesses.find((access) => access.boolLike)
      || entry.accesses[0];
    // An offset is only array-like when *every* access there is indexed with a
    // scale that matches the element width it proves. Two ways this fails:
    //   - one indexed access alongside a direct access is two different shapes at
    //     the same offset, and picking `representative.indexed` would make the
    //     category depend on instruction order;
    //   - a contradictory scale is a different element type, not the same array.
    const indexedAccesses = entry.accesses.filter((access) => access.indexed);
    const mixedIndexedShape = indexedAccesses.length > 0
      && indexedAccesses.length !== entry.accesses.length;
    const indexedConsistent = indexedAccesses
      .every((access) => (1 << (access.scale ?? 0)) === access.size);
    const classification = mixedWidths
      ? unclassified('mixed-access-widths')
      : mixedIndexedShape
        ? unclassified('mixed-indexed-and-direct-access')
        : !indexedConsistent
          ? unclassified('indexed-access-scale-mismatch')
          : classifyMemberAccess({
            size: representative.size,
            signed: representative.signed,
            fp: representative.fp,
            pointerUse: representative.pointerUse,
            indexed: representative.indexed,
            boolLike: representative.boolLike,
          });
    const kind = classification.category;
    fields.push(Object.freeze({
      offset: entry.offset,
      size: mixedWidths ? Math.max(...widths) : representative.size,
      mixedWidths,
      readCount: entry.readCount,
      writeCount: entry.writeCount,
      indexed: representative.indexed,
      category: kind,
      typeLabel: classification.label,
      signedness: classification.signedness ?? null,
      categoryCandidates: Object.freeze([...(classification.candidates || [])]),
      widthOnly: kind != null && WIDTH_ONLY.has(kind) && classification.signedness == null,
      rule: classification.rule,
      reason: classification.reason ?? null,
    }));
  }

  const report = {
    schema: CPP_MEMBER_TYPE_SCHEMA,
    fields: Object.freeze(fields),
    accessCount: accesses,
    fieldCount: fields.length,
    // A field counts as typed when its meaning is proven (float, pointer,
    // bool-like, array-like, or a proven sign) rather than only its width.
    typedFieldCount: fields.filter((field) => field.category && !field.widthOnly).length,
    widthOnlyFieldCount: fields.filter((field) => field.widthOnly).length,
    truncated,
  };
  report.digest = stableDigest({
    schema: report.schema,
    fields: fields.map((field) => ({ offset: field.offset, size: field.size, category: field.category, label: field.typeLabel })),
  });
  return deepFreeze(report);
}

/**
 * Builds a resolver from member type evidence that hands back the type label
 * only. Field names are never produced here, so a projection can render
 * `this->field_38 /* int32_t|uint32_t *​/` without conflating a name with a type.
 */
export function memberTypeResolver(evidence) {
  const byOffset = new Map();
  for (const field of evidence?.fields || []) {
    if (!field.typeLabel) continue;
    byOffset.set(field.offset.toString(), {
      type: field.typeLabel,
      category: field.category,
      widthOnly: Boolean(field.widthOnly),
      rule: field.rule,
    });
  }
  return (offset) => {
    const key = toBigInt(offset);
    if (key == null) return null;
    const found = byOffset.get(key.toString());
    return found ? { ...found } : null;
  };
}
