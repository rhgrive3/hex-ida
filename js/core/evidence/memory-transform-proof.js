/** Independent, bounded verifier for retained-event memory value receipts.
 * It consumes canonical owner projections; it does not discover aliases, build
 * MemorySSA, accept a rewrite, or qualify an ISA/environment. Byte expressions
 * are constants or opaque input lanes. All canonical memory events must remain
 * in order. General memory rewrites belong to symbolic/query/memory-equivalence.
 */
import { deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet } from '../identity/structured.js';

export const MEMORY_TRANSFORM_PROGRAM_SCHEMA = 'scoped-memory-transform-program/v1';
export const MEMORY_TRANSFORM_RULE = 'scoped-linear-byte-memory';
export const MEMORY_TRANSFORM_VERSION = '1.0.0';
const encoded = value => stableStringify([value, lossyTypeWitness(value)]);
const equal = (a, b) => encoded(a) === encoded(b);
class UnsupportedMemoryRule extends Error {}
const unsupported = reason => { throw new UnsupportedMemoryRule(reason); };
const tick = work => { work?.charge('workUnits'); work?.checkpoint(); };
function list(value, name, max) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(name);
  return value;
}
function decimal(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,39})$/.test(value) || value === '-0') throw new TypeError('memory-transform-offset');
  return value;
}
function range(value) {
  recordFields(value, ['domain', 'start', 'bytes'], 'memory-transform-range-fields');
  return { domain: exactString(value.domain, 'memory-transform-domain'), start: decimal(value.start),
    bytes: exactInteger(value.bytes, 'memory-transform-byte-width', { min: 1, max: 16 }) };
}
function byte(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 255) return value;
  recordFields(value, ['valueId', 'index'], 'memory-transform-byte-fields');
  return { valueId: exactString(value.valueId, 'memory-transform-byte-value'),
    index: exactInteger(value.index, 'memory-transform-byte-index', { min: 0, max: 15 }) };
}
function effects(value) {
  recordFields(value, ['volatile', 'atomic', 'ordering', 'faults', 'exceptionTargets', 'addressSpace'], 'memory-transform-effect-fields');
  if (![true, false, 'unknown'].includes(value.volatile) || ![true, false, 'unknown'].includes(value.atomic)) throw new TypeError('memory-transform-effect-knowledge');
  list(value.faults, 'memory-transform-faults', 16);
  return { volatile: value.volatile, atomic: value.atomic,
    ordering: exactEnum(value.ordering, ['none', 'relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst', 'unknown'], 'memory-transform-ordering'),
    faults: value.faults, exceptionTargets: stringSet(value.exceptionTargets, 'memory-transform-exceptions', 16),
    addressSpace: exactEnum(value.addressSpace, ['memory', 'device', 'unknown'], 'memory-transform-address-space') };
}
function operation(value) {
  recordFields(value, ['id', 'kind', 'sourceEntityId', 'range', 'endian', 'target', 'value', 'effects', 'reachingDefinitions'], 'memory-transform-operation-fields');
  const base = { id: exactString(value.id, 'memory-transform-operation-id'),
    kind: exactString(value.kind, 'memory-transform-operation-kind') };
  if (!['read', 'write', 'copy', 'clobber'].includes(base.kind)) unsupported('memory-transform-rule-unsupported');
  if (base.kind === 'copy') {
    if (Object.keys(value).some(key => !['id', 'kind', 'target', 'value'].includes(key))) throw new TypeError('memory-transform-copy-fields');
    const bytes = list(value.value, 'memory-transform-copy-width', 16).map(byte);
    if (!bytes.length) throw new TypeError('memory-transform-copy-empty');
    return { ...base, target: exactString(value.target, 'memory-transform-copy-target'), value: bytes };
  }
  const target = base.kind === 'read' ? (value.target === null ? null : exactString(value.target, 'memory-transform-read-target')) : null;
  if (base.kind !== 'read' && value.target !== undefined) throw new TypeError('memory-transform-nonread-target');
  const r = range(value.range), effect = effects(value.effects);
  const data = base.kind === 'write' ? list(value.value, 'memory-transform-store-value', 16).map(byte) : null;
  if (base.kind !== 'write' && value.value !== undefined) throw new TypeError('memory-transform-nonwrite-value');
  if (data && data.length !== r.bytes) throw new TypeError('memory-transform-store-width-mismatch');
  if (base.kind === 'clobber' && !value.sourceEntityId) unsupported('memory-transform-clobber-source-unbound');
  return { ...base, sourceEntityId: exactString(value.sourceEntityId, 'memory-transform-source'), range: r,
    endian: exactEnum(value.endian, ['little', 'big'], 'memory-transform-endian'),
    ...(base.kind === 'read' ? { target } : {}), ...(data ? { value: data } : {}), effects: effect,
    reachingDefinitions: stringSet(value.reachingDefinitions, 'memory-transform-reaching-definitions', 128) };
}

export function normalizeMemoryTransformProgram(value, { work = null } = {}) {
  const input = snapshotContractData(value, { allowBigInt: true, maxNodes: 32768, maxBytes: 2097152 });
  recordFields(input, ['schema', 'id', 'worldId', 'snapshotId', 'functionId', 'ownerDigest', 'inputs', 'operations', 'outputs', 'unknowns', 'control', 'concurrency'], 'memory-transform-program-fields');
  if (input.schema !== MEMORY_TRANSFORM_PROGRAM_SCHEMA) throw new TypeError('memory-transform-program-schema');
  if (input.control !== 'linear-normal-exit-with-fault-prefixes') unsupported('memory-transform-control-unsupported');
  if (input.concurrency !== 'single-thread-no-unmodeled-writers') unsupported('memory-transform-concurrency-unsupported');
  const inputs = list(input.inputs, 'memory-transform-input-count', 128).map(row => {
    tick(work); recordFields(row, ['id', 'bytes'], 'memory-transform-input-fields');
    return { id: exactString(row.id, 'memory-transform-input-id'), bytes: exactInteger(row.bytes, 'memory-transform-input-bytes', { min: 1, max: 16 }) };
  });
  if (new Set(inputs.map(row => row.id)).size !== inputs.length) throw new TypeError('memory-transform-duplicate-input');
  const operations = list(input.operations, 'memory-transform-operation-count', 256).map(row => { tick(work); return operation(row); });
  if (new Set(operations.map(row => row.id)).size !== operations.length) throw new TypeError('memory-transform-duplicate-operation');
  const body = { schema: MEMORY_TRANSFORM_PROGRAM_SCHEMA, worldId: exactString(input.worldId, 'memory-transform-world'),
    snapshotId: exactString(input.snapshotId, 'memory-transform-snapshot'), functionId: exactString(input.functionId, 'memory-transform-function'),
    ownerDigest: exactString(input.ownerDigest, 'memory-transform-owner-digest'), inputs, operations,
    outputs: stringSet(input.outputs, 'memory-transform-outputs', 128), unknowns: stringSet(input.unknowns, 'memory-transform-unknowns', 128),
    control: input.control, concurrency: input.concurrency };
  const id = `memory-transform:${stableDigest({ body, typed: lossyTypeWitness(body) })}`;
  if (input.id !== undefined && input.id !== id) throw new TypeError('memory-transform-program-id-mismatch');
  work?.charge('residentBytes', encoded(body).length * 2);
  return deepFreeze({ ...body, id });
}

const address = (r, index) => encoded([r.domain, (BigInt(r.start) + BigInt(index)).toString()]);
function touched(programs, work) {
  const all = new Set();
  for (const program of programs) for (const op of program.operations) if (op.range) for (let i = 0; i < op.range.bytes; i++) {
    tick(work); all.add(address(op.range, i));
    if (all.size > 4096) unsupported('memory-transform-footprint-budget');
  }
  return [...all].sort();
}
function replay(program, footprint, work) {
  const memory = new Map(footprint.map(key => [key, ['initial-memory-byte', key]]));
  const values = new Map(program.inputs.map(row => [row.id, Array.from({ length: row.bytes }, (_, i) => ['input-byte', row.id, i])]));
  const traces = [];
  const value = bytes => bytes.map(lane => {
    tick(work);
    if (typeof lane === 'number') return lane;
    const row = values.get(lane.valueId);
    if (!row || lane.index >= row.length) unsupported('memory-transform-undefined-value-byte');
    return row[lane.index];
  });
  const assign = (id, bytes) => {
    if (values.has(id)) throw new TypeError('memory-transform-value-redefined');
    values.set(id, bytes);
  };
  const observedValues = () => {
    work?.charge('workUnits', program.outputs.length); work?.checkpoint();
    return program.outputs.map(id => [id, values.get(id) ?? null]);
  };
  const memoryState = () => {
    work?.charge('workUnits', footprint.length); work?.checkpoint();
    return footprint.map(key => [key, memory.get(key)]);
  };
  for (const op of program.operations) {
    tick(work);
    if (op.kind === 'copy') { assign(op.target, value(op.value)); continue; }
    const data = op.kind === 'write' ? value(op.value) : null;
    const fx = op.effects;
    // Unknown/device/atomic/volatile reads have fresh event values. Retaining
    // the event does not make its result a deterministic ordinary-memory read.
    const externalRead = fx.volatile !== false || fx.atomic !== false || fx.addressSpace !== 'memory';
    const observed = externalRead || !['none', 'relaxed'].includes(fx.ordering) || fx.faults.length || fx.exceptionTargets.length || op.kind === 'clobber';
    if (observed) {
      const trace = { id: op.id, kind: op.kind, sourceEntityId: op.sourceEntityId,
        range: op.range, endian: op.endian, effects: fx, data,
        // At every possible exceptional exit the observable memory/value
        // prefix must match, even if both normal executions finish equally.
        ...(fx.faults.length || fx.exceptionTargets.length ? { memory: memoryState(), outputs: observedValues() } : {}) };
      work?.charge('residentBytes', encoded(trace).length * 2); traces.push(trace);
    }
    const keys = Array.from({ length: op.range.bytes }, (_, i) => address(op.range, i));
    if (op.kind === 'write') {
      const stored = op.endian === 'little' ? data : [...data].reverse();
      keys.forEach((key, i) => { tick(work); memory.set(key, stored[i]); });
    } else if (op.kind === 'clobber') {
      // A clobber is justified only by an explicit finite canonical footprint;
      // no-value/unknown-range clobbers are rejected by normalization.
      keys.forEach((key, i) => { tick(work); memory.set(key, ['clobber-byte', op.id, key, i]); });
    } else if (op.target !== null) {
      const loaded = keys.map((key, i) => externalRead ? ['event-read-byte', op.id, key, i] : memory.get(key));
      assign(op.target, op.endian === 'little' ? loaded : loaded.reverse());
    }
  }
  for (const id of program.outputs) if (!values.has(id)) unsupported('memory-transform-output-unbound');
  return { outputs: observedValues(), memory: memoryState(), traces };
}

/** Verify all input bytes symbolically, not by sampling or digest equality.
 * The owner remains responsible for canonical geometry and reaching definitions.
 */
export function checkMemoryTransformRelation(beforeValue, afterValue, { worldId, snapshotId, functionId, work = null } = {}) {
  const base = { exact: false, semanticCounterexample: false, memoryOptimization: false,
    scope: 'retained-canonical-events-value-substitution-and-exception-prefixes',
    qualification: 'conditional-on-canonical-owner-and-declared-concurrency; not-ISA-or-C-rendering-proof' };
  try {
    const before = normalizeMemoryTransformProgram(beforeValue, { work }), after = normalizeMemoryTransformProgram(afterValue, { work });
    if ([before, after].some(p => p.worldId !== worldId || p.snapshotId !== snapshotId || p.functionId !== functionId)
      || before.ownerDigest !== after.ownerDigest) return deepFreeze({ ...base, status: 'rejected', reason: 'memory-transform-owner-binding' });
    if (!equal(before.inputs, after.inputs) || !equal(before.outputs, after.outputs)) return deepFreeze({ ...base, status: 'rejected', reason: 'memory-transform-observable-binding' });
    const eventsBefore = before.operations.filter(op => op.kind !== 'copy'), eventsAfter = after.operations.filter(op => op.kind !== 'copy');
    if (eventsBefore.length !== eventsAfter.length) return deepFreeze({ ...base, status: 'unknown', reason: 'memory-access-rewrite-owned-by-symbolic-verifier' });
    for (let index = 0; index < eventsBefore.length; index++) {
      tick(work);
      const { target: beforeTarget, value: beforeData, ...a } = eventsBefore[index];
      const { target: afterTarget, value: afterData, ...b } = eventsAfter[index];
      if (!equal(a, b)) return deepFreeze({ ...base, status: 'rejected', reason: 'memory-transform-canonical-event-binding-changed',
        firstFailure: { dimension: 'canonical-events', index, authority: 'canonical-access-order-and-effect-binding' } });
    }
    if (before.unknowns.length || after.unknowns.length) return deepFreeze({ ...base, status: 'unknown', reason: 'memory-transform-open-premises',
      remaining: [...new Set([...before.unknowns, ...after.unknowns])].sort() });
    const footprint = touched([before, after], work);
    const a = replay(before, footprint, work), b = replay(after, footprint, work);
    for (const dimension of ['traces', 'outputs', 'memory']) {
      if (!equal(a[dimension], b[dimension])) {
        const index = Array.from({ length: Math.max(a[dimension].length, b[dimension].length) }, (_, i) => i).find(i => !equal(a[dimension][i], b[dimension][i]));
        return deepFreeze({ ...base, status: 'rejected', reason: `memory-transform-${dimension}-changed`,
          firstFailure: { dimension, index, beforeCount: a[dimension].length, afterCount: b[dimension].length,
            authority: 'independent-symbolic-byte-and-event-divergence' } });
      }
    }
    return deepFreeze({ ...base, status: 'verified', reason: null, beforeId: before.id, afterId: after.id,
      footprintBytes: footprint.length, preservedEvents: a.traces.length, outputCount: a.outputs.length,
      valueProjectionChanged: !equal(before.operations, after.operations), memoryAccessEliminated: false });
  } catch (error) {
    if (error instanceof UnsupportedMemoryRule) return deepFreeze({ ...base, status: 'unknown', reason: error.message });
    throw error;
  }
}
