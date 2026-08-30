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

function compactProjectedState(projected) {
  const aliases = new Map();
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.MOV || !inst.dst || inst.args?.length !== 1) continue;
    const rawSource = inst.args[0]?.value;
    const source = resolveAlias(rawSource, aliases);
    if (!source) continue;
    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      const provenExactLoadSource = source.compatDerived === 'exact-state-write-source' && source.def?.op === V1_OP.LOAD;
      if (provenExactLoadSource || valueFeedsAddressOrCall(projected, shadow)) {
        aliases.set(shadow.id, source);
        if (source.stateKey == null && shadow.stateKey != null) source.stateKey = shadow.stateKey;
        shadow.compatPublicIdentity = shadow.reg;
        shadow.reg = null;
        shadow.stateKey = null;
        shadow.version = 0;
        shadow.compatDerived = 'state-ssa-address-shadow';
        inst.extra.compatPublicStateSourceValueId = source.id;
        inst.extra.compatStateShadowValueId = shadow.id;
      } else if (source.kind !== V1_VK.ARG && source.def && source !== shadow) {
        source.compatPublicIdentity = source.reg;
        source.reg = null;
        source.stateKey = null;
        source.version = 0;
        source.compatDerived = 'state-write-source-shadow';
        inst.extra.compatPublicStateSourceValueId = source.id;
        inst.extra.compatStateDestinationValueId = shadow.id;
      }
    } else if (inst.extra?.stateRead && inst.extra?.localPhysicalViewProjection === true && Number(source.bits || 0) === Number(inst.dst.bits || 0)) {
      const read = inst.dst;
      aliases.set(read.id, source);
      read.reg = null;
      read.stateKey = null;
      read.version = 0;
      read.compatDerived = 'state-read-shadow';
      inst.extra.compatReachingPublicValueId = source.id;
    }
  }

  if (!aliases.size) return aliases;
  for (const inst of projected.instructions) {
    for (const arg of inst.args || []) if (arg?.value) arg.value = resolveAlias(arg.value, aliases);
    if (inst.conditionValue) inst.conditionValue = resolveAlias(inst.conditionValue, aliases);
    if (inst.addr?.base) inst.addr.base = resolveAlias(inst.addr.base, aliases);
    if (inst.addr?.index) inst.addr.index = resolveAlias(inst.addr.index, aliases);
    if (inst.loc?.base) inst.loc.base = resolveAlias(inst.loc.base, aliases);
    for (const incoming of inst.incoming || []) if (incoming?.value) incoming.value = resolveAlias(incoming.value, aliases);
  }
  for (const loc of projected.locations?.values?.() ?? []) if (loc?.base) loc.base = resolveAlias(loc.base, aliases);
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
    if (inst.sub === 'shl') return uint(a << BigInt(Number(b)), bits);
    if (inst.sub === 'lshr') return uint(uint(a, bits) >> BigInt(Number(b)), bits);
    if (inst.sub === 'ashr') return uint(sint(a, bits) >> BigInt(Number(b)), bits);
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
      useId: forwarding?.useId,
      sourceEntityId: inst.semanticNodeId ?? inst.sourceEntityId,
      nodeId: inst.semanticNodeId ?? inst.sourceEntityId,
      entityId: forwarding?.loadEntityId,
      regionId: forwarding?.loadRegionId,
      range: forwarding?.loadRange,
      artifactDigest: forwarding?.artifactDigest,
      snapshotId: forwarding?.snapshotId,
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

function propagateConstants(projected) {
  const maximum = Math.max(4, projected.instructions.length * 2);
  for (let round = 0; round < maximum; round++) {
    let changed = false;
    for (const inst of projected.instructions) {
      const value = foldInstruction(inst);
      if (value == null || !inst.dst || inst.dst.const === value) continue;
      inst.dst.const = value;
      changed = true;
    }
    if (!changed) break;
  }
}

// The canonical MemorySSA query may need the already-owned scalar SSA fact
// feeding a store.  Populate those scalar constants before the query without
// evaluating any memory load; memory loads remain gated by MemorySSA below.
export function propagateScalarConstants(projected) {
  const maximum = Math.max(4, projected.instructions.length * 2);
  for (let round = 0; round < maximum; round++) {
    let changed = false;
    for (const inst of projected.instructions) {
      if (inst.op === V1_OP.LOAD) continue;
      const value = foldInstruction(inst);
      if (value == null || !inst.dst || inst.dst.const === value) continue;
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

export function finalizeLegacyProjection(projected) {
  compactProjectedState(projected);
  rebuildDefUse(projected);
  suppressUnusedIncomingState(projected);
  normalizePublicStateDefinitionOrder(projected);
  renumberPublicStateVersions(projected);
  recoverLocalStackFlow(projected);
  propagateConstants(projected);
  recoverStackSlots(projected);
  return projected;
}
