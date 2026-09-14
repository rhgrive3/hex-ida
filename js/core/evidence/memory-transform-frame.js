/** Frame check for a projection that changes ONLY typed expression views.
 * No store forwarding, alias inference, load elimination, or reorder theorem.
 * Both full canonical MSSA frames and ordered opaque AST load events are needed.
 */
import { deepFreeze, stableStringify, lossyTypeWitness } from '../identity/index.js';
import { snapshotContractData, recordFields, exactString } from '../identity/structured.js';
export const MEMORY_VIEW_FRAME_SCHEMA = 'scoped-memory-view-frame/v1';
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
/** Bounded first divergence, not a second memory/alias solver. Values are
 * summarized so an explanation never dumps the complete MSSA or byte payload. */
function firstDivergence(before, after, work) {
  const kind = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const brief = v => {
    const type = kind(v);
    if (type === 'array') return { type, length: v.length };
    if (type === 'object') return { type, fields: Object.keys(v).length };
    const text = type === 'bigint' ? v.toString() : String(v);
    return { type, text: text.slice(0, 160), truncated: text.length > 160 };
  };
  const stack = [{ a: before, b: after, path: [] }]; let visitedNodes = 0;
  while (stack.length) {
    work?.charge('workUnits'); work?.checkpoint(); visitedNodes++;
    const { a, b, path } = stack.pop(), ak = kind(a), bk = kind(b);
    if (ak !== bk || (ak !== 'object' && ak !== 'array' && !Object.is(a, b))) {
      return { path, before: brief(a), after: brief(b), visitedNodes, authority: 'first-structural-divergence-only' };
    }
    if (ak !== 'object' && ak !== 'array') continue;
    if (ak === 'array' && a.length !== b.length) return { path: [...path, 'length'], before: brief(a.length), after: brief(b.length), visitedNodes,
      authority: 'first-structural-divergence-only' };
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    work?.charge('workUnits', keys.length); work?.charge('residentBytes', keys.length * (128 + path.length * 16));
    for (const key of keys) if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
      return { path: [...path, key], before: Object.hasOwn(a, key) ? brief(a[key]) : { type: 'absent' },
        after: Object.hasOwn(b, key) ? brief(b[key]) : { type: 'absent' }, visitedNodes, authority: 'first-structural-divergence-only' };
    }
    for (let i = keys.length - 1; i >= 0; i--) stack.push({ a: a[keys[i]], b: b[keys[i]], path: [...path, keys[i]] });
  }
  return null;
}
function boundedFailure(failure) {
  if (!failure) return null;
  return { ...failure, path: failure.path.map(key => key.slice(0, 160)), pathTruncated: failure.path.some(key => key.length > 160) };
}
export function checkMemoryViewFrame(input, { worldId, snapshotId, functionId, work = null } = {}) {
  const value = snapshotContractData(input, { allowBigInt: true, maxNodes: 32768, maxBytes: 2097152 });
  recordFields(value, ['schema', 'worldId', 'snapshotId', 'functionId', 'before', 'after', 'unknowns', 'scope'], 'memory-view-frame-fields');
  const base = { scope: 'unchanged-canonical-mssa-and-expression-event-order', exact: false,
    strongUpdate: false, memoryOptimization: false };
  if (value.schema !== MEMORY_VIEW_FRAME_SCHEMA || value.scope !== 'phase8-expression-view-only'
    || value.worldId !== worldId || value.snapshotId !== snapshotId || value.functionId !== functionId) {
    return deepFreeze({ ...base, status: 'rejected', reason: 'memory-frame-binding' });
  }
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 256) throw new TypeError('memory-frame-unknowns');
  value.unknowns.forEach(reason => exactString(reason, 'memory-frame-unknown'));
  for (const frame of [value.before, value.after]) {
    recordFields(frame, ['version', 'functionId', 'entities', 'accesses', 'effects', 'control'], 'memory-frame-owner-fields');
    if (frame.functionId !== functionId || frame.version == null || !Array.isArray(frame.entities)
      || !Array.isArray(frame.accesses) || !Array.isArray(frame.effects) || !Array.isArray(frame.control)) {
      return deepFreeze({ ...base, status: 'unknown', reason: 'memory-frame-owner-incomplete' });
    }
    work?.charge('workUnits', frame.entities.length + frame.accesses.length + frame.effects.length + frame.control.length + 1);
    work?.checkpoint();
  }
  // Full type-preserving data comparison: matching checksums alone are not a
  // semantic premise and cannot hide changed byte widths or exceptional edges.
  const beforeEncoding = typed(value.before), afterEncoding = typed(value.after);
  work?.charge('residentBytes', (beforeEncoding.length + afterEncoding.length) * 2);
  if (beforeEncoding !== afterEncoding) return deepFreeze({ ...base, status: 'rejected', reason: 'canonical-memory-frame-changed',
    firstFailure: boundedFailure(firstDivergence(value.before, value.after, work)) });
  if (value.unknowns.length) return deepFreeze({ ...base, status: 'unknown', reason: 'open-memory-clobber-or-exception', remaining: value.unknowns });
  return deepFreeze({ ...base, status: 'verified', reason: null, accessCount: value.before.accesses.length,
    qualification: 'conditional-on-current-canonical-owner; not-independent-ISA-or-alias-proof' });
}
