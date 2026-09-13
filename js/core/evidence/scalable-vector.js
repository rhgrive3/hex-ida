/** Conditional L01 checker. A bounded, explicit VL/predicate model is NOT an
 * instruction decoder, an architectural owner, or A7 family qualification.
 * First-fault load outcomes are supplied by a current private model owner;
 * suppressed/previously invalid lanes remain unknown, never zero-filled proof.
 */
import { snapshotContractData, recordFields, exactInteger, exactBoolean, exactEnum, contractFail } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
export const SCALABLE_VECTOR_SCHEMA = 'scpa-scalable-vector-model/v1';
export const SCALABLE_VECTOR_VERSION = '1.0.0';
const OPS = ['add', 'sub', 'and', 'orr', 'eor'];
const limits = { maxBytes: 131072, maxNodes: 8192 };
function vector(a, length, read, name) {
  if (!Array.isArray(a) || a.length !== length) contractFail(`vector-${name}-length`);
  return a.map((v, i) => read(v, i));
}
function integer(v, bits) {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) >= (1n << BigInt(bits))) contractFail('vector-lane-integer');
  return BigInt(v);
}
export function checkScalableVectorModel(modelInput, claimInput = null, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint(); work.charge('workUnits');
  const m = snapshotContractData(modelInput, limits), claim = snapshotContractData(claimInput, limits);
  work.charge('residentBytes', (stableStringify(m).length + stableStringify(claim).length) * 2);
  const common = ['schema', 'family', 'vlBits', 'elementBits', 'predicate', 'streaming'];
  if (m.schema !== SCALABLE_VECTOR_SCHEMA) contractFail('vector-schema');
  exactEnum(m.family, ['integer-lanes', 'first-fault-load'], 'vector-family');
  recordFields(m, [...common, ...(m.family === 'integer-lanes' ? ['operation', 'lhs', 'rhs', 'previous', 'inactive'] : ['ffr', 'accesses'])], 'vector-model-fields');
  const vl = exactInteger(m.vlBits, 'vector-vl', { min: 128, max: 2048 });
  if (vl % 128) contractFail('vector-vl');
  const bits = exactInteger(m.elementBits, 'vector-element-bits', { min: 8, max: 64 });
  if (![8, 16, 32, 64].includes(bits)) contractFail('vector-element-bits');
  const streaming = exactBoolean(m.streaming, 'vector-streaming');
  const count = vl / bits, stride = bits / 8, bool = v => exactBoolean(v, 'vector-predicate-bit');
  // SVE predicates have one bit per BYTE, not one bit per element.
  const pg = vector(m.predicate, vl / 8, bool, 'predicate');
  let output = [], ffr = null, synchronousFault = null;
  const accesses = [], unknownLanes = [];
  if (m.family === 'integer-lanes') {
    const op = exactEnum(m.operation, OPS, 'vector-operation'), inactive = exactEnum(m.inactive, ['merge', 'zero'], 'vector-inactive');
    const lhs = vector(m.lhs, count, v => integer(v, bits), 'lhs'), rhs = vector(m.rhs, count, v => integer(v, bits), 'rhs');
    const previous = vector(m.previous, count, v => integer(v, bits), 'previous'), mask = (1n << BigInt(bits)) - 1n;
    for (let i = 0; i < count; i++) {
      work.checkpoint(); work.charge('workUnits');
      const a = lhs[i], b = rhs[i];
      const n = !pg[i * stride] ? (inactive === 'merge' ? previous[i] : 0n)
        : op === 'add' ? a + b : op === 'sub' ? a - b : op === 'and' ? a & b : op === 'orr' ? a | b : a ^ b;
      output.push((n & mask).toString());
    }
  } else {
    if (streaming) return deepFreeze({ status: 'unknown', reason: 'streaming-first-fault-feature-not-qualified', exact: false, semanticProof: false, releaseQualified: false });
    ffr = vector(m.ffr, vl / 8, bool, 'ffr');
    const memory = vector(m.accesses, count, raw => {
      recordFields(raw, ['kind', 'value'], 'vector-access-fields');
      exactEnum(raw.kind, ['loaded', 'suppressed', 'fault', 'inactive'], 'vector-access-kind');
      if (raw.kind === 'loaded') integer(raw.value, bits);
      else if (raw.value !== undefined) contractFail('vector-nonload-value');
      return raw;
    }, 'accesses');
    let first = true, faulted = false, unknown = false;
    for (let i = 0; i < count; i++) {
      work.checkpoint(); work.charge('workUnits');
      const active = pg[i * stride], a = memory[i];
      if (!active && a.kind !== 'inactive') contractFail('vector-inactive-access');
      if (active) {
        if (a.kind === 'inactive' || (!first && a.kind === 'fault') || (first && a.kind === 'suppressed')) contractFail('vector-first-fault-outcome');
        accesses.push({ lane: i, outcome: a.kind });
        if (first && a.kind === 'fault') { synchronousFault = { lane: i }; output = null; ffr = null; break; }
        first = false; faulted ||= a.kind === 'suppressed';
      }
      // The model reports the chosen suppressed-access outcome. Architectural
      // nonfaulting loads may also suppress spontaneously; no success assumption
      // is manufactured from an address or a readable local buffer.
      if (faulted) for (let b = i * stride; b < (i + 1) * stride; b++) ffr[b] = false;
      unknown ||= !ffr[i * stride];
      if (unknown) { output.push(null); unknownLanes.push(i); }
      else output.push(active ? a.value : '0');
    }
  }
  let firstFailure = null;
  if (claim !== null) {
    recordFields(claim, ['output', 'ffr', 'synchronousFault'], 'vector-claim-fields');
    const expected = { output, ffr, synchronousFault };
    for (const k of Object.keys(expected)) {
      if (stableStringify(claim[k] ?? null) !== stableStringify(expected[k])) { firstFailure = { field: k, reason: 'model-output-mismatch' }; break; }
    }
  }
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-scalable-vector-result/v1', checkerVersion: SCALABLE_VECTOR_VERSION,
    status: firstFailure ? 'rejected' : claim ? 'verified-model' : 'derived-model', firstFailure,
    vlBits: vl, elementBits: bits, output, ffr, synchronousFault, unknownLanes, accesses,
    exact: false, semanticProof: false, rewriteAuthorized: false, releaseQualified: false,
    remaining: ['explicit-VL-only; no-all-vector-length-qualification', 'predicate-model-not-instruction-encoding',
      'native-source-model-correspondence-unproved', 'memory-fault-outcomes-are-owner-premises', 'SVE2-and-A7-family-qualification-open'] });
}
