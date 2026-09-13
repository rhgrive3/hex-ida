/** Terminal control observations in the existing canonical expression domain.
 * A target is the PC on normal return, not the exception PC. Fault predicates
 * are observations to prove or refute; their presence never assumes success.
 */
import { SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA } from '../../semantics/ir/nodes.js';
import { createBv, createBool, createBinary, createCompare, createConnective } from '../expr/index.js';
import { foldMemoryScalarExpression } from '../translate/memory.js';
import { queryArray, queryRecord } from './data-input.js';
import { QueryFailure } from './query-state.js';

export const TERMINAL_CONTROL_SCHEMA = 'hex-terminal-control/v1';
const fail = reason => { throw new QueryFailure(reason); };
const guardFor = memory => ({ take(_kind, count = 1) { memory.chargeExecution(count, count); } });
const exactKeys = (record, keys) => Object.keys(record).length === keys.length
  && keys.every(key => Object.hasOwn(record, key));

/** Structural consistency, not authority to invent a canonical target. Alias
 * compaction may change the final ValueId; the original ID stays in metadata.
 */
export function readReturnControl(inst, memory) {
  const guard = guardFor(memory);
  const extra = queryRecord(inst.extra ?? {}, guard, 128);
  const attributes = queryRecord(extra.attributes ?? {}, guard, 128);
  const machine = queryRecord(attributes.machineEffects ?? {}, guard, 128);
  const rawControl = queryRecord(attributes.machineControlEffect ?? {}, guard);
  if (attributes.machineEffects != null && machine.bundleCompleteness !== 'exact') fail('incomplete-return-control-effects');
  for (const source of [inst, extra, attributes, machine]) {
    if (source.unknownEffects != null && source.unknownEffects !== false) fail('unknown-return-control-effects');
  }
  const binding = extra.returnControlTarget;
  if (binding == null) {
    if (inst.returnTargetValue != null || extra.returnControlTargetValueId != null
        || rawControl.target != null) fail('missing-return-control-target');
    for (const source of [inst, extra, attributes, machine]) {
      for (const key of ['possibleFaults', 'faults']) {
        if (source[key] != null && queryArray(source[key], guard).length) fail('unbound-return-control-fault');
      }
    }
    return null;
  }
  const target = queryRecord(binding, guard);
  if (target.schema !== SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA) fail('invalid-return-control-target');
  if (target.state === 'unavailable') fail('unavailable-return-control-target');
  if (target.state !== 'resolved' || !exactKeys(target, ['schema', 'state', 'valueId'])
      || typeof target.valueId !== 'string' || !target.valueId || target.valueId.length > 1024
      || target.valueId !== extra.returnControlTargetValueId || !inst.returnTargetValue) fail('invalid-return-control-target');
  if (attributes.machineControlEffect != null) {
    if (!exactKeys(rawControl, ['kind', 'target']) || rawControl.kind !== 'return') fail('inconsistent-return-control-effect');
    const rawTarget = queryRecord(rawControl.target, guard);
    if (!['temporary', 'register', 'flag', 'absolute-address', 'bitvector'].includes(rawTarget.kind)) fail('inconsistent-return-control-effect');
    // This is source provenance. The canonical ValueId/SSA operand, already
    // resolved by lowering and alias compaction, is the execution authority.
    // Do not recreate a second raw-register/temporary resolver here.
  }
  if (inst.returnTargetValue.machineType != null
      && !['bitvector', 'address'].includes(inst.returnTargetValue.machineType.kind)) fail('invalid-return-control-target-type');
  const faults = [];
  for (const source of [inst, extra, attributes, machine]) {
    for (const key of ['possibleFaults', 'faults']) {
      if (source[key] == null) continue;
      for (const raw of queryArray(source[key], guard)) {
        // Only the canonical MachineEffects descriptor currently binds an
        // architectural target-alignment fault. Other fault channels stay open.
        if (source !== machine || key !== 'possibleFaults') fail('unsupported-return-control-fault');
        const fault = queryRecord(raw, guard), condition = queryRecord(fault.condition, guard);
        const detail = queryRecord(fault.detail, guard);
        if (!exactKeys(fault, ['kind', 'condition', 'detail']) || fault.kind !== 'pc-alignment-fault'
            || !exactKeys(condition, ['kind', 'alignmentBytes']) || condition.kind !== 'target-misaligned'
            || condition.alignmentBytes !== 4 || !exactKeys(detail, ['architecture', 'instructionSet'])
            || detail.architecture !== 'arm64' || detail.instructionSet !== 'a64'
            || !['arm64', 'arm64e'].includes(machine.architectureId) || machine.mode !== 'a64'
            || machine.bundleCompleteness !== 'exact' || inst.returnTargetValue.bits !== 64) fail('unsupported-return-control-fault');
        faults.push(Object.freeze({ kind:fault.kind, alignmentBytes:condition.alignmentBytes }));
      }
    }
  }
  return Object.freeze({ value:inst.returnTargetValue, sourceValueId:target.valueId, faults:Object.freeze(faults) });
}

export function observeReturnControl(control, target, memory) {
  if (!control) return null;
  memory.validateExpression(target);
  if (target?.kind === 'unknown_semantic' || target?.sort?.kind !== 'bv'
      || target.sort.width !== control.value.bits) fail('unsupported-return-control-target');
  memory.chargeExecution(control.faults.length * 6 + 1, control.faults.length * 6 + 1);
  const faults = control.faults.map(fault => {
    const masked = createBinary('and', target, createBv(target.sort.width, BigInt(fault.alignmentBytes - 1)));
    const condition = foldMemoryScalarExpression(createCompare('ne', masked, createBv(target.sort.width, 0n)), target.sort.width);
    memory.validateExpression(condition);
    return Object.freeze({ kind:fault.kind, condition });
  });
  const normalCompletionCondition = faults.length
    ? foldMemoryScalarExpression(createConnective('not', createConnective('or', ...faults.map(fault => fault.condition))), target.sort.width)
    : createBool(true);
  memory.validateExpression(normalCompletionCondition);
  return Object.freeze({ schemaVersion:TERMINAL_CONTROL_SCHEMA, kind:'return', scope:'terminal-control-observation', sourceValueId:control.sourceValueId,
    target, faults:Object.freeze(faults), normalCompletionCondition });
}
