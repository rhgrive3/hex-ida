/** L02: check one NORMAL-return call boundary under an explicit, versioned SME
 * ABI model. No matrix-operation semantics, automatic ABI inference, exception
 * handling, lazy-save memory execution or ZT0 preservation is invented.
 */
import { snapshotContractData, recordFields, exactInteger, exactBoolean, exactString, exactEnum, contractFail } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
export const SME_CALL_SCHEMA = 'scpa-sme-call-frame/v1';
export const SME_ABI_MODEL = 'aapcs64-2025Q4-2026-03-03-subset/v1';
const nullableId = (v, code) => v === null ? null : exactString(v, code, 256);
function state(v) {
  recordFields(v, ['sm', 'za', 'tpidr2', 'zaDigest', 'zt0Digest', 'blockDigest'], 'sme-state-fields');
  exactBoolean(v.sm, 'sme-sm'); exactBoolean(v.za, 'sme-za'); nullableId(v.tpidr2, 'sme-tpidr2');
  nullableId(v.blockDigest, 'sme-block-digest');
  if (v.tpidr2 === null && v.blockDigest !== null) contractFail('sme-block-without-token');
  nullableId(v.zaDigest, 'sme-za-digest'); nullableId(v.zt0Digest, 'sme-zt0-digest');
  if (!v.za && v.zaDigest !== null) contractFail('sme-disabled-za-value');
  return v;
}
export function checkSmeCallFrame(input, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint(); work.charge('workUnits', 32);
  const m = snapshotContractData(input, { maxBytes: 32768, maxNodes: 512 });
  work.charge('residentBytes', stableStringify(m).length * 2);
  recordFields(m, ['schema', 'abiModel', 'interface', 'entry', 'exit', 'lazySave', 'normalReturn', 'svlBytes'], 'sme-frame-fields');
  if (m.schema !== SME_CALL_SCHEMA) contractFail('sme-schema');
  exactString(m.abiModel, 'sme-abi-model'); exactBoolean(m.normalReturn, 'sme-normal-return');
  const svl = exactInteger(m.svlBytes, 'sme-svl', { min: 16, max: 256 });
  if (svl % 16) contractFail('sme-svl');
  recordFields(m.interface, ['sm', 'za', 'preservesZT0'], 'sme-interface-fields');
  exactEnum(m.interface.sm, ['non-streaming', 'streaming', 'streaming-compatible'], 'sme-sm-interface');
  exactEnum(m.interface.za, ['private', 'shared'], 'sme-za-interface');
  exactBoolean(m.interface.preservesZT0, 'sme-preserves-zt0');
  const entry = state(m.entry), exit = state(m.exit), obligations = [];
  const add = (name, condition) => obligations.push({ name, status: condition === null ? 'unknown' : condition ? 'checked-model' : 'rejected' });
  const sameKnown = (a, b) => a === null || b === null ? null : a === b;
  let restoration = 'not-required', savedSlices = null;
  if (m.abiModel !== SME_ABI_MODEL || !m.normalReturn) return deepFreeze({ status: 'unknown', reason: 'SME-version-or-nonnormal-return-unmodeled', exact: false, semanticProof: false });
  add('streaming-entry', m.interface.sm === 'streaming-compatible' || entry.sm === (m.interface.sm === 'streaming'));
  add('streaming-return', exit.sm === entry.sm);
  if ((!entry.za && entry.tpidr2 !== null) || (!exit.za && exit.tpidr2 !== null)) return deepFreeze({ status: 'unknown', reason: 'off-with-nonnull-empty-save-block-unmodeled', exact: false, semanticProof: false });
  if (m.interface.za === 'shared') {
    add('shared-ZA-active-at-entry-and-return', entry.za && exit.za && entry.tpidr2 === null && exit.tpidr2 === null);
    if (m.lazySave !== null) contractFail('sme-shared-lazy-save');
    // Shared ZA is an explicit input/output, not an unchanged-value promise.
  } else {
    add('private-ZA-entry-off-or-dormant', !entry.za || entry.tpidr2 !== null);
    add('private-ZA-return-off-or-dormant', !exit.za || exit.tpidr2 !== null);
    if (entry.tpidr2 !== null) {
      const s = m.lazySave;
      if (s === null) { add('lazy-save-description', null); restoration = 'unknown'; }
      else {
        recordFields(s, ['blockId', 'sliceCount', 'bufferBytes', 'reservedZero', 'savedDigest'], 'sme-save-fields');
        exactString(s.blockId, 'sme-save-block', 256);
        const n = exactInteger(s.sliceCount, 'sme-save-slices', { min: 1, max: svl });
        const capacity = exactInteger(s.bufferBytes, 'sme-save-capacity', { max: 65536 });
        exactBoolean(s.reservedZero, 'sme-reserved-zero'); nullableId(s.savedDigest, 'sme-save-digest');
        savedSlices = n; add('lazy-save-block-identity', s.blockId === entry.tpidr2);
        add('lazy-save-capacity-and-reserved-bytes', capacity >= Math.ceil(n / 16) * 16 * svl && capacity % (16 * svl) === 0);
        if (!s.reservedZero) add('reserved-byte-version', null);
        if (exit.tpidr2 === entry.tpidr2) {
          add('unchanged-TPIDR2-block', sameKnown(entry.blockDigest, exit.blockDigest));
          add('uncommitted-save-preserves-ZA', exit.za ? sameKnown(entry.zaDigest, exit.zaDigest) : false);
          if (entry.zaDigest === null || exit.zaDigest === null) restoration = 'unknown';
        } else if (exit.tpidr2 === null) {
          // These digests denote only the DECLARED live slices, not the entire
          // architectural array. A host must supply actual saved-byte evidence.
          add('committed-save-live-slices', sameKnown(entry.zaDigest, s.savedDigest));
          restoration = 'required-from-declared-save-buffer';
        } else { add('return-save-token', false); restoration = 'unknown'; }
      }
    } else {
      if (m.lazySave !== null) contractFail('sme-save-without-entry-token');
      add('private-return-no-new-save-token', exit.tpidr2 === null);
    }
  }
  if (m.interface.preservesZT0) add('ZT0-explicit-preservation', sameKnown(entry.zt0Digest, exit.zt0Digest));
  const rejected = obligations.find(x => x.status === 'rejected'), unknown = obligations.some(x => x.status === 'unknown');
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-sme-call-result/v1', status: rejected ? 'rejected' : unknown ? 'unknown' : 'verified-model',
    firstFailure: rejected ?? null, obligations, restoration, savedSlices, zaBytes: svl * svl,
    zt0: m.interface.preservesZT0 ? 'explicit-promise-checked-separately' : 'caller-saved; not-covered-by-ZA-lazy-save',
    exact: false, semanticProof: false, rewriteAuthorized: false, releaseQualified: false,
    remaining: ['normal-return-boundary-only', 'source-and-saved-byte-correspondence-unproved',
      'SME-SME2-instruction-families-and-exceptions-unqualified', 'measured-workload-trigger-unmet'] });
}
