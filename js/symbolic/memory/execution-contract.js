/** Structural validation of the existing execution IR, not a CFG/alias engine.
 * Reject missing or contradictory producer facts before exploring any path.
 * Legacy execution is unchanged; this contract gates the canonical byte route.
 */
import { OP } from '../../ir-base.js';
import { QueryFailure } from './query-state.js';

const TERMINATORS = new Set([OP.RET, OP.BR, OP.CBR]);
const DEFINITIONS = new Set([OP.CONST, OP.ADDR, OP.MOV, OP.BIN, OP.UN, OP.CMP, OP.SEL, OP.BFX, OP.BFI, OP.LOAD, OP.PHI]);
function fail(reason) { throw new QueryFailure(reason); }
function addressKey(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  fail('invalid-instruction-address');
}

function validatePhiUses(phi, memory) {
  const args = phi.args ?? [], incoming = phi.incoming ?? [];
  if (!Array.isArray(args) || !Array.isArray(incoming)) fail('invalid-phi-instruction');
  memory.chargeExecution(args.length, args.length);
  const arrayKeys = Reflect.ownKeys(args);
  memory.chargeExecution(arrayKeys.length, arrayKeys.length);
  if (Object.getPrototypeOf(args) !== Array.prototype || arrayKeys.length !== args.length + 1
      || arrayKeys.some((key, index) => key !== (index < args.length ? String(index) : 'length'))) fail('invalid-phi-use-list');
  // Legacy PHIs keep only incoming; canonical SSA also publishes an operand
  // use list. It must echo incoming exactly, not introduce another computation
  // or cause an unselected predecessor's definition to execute eagerly.
  if (!args.length) return;
  if (args.length !== incoming.length) fail('invalid-phi-use-list');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], value = incoming[index]?.value;
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(arg))) fail('invalid-phi-use-list');
    const keys = Reflect.ownKeys(arg);
    memory.chargeExecution(keys.length, keys.length);
    if (keys.some(key => key !== 'value' && key !== 'bits')) fail('invalid-phi-use-list');
    const operand = Object.getOwnPropertyDescriptor(arg, 'value');
    const width = Object.getOwnPropertyDescriptor(arg, 'bits');
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !operand || !Object.hasOwn(operand, 'value') || operand.value !== value
        || width && (!Object.hasOwn(width, 'value') || width.value !== value.bits)) fail('invalid-phi-use-list');
  }
}

export function validateExecutionContract(ir, memory) {
  if (ir.truncated != null && ir.truncated !== false) fail('incomplete-ir');
  const entry = ir.entry ?? 0;
  if (!Number.isSafeInteger(entry) || entry < 0 || entry >= ir.blocks.length) fail('invalid-ir-entry');
  const addresses = new Map(), instructions = new Set();
  // Consume the supplied CFG, never infer missing edges. PHI inputs must cover
  // exactly its predecessor set (plus the external entry sentinel when used).
  memory.chargeExecution(ir.blocks.length, ir.blocks.length);
  const predecessors = ir.blocks.map(() => new Set());
  for (let index = 0; index < ir.blocks.length; index++) {
    for (const successor of ir.blocks[index].succ ?? []) {
      memory.chargeExecution(1, 1);
      if (!Number.isSafeInteger(successor) || successor < 0 || successor >= ir.blocks.length) fail('invalid-ir-successor');
      predecessors[successor].add(index);
    }
  }
  function instruction(inst) {
    memory.chargeExecution(1, 1);
    if (instructions.has(inst)) fail('duplicate-instruction');
    instructions.add(inst);
    if (inst.extra?.completeness != null && inst.extra.completeness !== 'complete') fail('incomplete-instruction');
    if (DEFINITIONS.has(inst.op) && !inst.dst) fail('missing-instruction-destination');
    if (inst.dst && inst.dst.def !== inst) fail('instruction-definition-mismatch');
  }
  for (let index = 0; index < ir.blocks.length; index++) {
    const block = ir.blocks[index];
    memory.chargeExecution();
    if (block.index !== index) fail('invalid-ir-block-index');
    const successors = block.succ ?? [];
    memory.chargeExecution(successors.length, successors.length);
    const seen = new Set();
    for (const successor of successors) {
      if (!Number.isSafeInteger(successor) || successor < 0 || successor >= ir.blocks.length || seen.has(successor)) fail('invalid-ir-successor');
      seen.add(successor);
    }
    for (const phi of block.phis ?? []) {
      instruction(phi);
      if (phi.op !== OP.PHI || !phi.dst) fail('invalid-phi-instruction');
      validatePhiUses(phi, memory);
    }
    let first = null, terminated = false;
    for (const inst of block.insts) {
      instruction(inst);
      if (inst.op === OP.PHI) fail('phi-outside-entry');
      if (terminated) fail('instruction-after-terminator');
      if (inst.address != null) {
        addressKey(inst.address);
        if (!first || inst.row < first.row) first = inst;
      }
      if (inst.op === OP.STORE && inst.args?.length !== 1) fail('store-operand-arity');
      if (inst.op === OP.RET && (inst.args?.length ?? 0) > 1) fail('unsupported-multi-return');
      if (TERMINATORS.has(inst.op)) terminated = true;
    }
    if (first) {
      const key = addressKey(first.address);
      if (addresses.has(key)) fail('ambiguous-block-address');
      addresses.set(key, index);
    }
  }
  for (const block of ir.blocks) {
    memory.chargeExecution();
    const last = block.insts.at(-1);
    if (!last) continue;
    const successors = block.succ ?? [];
    if (last.op === OP.RET && successors.length) fail('return-with-successors');
    if (last.op !== OP.BR && last.op !== OP.CBR) continue;
    const target = last.extra?.target;
    if (target == null) fail('unresolved-branch-target');
    const targetBlock = addresses.get(addressKey(target));
    if (targetBlock == null) fail('unresolved-branch-target');
    if (!successors.includes(targetBlock)) fail('branch-target-not-successor');
    if (last.op === OP.BR && successors.length !== 1 || last.op === OP.CBR && successors.length !== 2) fail('invalid-branch-successors');
  }
  // Diagnose CFG contradictions first, preserving the established reason codes.
  for (let index = 0; index < ir.blocks.length; index++) {
    for (const phi of ir.blocks[index].phis ?? []) {
      const incoming = phi.incoming ?? [], from = new Set();
      memory.chargeExecution(incoming.length, incoming.length);
      for (const item of incoming) {
        if (!item?.value || from.has(item.from) || !(predecessors[index].has(item.from) || index === entry && item.from === -1)) fail('ambiguous-phi');
        from.add(item.from);
      }
      for (const pred of predecessors[index]) if (!from.has(pred)) fail('ambiguous-phi');
      if (index === entry && !from.has(-1)) fail('ambiguous-phi');
    }
  }
  return addresses;
}
