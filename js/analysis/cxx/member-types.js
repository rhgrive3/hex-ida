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
 * - an 8-byte loaded value later used as an address base, the witness for a
 *   pointer or object pointer; generic call/return operands are not pointer proof,
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
// Semantic IR expands register copies and truncations into separate nodes.
// Exact input/constant tracing follows one path and retains an explicit cap.
const MAX_INPUT_CHAIN_DEPTH = 32;

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
  const copies = new Map();
  const copyWidths = new Map();
  const copyConversions = new Map();
  const masks = new Map();
  const maskWidths = new Map();
  const consumers = new Map();
  const constants = new Map();
  const vectorTargets = new Set();
  const conditionValues = new Set();
  const addressUsed = new Set();
  const returnInputs = new Set(), comparisonInputs = new Set(), arithmeticInputs = new Set();
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
    if(inst.dst&&inst.op==='bin'&&inst.sub==='and'&&inst.args?.length===2) {
      masks.set(valueId(inst.dst),inst.args.map(argument=>valueId(argument?.value??argument)));
      if(Number.isSafeInteger(inst.dst.bits)&&inst.dst.bits>0&&inst.dst.bits<=64)
        maskWidths.set(valueId(inst.dst),inst.dst.bits);
    }
    const roleTargets = ['ret','return'].includes(inst.op) ? returnInputs
      : ['cmp','cbr'].includes(inst.op) ? comparisonInputs : ['bin','binary'].includes(inst.op) ? arithmeticInputs : null;
    if (roleTargets) for (const arg of inst.args || []) {
      const id=valueId(arg?.value ?? arg);if(id!=null)roleTargets.add(id);
    }
    const dstId = valueId(inst.dst);
    if (dstId != null && (inst.op === 'mov' || inst.op === 'un') && inst.args?.length) {
      const source = valueId(inst.args[0]?.value ?? inst.args[0]);
      if (source != null) {
        sources.set(dstId, source);
        if(inst.op==='mov'&&(inst.sub==null||['copy','trunc','zext','sext'].includes(inst.sub))) {
          const sourceValue=inst.args[0]?.value??inst.args[0];
          const widths=[inst.dst?.bits,sourceValue?.bits].filter(bits=>Number.isSafeInteger(bits)&&bits>0&&bits<=64);
          const malformedWidth=[inst.dst?.bits,sourceValue?.bits].some(bits=>bits!=null
            &&(!Number.isSafeInteger(bits)||bits<1||bits>64));
          if(!malformedWidth&&(inst.sub==null||inst.sub==='copy'||widths.length===2)) {
            copies.set(dstId,source);
            copyWidths.set(dstId,widths.length?Math.min(...widths):64);
            if(['trunc','zext','sext'].includes(inst.sub))
              copyConversions.set(dstId,{kind:inst.sub,sourceBits:sourceValue.bits,destinationBits:inst.dst.bits});
          }
        }
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
  return { sources, copies, copyWidths, copyConversions, masks, maskWidths, consumers, constants, vectorTargets, conditionValues, addressUsed, returnInputs, comparisonInputs, arithmeticInputs };
}

// Exact 0/1 writes may follow copies, never arbitrary unary operations.
function storedBitConstant(seed,chains) {
  const seen=new Set(),conversions=[];let id=seed;
  for(let depth=0;depth<MAX_INPUT_CHAIN_DEPTH&&id!=null;depth++) {
    if(seen.has(id))return null;seen.add(id);
    if(chains.constants.has(id)) {
      let value=chains.constants.get(id);
      for(const conversion of conversions.reverse()) {
        const bits=conversion.kind==='trunc'?conversion.destinationBits:conversion.sourceBits;
        value=conversion.kind==='sext'?BigInt.asIntN(bits,value):BigInt.asUintN(bits,value);
      }
      return value;
    }
    const conversion=chains.copyConversions.get(id);if(conversion)conversions.push(conversion);
    id=chains.copies.get(id);
  }
  return null;
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

function isStoredArgument(seedId, argumentIds, chains) {
  const visited=new Set();let current=seedId;
  for(let depth=0;current!=null&&depth<MAX_INPUT_CHAIN_DEPTH;depth++) {
    if(argumentIds.has(current))return true;
    if(visited.has(current))return false;
    visited.add(current);current=chains.sources.get(current)??null;
  }
  return false;
}

function storedArgumentRegister(seedId, argumentRegisters, chains, requiredBits=1) {
  if(!Number.isSafeInteger(requiredBits)||requiredBits<1||requiredBits>64)return null;
  const seen=new Set();let current=seedId;
  for(let depth=0;current!=null&&depth<MAX_INPUT_CHAIN_DEPTH;depth++) {
    if(seen.has(current))return null;seen.add(current);
    const argument=argumentRegisters.get(current);
    if(argument)return argument.bits>=requiredBits?argument.register:null;
    const maskOperands=chains.masks.get(current);
    if(maskOperands) {
      if((chains.maskWidths.get(current)??0)<requiredBits)return null;
      const requiredMask=(1n<<BigInt(requiredBits))-1n;
      const constantIndex=maskOperands.findIndex(operand=>{
        const mask=storedBitConstant(operand,chains);
        return mask!=null&&(mask&requiredMask)===requiredMask;
      });
      if(constantIndex<0)return null;
      // Masking away bits outside the stored width leaves every stored bit
      // identical to the caller's value. This proves a machine source only.
      current=maskOperands[1-constantIndex];continue;
    }
    // An arbitrary unary expression is argument-derived, but cannot claim
    // the unmodified parameter source. Copy/truncation stores remain explicit
    // machine observations; they do not establish declared field types.
    if((chains.copyWidths.get(current)??0)<requiredBits)return null;
    current=chains.copies.get(current)??null;
  }
  return null;
}

function storedArgumentBit(seedId, argumentRegisters, chains, storeSize) {
  if(!Number.isSafeInteger(storeSize)||storeSize<1||storeSize>8)return null;
  const seen=new Set();let current=seedId,preservedBits=storeSize*8;
  for(let depth=0;current!=null&&depth<MAX_INPUT_CHAIN_DEPTH;depth++) {
    if(seen.has(current))return null;seen.add(current);
    const operands=chains.masks.get(current);
    if(operands) {
      for(let index=0;index<2;index++) {
        const mask=storedBitConstant(operands[index],chains);
        if(mask==null||mask<=0n||mask>0xffffffffffffffffn||(mask&(mask-1n))!==0n)continue;
        let bit=0;for(let value=mask;value>1n;value>>=1n)bit++;
        if(bit>=preservedBits||bit>=64||bit>=(chains.maskWidths.get(current)??0))return null;
        const register=storedArgumentRegister(operands[1-index],argumentRegisters,chains,bit+1);
        return register?`${register}:${bit}`:null;
      }
      return null;
    }
    preservedBits=Math.min(preservedBits,chains.copyWidths.get(current)??0);
    if(preservedBits<1)return null;
    current=chains.copies.get(current)??null;
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
  const argumentIds=new Set((ir?.values??[]).slice(0,maxInstructions)
    .filter(value=>value.kind==='arg').map(value=>valueId(value)).filter(id=>id!=null));
  const argumentRegisters=new Map((ir?.values??[]).slice(0,maxInstructions)
    .filter(value=>value.kind==='arg'&&/^[xw][0-7]$/.test(value.reg??value.label??'')&&valueId(value)!=null)
    .filter(value=>value.bits==null||Number.isSafeInteger(value.bits)&&value.bits>0&&value.bits<=64)
    .map(value=>{
      const register=value.reg??value.label;
      const bits=Number.isSafeInteger(value.bits)&&value.bits>0&&value.bits<=64
        ?value.bits:register.startsWith('w')?32:64;
      return [valueId(value),{register:register.replace(/^w/,'x'),bits}];
    }));
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
    let pointerUse = false,storedRole=null,argumentBit=null;
    if (inst.op === 'load') {
      fp = flowsInto(loadValueId, chains.vectorTargets, chains.consumers);
      pointerUse = size === 8 && !indexed && loadValueId != null && (
        chains.addressUsed.has(loadValueId) || flowsInto(loadValueId, chains.addressUsed, chains.consumers)
      );
      if (size === 1 && !fp) boolLike = flowsInto(loadValueId, chains.conditionValues, chains.consumers);
    } else {
      const storedId = valueId(inst.args?.[0]?.value ?? inst.args?.[0]);
      const storedConstant = constantValueOf(storedId, chains);
      if(storedConstant!=null)storedRole='constant-written';
      else if(isStoredArgument(storedId,argumentIds,chains))storedRole='argument-written';
      const exactStoredConstant=storedBitConstant(storedId,chains);
      argumentBit=storedArgumentBit(storedId,argumentRegisters,chains,size);
      if(argumentBit)storedRole='argument-written';
      if (size === 1 && (exactStoredConstant === 0n || exactStoredConstant === 1n)) boolLike = true;
      if(size===1&&argumentBit?.endsWith(':0'))boolLike=true;
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
      entry = { offset, accesses: [], readCount: 0, writeCount: 0, accessRoles:new Set(),writtenArgumentRegisters:new Set(),writtenArgumentBits:new Set() };
      byOffset.set(offset, entry);
    }
    entry.accesses.push({ size, signed, fp, pointerUse, indexed, scale, boolLike });
    if(storedRole)entry.accessRoles.add(storedRole);
    if(inst.op==='store') {
      if(argumentBit)entry.writtenArgumentBits.add(argumentBit);
      const argumentRegister=storedArgumentRegister(valueId(inst.args?.[0]?.value??inst.args?.[0]),argumentRegisters,chains,size*8);
      if(argumentRegister)entry.writtenArgumentRegisters.add(argumentRegister);
      const literal=storedBitConstant(valueId(inst.args?.[0]?.value??inst.args?.[0]),chains);
      if(literal===0n)entry.accessRoles.add('zero-written');
      if(literal===1n)entry.accessRoles.add('one-written');
    }
    // A bounded extension of the already-built SSA copy/unary chains. These
    // are machine use roles, never source names or semantic field labels.
    if(inst.op==='load')for(const [role,targets] of [['return-input',chains.returnInputs],
      ['comparison-input',chains.comparisonInputs],['arithmetic-input',chains.arithmeticInputs],['address-base',chains.addressUsed]]) {
      if(targets.has(loadValueId)||flowsInto(loadValueId,targets,chains.consumers))entry.accessRoles.add(role);
    }
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
      accessRoles: Object.freeze([...entry.accessRoles].sort()),
      writtenArgumentRegisters: Object.freeze([...entry.writtenArgumentRegisters].sort()),
      writtenArgumentBits: Object.freeze([...entry.writtenArgumentBits].sort().slice(0,8)),
      writtenArgumentBitsTruncated: entry.writtenArgumentBits.size>8,
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
