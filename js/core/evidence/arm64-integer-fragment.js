/** A small proof checker, NOT an analysis owner or a general A64 emulator.
 * It replays only a bounded, contiguous integer fragment from arbitrary entry
 * registers. Claims concern normal sequential completion, not reachability,
 * function entry exclusivity, memory, flags, timing, or the enclosing query.
 * No production decoder, MachineEffects, SCCP, or range arithmetic is imported.
 */
import { snapshotContractData, recordFields, contractFail } from '../identity/structured.js';
import { stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export const INTEGER_FRAGMENT_SCHEMA = 'scpa-a64-integer-fragment/v1';
export const INTEGER_FRAGMENT_KIND = 'scpa-a64-integer-fragment';
export const INTEGER_FRAGMENT_RULE = 'a64-base-integer-sequential-prefix';
export const INTEGER_FRAGMENT_RULE_VERSION = '1.0.0';
export const INTEGER_FRAGMENT_CHECKER_VERSION = '1.0.1';
export const INTEGER_FRAGMENT_MAX_INSTRUCTIONS = 64;
export const INTEGER_FRAGMENT_DOMAIN = Object.freeze({ entry: 'fragment-start-only',
  registers: 'arbitrary-entry-values', completion: 'normal-sequential-only',
  observes: 'integer-register-before-boundary', excludes: 'reachability-memory-flags-timing-exceptions' });
const mask = bits => (1n << BigInt(bits)) - 1n;
const U64 = mask(64);
const unknown = () => ({ zero: 0n, one: 0n });
const exact = (value, bits) => ({ one: value & mask(bits), zero: mask(bits) ^ (value & mask(bits)) });
const singleton = (value, bits) => ((value.zero | value.one) & mask(bits)) === mask(bits) ? value.one & mask(bits) : null;
const decimal = (value, code = 'integer-fragment-unsigned-decimal') => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64) contractFail(code);
  return BigInt(value);
};
const result = (status, reason, detail = {}) => ({ status, reason, detail });

/** These are profile identity formats, not a claim to implement every ISA
 * extension or producer revision. The independent byte checker below accepts
 * only its explicit base-integer opcodes. Current owners use an integer effects
 * revision (e.g. 7), not necessarily a three-part semantic version. Keep native
 * and detached admission identical and never coerce arrays into identities. */
export function supportsIntegerFragmentProfile(profile) {
  const revision = profile?.isaRevision;
  return profile?.endianness === 'le' && profile?.addressBits === 64 && typeof revision === 'string'
    && (revision === 'aarch64-v8' || /^arm64:effects@(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))?$/.test(revision));
}

// A cube is a sound bit-wise upper bound, not a set of independently realizable
// bits. Failed containment on a non-singleton cube is UNKNOWN, not a refutation.
function shiftCube(value, kind, amount, bits) {
  const m = mask(bits), shift = BigInt(amount), low = mask(amount);
  let one = value.one & m, zero = value.zero & m;
  if (!amount) return { one, zero };
  if (kind === 0) return { one: (one << shift) & m, zero: ((zero << shift) | low) & m };
  const high = low << BigInt(bits - amount);
  if (kind === 1) return { one: one >> shift, zero: (zero >> shift) | high };
  if (kind === 2) {
    const sign = 1n << BigInt(bits - 1);
    return { one: (one >> shift) | (one & sign ? high : 0n), zero: (zero >> shift) | (zero & sign ? high : 0n) };
  }
  return { one: ((one >> shift) | (one << BigInt(bits - amount))) & m,
    zero: ((zero >> shift) | (zero << BigInt(bits - amount))) & m };
}

/** Only called by the proof checker (and its tests), never to generate facts. */
export function checkIntegerFragmentBytes(bytes, conclusion, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint();
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 4
    || bytes.length > INTEGER_FRAGMENT_MAX_INSTRUCTIONS * 4) contractFail('integer-fragment-byte-budget');
  recordFields(conclusion, ['register', 'bits', 'constant', 'knownZero', 'knownOne', 'range'], 'integer-fragment-conclusion-fields');
  if (!/^x(?:[0-9]|[12][0-9]|30)$/.test(conclusion.register) || ![32, 64].includes(conclusion.bits)) contractFail('integer-fragment-register-width');
  const bits = conclusion.bits, m = mask(bits);
  const wanted = { zero: decimal(conclusion.knownZero), one: decimal(conclusion.knownOne), constant: conclusion.constant === null ? null : decimal(conclusion.constant) };
  const range = conclusion.range;
  recordFields(range, ['kind', 'lower', 'upper'], 'integer-fragment-range-fields');
  if (!['full', 'interval', 'wrapped'].includes(range.kind)) return result('unknown', 'integer-range-rule-unsupported');
  const lo = decimal(range.lower), hi = decimal(range.upper);
  if ((wanted.zero | wanted.one) > m || (wanted.zero & wanted.one) !== 0n || (wanted.constant !== null && wanted.constant > m)
    || lo > m || hi > m || (range.kind === 'wrapped' ? lo <= hi : lo > hi)
    || (range.kind === 'full' && (lo !== 0n || hi !== m))) contractFail('integer-fragment-inconsistent-conclusion');
  const regs = Array.from({ length: 31 }, unknown);
  const read = (id, width) => id === 31 ? exact(0n, width) : { zero: regs[id].zero & mask(width), one: regs[id].one & mask(width) };
  const write = (id, width, value) => {
    if (id === 31) return;
    const m = mask(width);
    regs[id] = { one: value.one & m, zero: (value.zero & m) | (U64 ^ m) };
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += 4) {
    work.charge('workUnits', 16); work.checkpoint();
    const word = view.getUint32(at, true), width = word >>> 31 ? 64 : 32, rd = word & 31;
    if (word === 0xd503201f) continue; // NOP only; no other hints are assumed inert.
    // Move-wide immediate. opc=01 and W encodings with hw>=2 are unallocated.
    if ((word & 0x1f800000) === 0x12800000) {
      const opc = (word >>> 29) & 3, hw = (word >>> 21) & 3;
      if (opc === 1 || (width === 32 && hw >= 2)) return result('unknown', 'integer-fragment-unallocated-encoding', { at });
      const shift = BigInt(hw * 16), imm = BigInt((word >>> 5) & 65535) << shift;
      if (opc === 0 || opc === 2) write(rd, width, exact(opc === 0 ? ~imm : imm, width));
      else {
        const field = 65535n << shift, old = read(rd, width), keep = mask(width) ^ field;
        write(rd, width, { one: (old.one & keep) | imm, zero: (old.zero & keep) | (field ^ imm) });
      }
      continue;
    }
    // ADD/SUB immediate without flags or SP. No carry-in, faults or memory.
    if ((word & 0x1f800000) === 0x11000000) {
      const rn = (word >>> 5) & 31;
      if ((word & 0x20000000) || rd === 31 || rn === 31) return result('unknown', 'integer-fragment-flags-or-sp-unsupported', { at });
      const input = singleton(read(rn, width), width), imm = BigInt((word >>> 10) & 4095) << BigInt(word & 0x00400000 ? 12 : 0);
      write(rd, width, input === null ? unknown() : exact(word & 0x40000000 ? input - imm : input + imm, width));
      continue;
    }
    // Logical shifted register, including MOV alias and inverted variants.
    // NZCV outputs of ANDS/BICS are deliberately outside the proposition.
    if ((word & 0x1f000000) === 0x0a000000) {
      const opc = (word >>> 29) & 3, amount = (word >>> 10) & 63;
      if (amount >= width) return result('unknown', 'integer-fragment-unallocated-encoding', { at });
      const a = read((word >>> 5) & 31, width);
      let b = shiftCube(read((word >>> 16) & 31, width), (word >>> 22) & 3, amount, width);
      if (word & 0x00200000) b = { one: b.zero, zero: b.one };
      const value = opc === 0 || opc === 3 ? { one: a.one & b.one, zero: a.zero | b.zero }
        : opc === 1 ? { one: a.one | b.one, zero: a.zero & b.zero }
          : { one: (a.one & b.zero) | (a.zero & b.one), zero: (a.one & b.one) | (a.zero & b.zero) };
      write(rd, width, value); continue;
    }
    // A store/branch/call/unknown instruction is a hard cut, NEVER a no-op.
    return result('unknown', 'integer-fragment-opcode-unsupported', { at });
  }
  const actual = read(Number(conclusion.register.slice(1)), bits), value = singleton(actual, bits);
  const lower = actual.one, upper = m ^ actual.zero;
  const inRange = range.kind === 'wrapped' ? lower >= lo || upper <= hi : lower >= lo && upper <= hi;
  const contains = (wanted.zero & actual.zero) === wanted.zero && (wanted.one & actual.one) === wanted.one
    && (wanted.constant === null || wanted.constant === value) && inRange;
  const detail = { steps: bytes.length / 4, bits, lower: lower.toString(), upper: upper.toString(), constant: value?.toString() ?? null,
    domain: INTEGER_FRAGMENT_DOMAIN, ruleId: INTEGER_FRAGMENT_RULE, ruleVersion: INTEGER_FRAGMENT_RULE_VERSION };
  return contains ? result('verified', 'independent-integer-transfer-contained-in-declared-range', detail)
    : value !== null ? result('rejected', 'independent-integer-singleton-contradicts-conclusion', detail)
      : result('unknown', 'integer-transfer-upper-bound-insufficient', detail);
}

/** Private registry wiring. Source membership is re-read, but its equality is
 * not the derivation: the arithmetic check consumes freshly verified bytes.
 */
export function registerIntegerFragmentChecker(registry, { work, onResult = null } = {}) {
  assertScopedAnalysisWork(work);
  return registry.register({ id: 'scpa.a64-independent-integer-fragment', version: INTEGER_FRAGMENT_CHECKER_VERSION,
    semanticKind: INTEGER_FRAGMENT_KIND, level: 'derivation-checked', execution: 'local-bounded', check: async (node, context) => {
      work.checkpoint();
      const checked = value => { onResult?.(value); return { ...value, worldId: context.world.id,
        assumptionsId: context.assumptions.id, nodeId: node.id, propositionChecked: true }; };
      const f = snapshotContractData(node.payload.fragment, { maxBytes: 32768, maxNodes: 1024 });
      recordFields(f, ['schema', 'ruleId', 'ruleVersion', 'worldId', 'assumptionsId', 'snapshotId', 'functionId', 'profile',
        'domain', 'source', 'rangeLocalId', 'semanticValueId', 'premises', 'conclusion'], 'integer-fragment-fields');
      if (f.schema !== INTEGER_FRAGMENT_SCHEMA || f.ruleId !== INTEGER_FRAGMENT_RULE || f.ruleVersion !== INTEGER_FRAGMENT_RULE_VERSION) return checked(result('unknown', 'integer-fragment-rule-unsupported'));
      if (f.worldId !== context.world.id || f.assumptionsId !== context.assumptions.id
        || stableStringify(f.profile) !== stableStringify(context.world.profile)
        || stableStringify(f.domain) !== stableStringify(INTEGER_FRAGMENT_DOMAIN)) return checked(result('rejected', 'integer-fragment-profile-or-scope-mismatch'));
      if (context.assumptions.satisfiability === 'inconsistent') return checked(result('unknown', 'integer-fragment-inconsistent-assumptions'));
      if (!supportsIntegerFragmentProfile(f.profile)) return checked(result('unknown', 'integer-fragment-profile-unsupported'));
      recordFields(f.premises, ['source', 'read', 'range'], 'integer-fragment-premise-fields');
      const source = context.getNode(f.premises.source), readNode = context.getNode(f.premises.read), rangeNode = context.getNode(f.premises.range);
      if (!source || !readNode || !rangeNode) return checked(result('unknown', 'integer-fragment-premise-unavailable'));
      if (new Set(Object.values(f.premises)).size !== 3 || Object.values(f.premises).includes(node.id)
        || source.family !== 'BinaryEvidence' || readNode.semanticKind !== 'scpa-canonical-owner-reference'
        || rangeNode.semanticKind !== 'scpa-demand-range-fact') return checked(result('rejected', 'integer-fragment-premise-kind-mismatch'));
      if (typeof context.hasPremise !== 'function' || !Object.values(f.premises).every(id => context.hasPremise(node.id, id))) return checked(result('unknown', 'integer-fragment-premise-edge-missing'));
      const p = readNode.payload, row = p.ownerRow, r = rangeNode.payload;
      const origin = row?.origin?.byteRanges;
      recordFields(f.source, ['binaryId', 'start', 'end', 'boundary', 'virtualStart', 'virtualBoundary'], 'integer-fragment-source-fields');
      const start = decimal(f.source.start), end = decimal(f.source.end), boundary = decimal(f.source.boundary);
      const virtualStart = decimal(f.source.virtualStart), virtualBoundary = decimal(f.source.virtualBoundary);
      if (end !== boundary + 4n || boundary <= start || boundary - start > BigInt(INTEGER_FRAGMENT_MAX_INSTRUCTIONS * 4)
        || (boundary - start) % 4n || virtualStart % 4n || virtualBoundary - virtualStart !== boundary - start
        || !context.world.binarySet.some(b => b.binaryId === f.source.binaryId)
        || node.binaryId !== f.source.binaryId || source.binaryId !== f.source.binaryId
        || source.origin?.byteRanges?.length !== 1 || source.origin.byteRanges[0].binaryId !== f.source.binaryId
        || source.origin.byteRanges[0].start !== f.source.start || source.origin.byteRanges[0].end !== f.source.end
        || p.reference?.binaryId !== f.source.binaryId || p.reference?.functionId !== f.functionId || p.reference?.snapshotId !== f.snapshotId
        || p.reference?.owner !== 'semantic-ir' || row?.kind !== 'state-read'
        || row.variable?.physicalIdentity?.kind !== 'register' || row.variable.physicalIdentity.registerId !== f.conclusion.register
        || row.attributes?.machineEffects?.architectureId !== 'arm64' || row.attributes.machineEffects.mode !== 'a64'
        || !row.outputs?.includes(f.semanticValueId) || origin?.length !== 1 || origin[0].binaryId !== f.source.binaryId
        || origin[0].start !== f.source.boundary || origin[0].end !== f.source.end
        || !row.origin.virtualRanges?.some(v => BigInt(v.start) === virtualBoundary && BigInt(v.end) === virtualBoundary + 4n)
        || r.ownerIdentity?.functionId !== f.functionId || r.value?.localId !== f.rangeLocalId
        || !r.bindings?.some(b => b.localId === f.rangeLocalId && b.semanticValueId === f.semanticValueId && b.bits === f.conclusion.bits)
        || r.value.conditionalOn?.length) return checked(result('rejected', 'integer-fragment-native-premise-binding-mismatch'));
      const fact = r.value.fact;
      const expected = { register: f.conclusion.register, bits: fact?.bits,
        constant: fact?.constant?.value ?? null, knownZero: fact?.knownZero, knownOne: fact?.knownOne,
        range: { kind: fact?.range?.kind, lower: fact?.range?.lower, upper: fact?.range?.upper } };
      if (stableStringify(expected) !== stableStringify(f.conclusion)) return checked(result('rejected', 'integer-fragment-range-proposition-mismatch'));
      for (const premise of [readNode, rangeNode]) {
        const replay = await registry.check(premise, context, work);
        if (replay.status !== 'verified') return checked(result(replay.status === 'rejected' ? 'rejected' : 'unknown', 'integer-fragment-current-premise-unverified'));
      }
      const bytes = context.getVerifiedBytes?.(source.id, f.source.binaryId, f.source.start, Number(end - start));
      if (!(bytes instanceof Uint8Array) || bytes.length !== Number(end - start)) return checked(result('unknown', 'integer-fragment-current-bytes-unavailable'));
      return checked(checkIntegerFragmentBytes(bytes.subarray(0, Number(boundary - start)), f.conclusion, { work }));
    } });
}
