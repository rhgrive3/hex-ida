import { V1_OP, V1_VK, V1_MK, addUse, safeBigInt } from './semantic-ir-v2-to-v1-core.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  isCanonicalExactMemoryForwarding,
} from '../memoryssa/queries.js';

function resolveAlias(value, aliases) {
  let current = value ?? null;
  const seen = new Set();
  while (current && aliases.has(current.id) && !seen.has(current.id)) {
    seen.add(current.id);
    current = aliases.get(current.id);
  }
  return current;
}

function samePublicState(inst, source, destination) {
  const identity = inst?.extra?.publicStateIdentity;
  return identity != null
    && source != null
    && destination != null
    && source.reg === identity
    && Number(source.bits || 0) === Number(destination.bits || 0);
}


function valueFeedsAddressOrCall(projected, root) {
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || seen.has(value.id)) continue;
    seen.add(value.id);
    for (const inst of projected.instructions) {
      if (inst.addr?.base === value || inst.addr?.index === value || inst.loc?.base === value) return true;
      const consumes = (inst.args || []).some((arg) => arg?.value === value);
      if (!consumes) continue;
      if (inst.op === V1_OP.CALL) return true;
      if (inst.op === V1_OP.MOV && inst.dst) queue.push(inst.dst);
    }
  }
  return false;
}

const stateIdentityKeys = ['reg', 'stateKey', 'version', 'compatPublicIdentity', 'compatDerived'];

function stateIdentity(value) {
  return Object.freeze(Object.fromEntries(stateIdentityKeys.map(key => [key, value?.[key]])));
}

function describeStateOperation(observer, description) {
  if (!observer) return null;
  const keys = [description.source, description.identity ? description.output : description.object].filter(Boolean);
  for (const key of keys) observer.expected.add(key);
  if (observer.records.length >= 1024 || description.beforeInputs.length > 512 || description.unavailable) {
    for (const key of keys) observer.unavailable.add(key);
    return null;
  }
  const event = Object.freeze({ ...description, op:description.source?.op, sub:description.source?.sub,
    bits:description.output?.bits, ordinal:observer.records.length,
    identityFields:description.identity ? Object.freeze(stateIdentityKeys.filter(key => !Object.is(description.before[key], description.after[key]))) : null,
    keys:Object.freeze(keys), beforeInputs:Object.freeze(description.beforeInputs),
    inputs:Object.freeze(description.beforeInputs.map(value => Object.freeze({ value, definition:value.def }))) });
  observer.records.push(event);
  return event;
}

// Read the actual already-established alias decisions without deciding any new
// aliases. A missing/bounded cause cannot be reconstructed from public flags.
function stateAliasLineage(before, aliases, aliasEvents) {
  const causes = [], values = new Set([before]), seen = new Set();
  let current = before, unavailable = false;
  while (current && aliases.has(current.id) && !seen.has(current.id)) {
    if (seen.size >= 512) { unavailable = true; break; }
    seen.add(current.id);
    const event = aliasEvents.get(current.id);
    if (!event) { unavailable = true; break; }
    causes.push(event);
    for (const value of event.beforeInputs) values.add(value);
    if (values.size > 512) { unavailable = true; break; }
    current = aliases.get(current.id);
  }
  return { causes:Object.freeze(causes), values, unavailable };
}

function compactProjectedState(projected, observer = null) {
  const aliases = new Map();
  const aliasEvents = new Map();
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.MOV || !inst.dst || inst.args?.length !== 1) continue;
    const rawSource = inst.args[0]?.value;
    const source = resolveAlias(rawSource, aliases);
    if (!source) continue;
    const lineage = observer && stateAliasLineage(rawSource, aliases, aliasEvents);
    const history = output => ({ causes:lineage?.causes, unavailable:lineage?.unavailable,
      beforeInputs:[...new Set([rawSource, source, output, ...(lineage?.values || [])])] });
    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      const provenExactLoadSource = source.compatDerived === 'exact-state-write-source' && source.def?.op === V1_OP.LOAD;
      if (provenExactLoadSource || valueFeedsAddressOrCall(projected, shadow)) {
        const before = observer && stateIdentity(shadow);
        aliases.set(shadow.id, source);
        if (source.stateKey == null && shadow.stateKey != null) {
          const sourceBefore = observer && stateIdentity(source);
          source.stateKey = shadow.stateKey;
          describeStateOperation(observer, { source:inst, output:source, input:shadow, identity:true,
            kind:'state-key-transfer', before:sourceBefore, after:observer && stateIdentity(source),
            ...history(shadow) });
        }
        shadow.compatPublicIdentity = shadow.reg;
        shadow.reg = null;
        shadow.stateKey = null;
        shadow.version = 0;
        shadow.compatDerived = 'state-ssa-address-shadow';
        inst.extra.compatPublicStateSourceValueId = source.id;
        inst.extra.compatStateShadowValueId = shadow.id;
        const event = describeStateOperation(observer, { source:inst, output:shadow, input:source, identity:true,
          kind:'state-write-address-shadow', before, after:observer && stateIdentity(shadow),
          ...history(shadow) });
        if (observer && event) aliasEvents.set(shadow.id, event);
      } else if (source.kind !== V1_VK.ARG && source.def && source !== shadow) {
        const before = observer && stateIdentity(source);
        source.compatPublicIdentity = source.reg;
        source.reg = null;
        source.stateKey = null;
        source.version = 0;
        source.compatDerived = 'state-write-source-shadow';
        inst.extra.compatPublicStateSourceValueId = source.id;
        inst.extra.compatStateDestinationValueId = shadow.id;
        describeStateOperation(observer, { source:inst, output:source, input:shadow, identity:true,
          kind:'state-write-source-shadow', before, after:observer && stateIdentity(source),
          ...history(shadow) });
      }
    } else if (inst.extra?.stateRead && inst.extra?.localPhysicalViewProjection === true && Number(source.bits || 0) === Number(inst.dst.bits || 0)) {
      const read = inst.dst;
      const before = observer && stateIdentity(read);
      aliases.set(read.id, source);
      read.reg = null;
      read.stateKey = null;
      read.version = 0;
      read.compatDerived = 'state-read-shadow';
      inst.extra.compatReachingPublicValueId = source.id;
      const event = describeStateOperation(observer, { source:inst, output:read, input:source, identity:true,
        kind:'state-read-shadow', before, after:observer && stateIdentity(read),
        ...history(read) });
      if (observer && event) aliasEvents.set(read.id, event);
    }
  }

  if (!aliases.size) return aliases;
  const replace = (object, key, inst, path) => {
    const before = object[key], after = resolveAlias(before, aliases);
    object[key] = after;
    if (!observer || before === after) return;
    const { causes, values, unavailable } = stateAliasLineage(before, aliases, aliasEvents);
    values.add(after);
    describeStateOperation(observer, { source:inst, output:inst?.dst, input:after,
      kind:'resolve-state-alias', object, key, path, before, after,
      causes, beforeInputs:[...values], unavailable });
  };
  for (const inst of projected.instructions) {
    for (const [index, arg] of (inst.args || []).entries()) if (arg?.value) replace(arg, 'value', inst, `args:${index}`);
    if (inst.conditionValue) replace(inst, 'conditionValue', inst, 'conditionValue');
    if (inst.addr?.base) replace(inst.addr, 'base', inst, 'addr:base');
    if (inst.addr?.index) replace(inst.addr, 'index', inst, 'addr:index');
    if (inst.loc?.base) replace(inst.loc, 'base', inst, 'loc:base');
    for (const [index, incoming] of (inst.incoming || []).entries()) if (incoming?.value) replace(incoming, 'value', inst, `incoming:${index}`);
  }
  for (const loc of projected.locations?.values?.() ?? []) if (loc?.base) replace(loc, 'base', null, 'locations:base');
  return aliases;
}

function rebuildDefUse(projected) {
  const visible = new Set(projected.instructions);
  for (const value of projected.values) {
    value.uses = [];
    if (value.def && !visible.has(value.def)) value.def = null;
  }
  for (const inst of projected.instructions) {
    if (inst.dst) inst.dst.def = inst;
    for (const arg of inst.args || []) if (arg?.value) addUse(arg.value, inst);
    if (inst.conditionValue) addUse(inst.conditionValue, inst);
    if (inst.addr?.base) addUse(inst.addr.base, inst);
    if (inst.addr?.index) addUse(inst.addr.index, inst);
    for (const incoming of inst.incoming || []) if (incoming?.value) addUse(incoming.value, inst);
  }

  const transparent = (inst) => inst?.op === V1_OP.MOV && inst.dst != null;
  for (const root of projected.values) {
    if (!root.reg || root.kind === V1_VK.ARG) continue;
    const queue = [...root.uses];
    const seen = new Set();
    while (queue.length) {
      const inst = queue.shift();
      if (!inst || seen.has(inst)) continue;
      seen.add(inst);
      if (transparent(inst)) {
        for (const use of inst.dst?.uses || []) queue.push(use);
        continue;
      }
      addUse(root, inst);
    }
  }
}

function suppressUnusedIncomingState(projected) {
  const defined = new Set(projected.values
    .filter((value) => value.kind !== V1_VK.ARG && value.reg && value.def)
    .map((value) => value.reg));
  for (const value of projected.values) {
    if (value.kind !== V1_VK.ARG || !value.reg || (value.uses?.length ?? 0) !== 0 || !defined.has(value.reg)) continue;
    value.compatPublicIdentity = value.reg;
    value.reg = null;
    value.stateKey = null;
    value.version = 0;
    value.compatDerived = 'unused-entry-state-shadow';
  }
}


function normalizePublicStateDefinitionOrder(projected) {
  const slots = [];
  const definitions = [];
  for (let index = 0; index < projected.values.length; index++) {
    const value = projected.values[index];
    if (!value?.reg || value.kind !== V1_VK.DEF || !value.def) continue;
    slots.push(index);
    definitions.push(value);
  }
  definitions.sort((left, right) => {
    const a = left.def;
    const b = right.def;
    if ((a.block ?? 0) !== (b.block ?? 0)) return (a.block ?? 0) - (b.block ?? 0);
    if ((a.row ?? 0) !== (b.row ?? 0)) return (a.row ?? 0) - (b.row ?? 0);
    if ((a.id ?? 0) !== (b.id ?? 0)) return (a.id ?? 0) - (b.id ?? 0);
    return (left.id ?? 0) - (right.id ?? 0);
  });
  for (let index = 0; index < slots.length; index++) projected.values[slots[index]] = definitions[index];
}

function renumberPublicStateVersions(projected) {
  const nextByIdentity = new Map();
  for (const value of projected.values) {
    if (!value.reg) continue;
    if (value.kind === V1_VK.ARG) {
      value.version = 0;
      continue;
    }
    if (!value.def) continue;
    const next = (nextByIdentity.get(value.reg) ?? 0) + 1;
    nextByIdentity.set(value.reg, next);
    value.version = next;
  }
}

function mask(bits) { return (1n << BigInt(Math.max(1, Number(bits || 64)))) - 1n; }
function uint(value, bits) { return BigInt.asUintN(Math.max(1, Number(bits || 64)), BigInt(value)); }
function sint(value, bits) { return BigInt.asIntN(Math.max(1, Number(bits || 64)), BigInt(value)); }
function ror(value, amount, bits) {
  const width = Math.max(1, Number(bits || 64));
  const shift = Number(BigInt(amount) % BigInt(width));
  const input = uint(value, width);
  if (shift === 0) return input;
  return uint((input >> BigInt(shift)) | (input << BigInt(width - shift)), width);
}

function foldInstruction(inst) {
  const dst = inst.dst;
  if (!dst) return null;
  const args = (inst.args || []).map((arg) => arg?.value?.const ?? null);
  const bits = Math.max(1, Number(dst.bits || 64));
  if (inst.op === V1_OP.CONST) {
    const raw = inst.extra?.value;
    return raw == null ? dst.const : uint(raw, bits);
  }
  if (inst.op === V1_OP.MOV && args.length === 1 && args[0] != null) return uint(args[0], bits);
  if (inst.op === V1_OP.UN && args.length === 1 && args[0] != null) {
    if (inst.sub === 'neg') return uint(-args[0], bits);
    if (inst.sub === 'not') return uint(~args[0], bits);
    if (inst.sub === 'is-zero') return args[0] === 0n ? 1n : 0n;
    if (inst.sub === 'sext') {
      const sourceBits = Number(inst.extra?.sourceBits ?? inst.args?.[0]?.value?.bits ?? bits);
      return uint(sint(args[0], sourceBits), bits);
    }
  }
  if (inst.op === V1_OP.BIN && args.length >= 2 && args[0] != null && args[1] != null) {
    const [a, b] = args;
    if (inst.sub === 'add') return uint(a + b, bits);
    if (inst.sub === 'sub') return uint(a - b, bits);
    if (inst.sub === 'mul') return uint(a * b, bits);
    if (inst.sub === 'and') return uint(a & b, bits);
    if (inst.sub === 'or') return uint(a | b, bits);
    if (inst.sub === 'xor') return uint(a ^ b, bits);
    if (inst.sub === 'shl' || inst.sub === 'lshr' || inst.sub === 'ashr') {
      // Compare the original integer count before shifting. Converting an
      // unbounded bigint through Number() can round it or produce Infinity,
      // and BigInt(Infinity) throws before the width guard (#5852).
      if (!Number.isSafeInteger(bits)) return null;
      const shift = typeof b === 'bigint'
        ? b
        : (typeof b === 'number' && Number.isSafeInteger(b) ? BigInt(b) : null);
      if (shift == null || shift < 0n || shift >= BigInt(bits)) return null;
      if (inst.sub === 'shl') return uint(a << shift, bits);
      if (inst.sub === 'lshr') return uint(uint(a, bits) >> shift, bits);
      return uint(sint(a, bits) >> shift, bits);
    }
    if (inst.sub === 'ror') return ror(a, b, bits);
    if (inst.sub === 'eq') return a === b ? 1n : 0n;
  }
  if (inst.op === V1_OP.BFX && args.length >= 1 && args[0] != null) {
    const lsb = Number(inst.extra?.lsb);
    const width = Number(inst.extra?.width);
    if (Number.isInteger(lsb) && lsb >= 0 && Number.isInteger(width) && width > 0) {
      const field = (uint(args[0], inst.args?.[0]?.value?.bits ?? bits) >> BigInt(lsb)) & mask(width);
      if (inst.extra?.signed === true) return uint(BigInt.asIntN(width, field), bits);
      return uint(field, bits);
    }
  }
  if (inst.op === V1_OP.LOAD && Object.hasOwn(inst, 'memoryForwarding')) {
    const forwarding = inst.memoryForwarding;
    if (isCanonicalExactMemoryForwarding(forwarding, canonicalMemoryForwardingContext(forwarding, {
      ...inst.memoryForwardingContext,
      consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
      purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    })) && forwarding.value != null) {
      return uint(forwarding.value, bits);
    }
    // The legacy reachingStore field is structural compatibility metadata, not
    // an independent MemorySSA proof.  Once canonical forwarding ran, any
    // non-exact result must remain unknown all the way to the public value.
    return null;
  }
  return null;
}

function observeConstantWrite(inst, value, round, stage, observer) {
  if (!observer) return;
  observer.expected.add(inst);
  if (observer.records.length >= 1024 || (inst.args?.length ?? 0) > 512) {
    observer.unavailable.add(inst); return;
  }
  const inputs = Object.freeze((inst.args || []).map(arg => Object.freeze({
    argument:arg, value:arg?.value, definition:arg?.value?.def,
    constant:arg?.value?.const ?? null, bits:arg?.value?.bits ?? null,
  })));
  observer.records.push(Object.freeze({
    source:inst, output:inst.dst, op:inst.op, sub:inst.sub, bits:inst.dst.bits,
    beforeConstant:inst.dst.const, afterConstant:value, round, stage, ordinal:observer.records.length, inputs,
    beforeInputs:Object.freeze([...new Set([...inputs.map(input => input.value),
      inst.addr?.base, inst.addr?.index, inst.loc?.base].filter(Boolean))]),
    memoryForwarding:inst.op === V1_OP.LOAD ? inst.memoryForwarding : null,
  }));
}

function propagateConstants(projected, observer) {
  const maximum = Math.max(4, projected.instructions.length * 2);
  for (let round = 0; round < maximum; round++) {
    let changed = false;
    for (const inst of projected.instructions) {
      const value = foldInstruction(inst);
      if (value == null || !inst.dst || inst.dst.const === value) continue;
      observeConstantWrite(inst, value, round, 'finalize-constants', observer);
      inst.dst.const = value;
      changed = true;
    }
    if (!changed) break;
  }
}

// The canonical MemorySSA query may need the already-owned scalar SSA fact
// feeding a store.  Populate those scalar constants before the query without
// evaluating any memory load; memory loads remain gated by MemorySSA below.
export function propagateScalarConstants(projected, observer = null) {
  const maximum = Math.max(4, projected.instructions.length * 2);
  for (let round = 0; round < maximum; round++) {
    let changed = false;
    for (const inst of projected.instructions) {
      if (inst.op === V1_OP.LOAD) continue;
      const value = foldInstruction(inst);
      if (value == null || !inst.dst || inst.dst.const === value) continue;
      observeConstantWrite(inst, value, round, 'pre-memory-scalar-constants', observer);
      inst.dst.const = value;
      changed = true;
    }
    if (!changed) break;
  }
}

function recoverLocalStackFlow(projected) {
  // Stack-flow recovery used to mint a private linear reaching-definition
  // relation after canonical MemorySSA had declined to publish a fact. That
  // fallback could turn an unknown/call-clobbered load into an exact value.
  // Canonical MemorySSA is now the sole producer of reaching-store facts.
  void projected;
}

function recoverStackSlots(projected) {
  const byKey = new Map();
  for (const inst of projected.instructions) {
    if ((inst.op !== V1_OP.LOAD && inst.op !== V1_OP.STORE) || inst.loc?.kind !== V1_MK.STACK) continue;
    const disp = safeBigInt(inst.loc.disp) ?? 0n;
    let slot = byKey.get(inst.loc.key);
    if (!slot) {
      const magnitude = disp < 0n ? -disp : disp;
      slot = {
        key: inst.loc.key,
        name: `${disp < 0n ? 'var_m' : 'var_'}${magnitude.toString(16)}`,
        offset: disp,
        disp,
        size: inst.loc.size ?? inst.extra?.size ?? null,
        reads: 0,
        writes: 0,
        location: inst.loc,
      };
      byKey.set(inst.loc.key, slot);
    }
    if (inst.op === V1_OP.LOAD) slot.reads += 1;
    else slot.writes += 1;
    inst.slot = slot;
  }
  const slots = [...byKey.values()];
  const signsByMagnitude = new Map();
  for (const slot of slots) {
    const magnitude = slot.offset < 0n ? -slot.offset : slot.offset;
    let signs = signsByMagnitude.get(magnitude.toString());
    if (!signs) { signs = { positive:false, negative:false }; signsByMagnitude.set(magnitude.toString(), signs); }
    if (slot.offset < 0n) signs.negative = true;
    else signs.positive = true;
  }
  for (const slot of slots) {
    if (slot.offset < 0n) continue;
    const magnitude = slot.offset;
    const signs = signsByMagnitude.get(magnitude.toString());
    if (signs?.positive && signs?.negative) slot.name = `var_p${magnitude.toString(16)}`;
  }
  projected.stackSlots = slots.sort((left, right) => left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : left.key.localeCompare(right.key));
}

export function finalizeLegacyProjection(projected, observer = null, stateObserver = null) {
  compactProjectedState(projected, stateObserver);
  rebuildDefUse(projected);
  suppressUnusedIncomingState(projected);
  normalizePublicStateDefinitionOrder(projected);
  renumberPublicStateVersions(projected);
  recoverLocalStackFlow(projected);
  propagateConstants(projected, observer);
  recoverStackSlots(projected);
  return projected;
}
