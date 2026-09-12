/** Typed finite query language. Data only: no eval, SQL, regex or callbacks. */
import { createEntityId, deepFreeze, stableStringify, lossyTypeWitness } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet, unsignedAddress, contractFail } from '../../../core/identity/structured.js';

export const SEMANTIC_QUERY_SCHEMA = 'semantic-query/v1';
export const SEMANTIC_PLAN_SCHEMA = 'semantic-query-plan/v1';
export const SEMANTIC_QUERY_COMPILER_VERSION = '1.2.0';
export const QUERY_EDGE_KINDS = Object.freeze([
  'ssa-use-def', 'ssa-phi', 'operation-input', 'operation-output',
  'memory-reaching', 'memory-merge', 'memory-input', 'memory-output', 'call-summary',
]);
export const QUERY_RECORD_OWNERS = Object.freeze(['semantic-ir', 'ssa', 'memoryssa']);
const STRING_FIELDS = Object.freeze(['id', 'entityId', 'functionId', 'owner', 'kind', 'operator', 'blockId', 'addressSpace', 'variableKey']);
const SET_FIELDS = Object.freeze(['callTargets', 'roles']);
const PLANS = new WeakMap();

function predicate(input, budget, depth = 0) {
  if (++budget.nodes > 128 || depth > 12) contractFail('semantic-selector-budget');
  const op = exactEnum(input?.op, ['all', 'eq', 'in', 'contains', 'and', 'or', 'not', 'has', 'origin-overlaps'], 'semantic-selector-op');
  if (op === 'all') { recordFields(input, ['op'], 'semantic-selector-fields'); return { op }; }
  if (op === 'and' || op === 'or') {
    recordFields(input, ['op', 'terms'], 'semantic-selector-fields');
    if (!Array.isArray(input.terms) || !input.terms.length || input.terms.length > 16) contractFail('semantic-selector-terms');
    return { op, terms: input.terms.map((term) => predicate(term, budget, depth + 1)) };
  }
  if (op === 'not') {
    recordFields(input, ['op', 'term'], 'semantic-selector-fields');
    return { op, term: predicate(input.term, budget, depth + 1) };
  }
  if (op === 'origin-overlaps') {
    recordFields(input, ['op', 'space', 'sourceId', 'start', 'end'], 'semantic-origin-selector-fields');
    const start = unsignedAddress(input.start, { bits: 64 }), end = unsignedAddress(input.end, { bits: 64, allowEnd: true });
    if (BigInt(start) >= BigInt(end)) contractFail('semantic-origin-selector-empty-or-reversed-range');
    return { op, space: exactEnum(input.space, ['file', 'virtual'], 'semantic-origin-selector-space'),
      sourceId: exactString(input.sourceId, 'semantic-origin-selector-source'), start, end };
  }
  if (op === 'contains') {
    recordFields(input, ['op', 'field', 'value'], 'semantic-selector-fields');
    return { op, field: exactEnum(input.field, SET_FIELDS, 'semantic-selector-set-field'), value: exactString(input.value, 'semantic-selector-value', 4096) };
  }
  recordFields(input, op === 'in' ? ['op', 'field', 'values'] : op === 'eq' ? ['op', 'field', 'value'] : ['op', 'field'], 'semantic-selector-fields');
  const field = exactEnum(input.field, STRING_FIELDS, 'semantic-selector-field');
  if (op === 'has') return { op, field };
  if (op === 'eq') return { op, field, value: exactString(input.value, 'semantic-selector-value') };
  const values = stringSet(input.values, 'semantic-selector-values', 256);
  if (!values.length) contractFail('semantic-selector-empty-set');
  return { op, field, values };
}

/** Matches recorded source contributions, never the address a load accesses.
 * A missing origin list remains UNKNOWN. BigInt preserves all address bits.
 */
function recordedOriginOverlap(selector, origin, work = null) {
  const ranges = selector.space === 'file' ? origin?.byteRanges : origin?.virtualRanges;
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 4096) return null;
  const start = BigInt(selector.start), end = BigInt(selector.end); let invalid = false;
  for (const range of ranges) {
    work?.charge('workUnits');
    if ((selector.space === 'file' ? range.binaryId : range.sliceId) !== selector.sourceId) continue;
    let left, right;
    try {
      left = BigInt(unsignedAddress(range.start, { bits: 64 }));
      right = BigInt(unsignedAddress(range.end, { bits: 64, allowEnd: true }));
      if (right <= left) { invalid = true; continue; }
    } catch { invalid = true; continue; }
    if (left < end && start < right) return true;
  }
  return invalid ? null : false;
}

/** Missing data is UNKNOWN, including under NOT. It never becomes a match/no-match proof. */
export function evaluateSemanticSelector(selector, record) {
  switch (selector.op) {
    case 'all': return true;
    case 'origin-overlaps': return recordedOriginOverlap(selector, record.origin ?? null);
    case 'has': return record.unknownFields?.includes(selector.field) ? null : record[selector.field] != null;
    case 'eq':
    case 'in': {
      if (record.unknownFields?.includes(selector.field)) return null;
      const value = record[selector.field];
      if (value == null) return false; // explicit non-applicable, not missing producer data
      return selector.op === 'eq' ? value === selector.value : selector.values.includes(value);
    }
    case 'contains': {
      const values = record[selector.field];
      if (Array.isArray(values) && values.includes(selector.value)) return true;
      if (!Array.isArray(values) || record.unknownFields?.includes(selector.field)) return null;
      return false;
    }
    case 'not': { const result = evaluateSemanticSelector(selector.term, record); return result === null ? null : !result; }
    case 'and': {
      let unknown = false;
      for (const term of selector.terms) { const result = evaluateSemanticSelector(term, record); if (result === false) return false; unknown ||= result === null; }
      return unknown ? null : true;
    }
    case 'or': {
      let unknown = false;
      for (const term of selector.terms) { const result = evaluateSemanticSelector(term, record); if (result === true) return true; unknown ||= result === null; }
      return unknown ? null : false;
    }
    default: contractFail('semantic-selector-not-compiled');
  }
}

function emit(selector, instructions) {
  if (selector.op === 'and' || selector.op === 'or') {
    for (const term of selector.terms) emit(term, instructions);
    instructions.push({ op: selector.op.toUpperCase(), arity: selector.terms.length });
  } else if (selector.op === 'not') { emit(selector.term, instructions); instructions.push({ op: 'NOT' }); }
  else instructions.push({ op: 'PREDICATE', predicate: selector });
}

export function normalizeSemanticQuery(value) {
  const input = snapshotContractData(value, { maxBytes: 262144, maxNodes: 4096, maxDepth: 32 });
  recordFields(input, ['schema', 'scope', 'select', 'flow', 'projection', 'resultLimit'], 'semantic-query-fields');
  if (input.schema !== undefined && input.schema !== SEMANTIC_QUERY_SCHEMA) contractFail('semantic-query-schema');
  recordFields(input.scope, ['functionIds', 'expectClosed'], 'semantic-query-scope-fields');
  const functionIds = stringSet(input.scope.functionIds, 'semantic-query-functions', 256);
  if (!functionIds.length) contractFail('semantic-query-explicit-function-scope-required');
  // Asking for a closure proof is permitted; declaring closure is not.
  if (input.scope.expectClosed !== undefined && typeof input.scope.expectClosed !== 'boolean') contractFail('semantic-query-closure-request');
  const budget = { nodes: 0 };
  const select = predicate(input.select ?? { op: 'all' }, budget);
  let flow = null;
  if (input.flow !== null && input.flow !== undefined) {
    recordFields(input.flow, ['to', 'via', 'avoid', 'direction', 'edgeKinds', 'maxDepth', 'maxPaths', 'maxCallDepth', 'pathMode'], 'semantic-query-flow-fields');
    const edgeKinds = stringSet(input.flow.edgeKinds ?? QUERY_EDGE_KINDS, 'semantic-query-edge-kinds', QUERY_EDGE_KINDS.length);
    if (!edgeKinds.length || edgeKinds.some((kind) => !QUERY_EDGE_KINDS.includes(kind))) contractFail('semantic-query-edge-kind');
    const via = input.flow.via ?? [];
    if (!Array.isArray(via) || via.length > 8) contractFail('semantic-query-waypoint-budget');
    flow = { to: predicate(input.flow.to, budget), via: via.map((item) => predicate(item, budget)),
      avoid: input.flow.avoid == null ? null : predicate(input.flow.avoid, budget),
      direction: exactEnum(input.flow.direction ?? 'forward', ['forward', 'backward'], 'semantic-query-direction'), edgeKinds,
      maxDepth: exactInteger(input.flow.maxDepth ?? 64, 'semantic-query-depth', { min: 1, max: 512 }),
      maxPaths: exactInteger(input.flow.maxPaths ?? 16, 'semantic-query-paths', { min: 1, max: 256 }),
      maxCallDepth: exactInteger(input.flow.maxCallDepth ?? 2, 'semantic-query-call-depth', { max: 8 }),
      pathMode: exactEnum(input.flow.pathMode ?? 'one-per-source-sink', ['one-per-source-sink'], 'semantic-query-path-mode') };
  }
  const projection = input.projection ?? {};
  recordFields(projection, ['includeOrigins', 'includeWitnesses'], 'semantic-query-projection-fields');
  for (const field of ['includeOrigins', 'includeWitnesses']) if (projection[field] !== undefined && typeof projection[field] !== 'boolean') contractFail('semantic-query-projection-value');
  return deepFreeze({ schema: SEMANTIC_QUERY_SCHEMA, scope: { functionIds, expectClosed: input.scope.expectClosed === true }, select, flow,
    projection: { includeOrigins: projection.includeOrigins === true, includeWitnesses: projection.includeWitnesses !== false },
    resultLimit: exactInteger(input.resultLimit ?? 64, 'semantic-query-result-limit', { min: 1, max: 1024 }) });
}

export function compileSemanticQuery(input, { world, assumptions } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world);
  const query = normalizeSemanticQuery(input);
  const selectProgram = [], sinkProgram = [], waypointPrograms = [], avoidProgram = [];
  emit(query.select, selectProgram);
  if (query.flow) {
    emit(query.flow.to, sinkProgram);
    for (const waypoint of query.flow.via) { const code = []; emit(waypoint, code); waypointPrograms.push(code); }
    if (query.flow.avoid) emit(query.flow.avoid, avoidProgram);
  }
  const body = { schema: SEMANTIC_PLAN_SCHEMA, compilerVersion: SEMANTIC_QUERY_COMPILER_VERSION,
    worldId: world.id, assumptionsId: assumptions.id, query, selectProgram, sinkProgram, waypointPrograms, avoidProgram,
    requirements: query.flow ? ['canonical-ssa', ...(query.flow.edgeKinds.some((kind) => kind.startsWith('memory-')) ? ['canonical-memoryssa'] : []),
      ...(query.flow.edgeKinds.includes('call-summary') ? ['bound-interprocedural-flow-summaries'] : [])] : ['canonical-semantic-ir'],
    authority: 'query-plan-not-analysis-fact' };
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: SEMANTIC_PLAN_SCHEMA, identity: body });
  const plan = deepFreeze({ ...body, id });
  PLANS.set(plan, { world, assumptions });
  return plan;
}
export function assertSemanticQueryPlan(plan, world = null, assumptions = null) {
  const binding = PLANS.get(plan);
  if (!binding || (world !== null && assertWorldScope(world).id !== binding.world.id)
    || (assumptions !== null && assertAssumptionSet(assumptions).id !== binding.assumptions.id)) contractFail('semantic-plan-unbound');
  return plan;
}
/** Imported plans are always recompiled; emitted instructions are never trusted. */
export function restoreSemanticQueryPlan(value, { world, assumptions } = {}) {
  const input = snapshotContractData(value, { maxBytes: 1048576 });
  const plan = compileSemanticQuery(input.query, { world, assumptions });
  if (stableStringify(input) !== stableStringify(plan)
    || stableStringify(lossyTypeWitness(input)) !== stableStringify(lossyTypeWitness(plan))) contractFail('semantic-plan-content-mismatch');
  return plan;
}

/** Execute compiler-emitted finite stack code, never caller-supplied bytecode.
 * This VM only selects canonical fields. It cannot evaluate ISA operations,
 * write facts, invoke providers or turn unknown fields into closed negation.
 */
export function evaluateSemanticQueryPlan(plan, target, record, { work = null, waypoint = null, origin = record?.origin ?? null } = {}) {
  assertSemanticQueryPlan(plan);
  const binding = PLANS.get(plan);
  if (target === 'waypoint') exactInteger(waypoint, 'semantic-program-waypoint', { max: plan.waypointPrograms.length - 1 });
  const program = target === 'select' ? plan.selectProgram : target === 'sink' ? plan.sinkProgram
    : target === 'avoid' ? plan.avoidProgram : target === 'waypoint' ? plan.waypointPrograms[waypoint] : null;
  if (!program?.length || program.length > 128) contractFail('semantic-program-target-or-budget');
  work?.charge('workUnits', program.length);
  const stack = [];
  binding.membershipSets ??= new Map();
  for (const instruction of program) {
    if (instruction.op === 'PREDICATE') {
      const p = instruction.predicate;
      let value;
      if (p.op === 'origin-overlaps') value = recordedOriginOverlap(p, origin, work);
      else if (p.op === 'in') {
        if (record.unknownFields?.includes(p.field)) value = null;
        else if (record[p.field] == null) value = false;
        else {
          let set = binding.membershipSets.get(p);
          if (!set) { set = new Set(p.values); binding.membershipSets.set(p, set); }
          value = set.has(record[p.field]);
        }
      } else {
        if (p.op === 'contains' && Array.isArray(record[p.field])) work?.charge('workUnits', record[p.field].length);
        value = evaluateSemanticSelector(p, record);
      }
      if (value !== null && typeof value !== 'boolean') contractFail('semantic-program-non-boolean');
      stack.push(value);
    } else if (instruction.op === 'NOT') {
      if (!stack.length) contractFail('semantic-program-stack-underflow');
      const value = stack.pop(); stack.push(value === null ? null : !value);
    } else if (instruction.op === 'AND' || instruction.op === 'OR') {
      if (!Number.isSafeInteger(instruction.arity) || instruction.arity < 1 || instruction.arity > stack.length) contractFail('semantic-program-stack-arity');
      let unknown = false, decisive = false;
      for (let index = 0; index < instruction.arity; index++) {
        const value = stack.pop();
        unknown ||= value === null;
        decisive ||= instruction.op === 'AND' ? value === false : value === true;
      }
      stack.push(decisive ? instruction.op === 'OR' : unknown ? null : instruction.op === 'AND');
    } else contractFail('semantic-program-opcode');
    if (stack.length > 128) contractFail('semantic-program-stack-budget');
  }
  if (stack.length !== 1) contractFail('semantic-program-unbalanced');
  return stack[0];
}
