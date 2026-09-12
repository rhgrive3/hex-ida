/** Recount existing CFG data for an issued conditional render region.
 * This is a structural prerequisite, never edge infeasibility, equivalence,
 * effect safety, PHI rewriting or permission to change a copied C AST.
 */
import { readSemanticConditionalRegion } from '../semantic-core.js';
import { successorEdgesOf } from './structuring.js';
import { queryArray, queryRecord } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, sameMemoryIdentity } from '../../symbolic/memory/query-state.js';

const issued = new WeakMap();
const LIMITS = Object.freeze({ blocks:4096, edges:32768, workItems:262144, allocationUnits:262144 });
const ORDINARY = new Set(['branch', 'fallthrough', 'conditional-true', 'conditional-false']);
const freeze = values => Object.freeze(values);
const sameSet = (array, set) => array.length === set.size && new Set(array).size === array.length
  && array.every(value => set.has(value));

/** Consume only in the original query/IR, with producer freshness still live. */
export function readConditionalRegionStructure(result, ir, identity) {
  const binding = issued.get(result);
  try {
    if (!binding || binding.ir !== ir || !sameMemoryIdentity(binding.identity, identity)) return null;
    binding.guard.check(identity);
    return readSemanticConditionalRegion(binding.record, ir) === binding.region
      && sameMemoryIdentity(binding.identity, identity) ? result : null;
  } catch { return null; }
}

export function prepareConditionalRegionStructure(record, ir, options = {}) {
  let guard;
  const reject = reason => freeze({ version:1, status:'incomplete', reason, transformAuthorization:false });
  try {
    guard = createQueryGuard(queryRecord(options), LIMITS);
    guard.check();
    const region = readSemanticConditionalRegion(record, ir);
    if (!region) return reject('unissued-or-stale-region');
    const raw = queryRecord(ir, guard, 128), blocks = queryArray(raw.blocks, guard, LIMITS.blocks);
    if (raw.truncated != null && raw.truncated !== false) return reject('truncated-ir');
    guard.take('blocks', blocks.length); guard.take('allocationUnits', blocks.length * 4);
    const byIndex = new Map(), incoming = new Map(), outgoing = new Map();
    for (const block of blocks) {
      const data = queryRecord(block, guard, 128), index = data.index;
      if (!Number.isSafeInteger(index) || index < 0 || byIndex.has(index)) return reject('invalid-block-index');
      byIndex.set(index, { block, data }); incoming.set(index, new Set());
    }
    if (!byIndex.has(raw.entry)) return reject('missing-function-entry');
    const edges = [];
    for (const [index, { data }] of byIndex) {
      const succ = queryArray(data.succ, guard), labels = queryArray(data.successorEdges, guard, LIMITS.edges);
      guard.take('edges', succ.length + labels.length);
      guard.take('allocationUnits', succ.length * 4 + labels.length);
      const successors = new Set(succ);
      if (successors.size !== succ.length || succ.some(to => !byIndex.has(to))) return reject('invalid-successor-inventory');
      const checkedLabels = labels.map(edge => queryRecord(edge, guard));
      if (checkedLabels.some(edge => !successors.has(edge.to) || typeof edge.kind !== 'string' || !edge.kind)) {
        return reject('invalid-edge-label-inventory');
      }
      if (!sameSet([...new Set(checkedLabels.map(edge => edge.to))], successors)) return reject('missing-edge-label');
      // The canonical helper merges false/fallthrough labels for one target.
      // It receives validated data, so its permissive fallback cannot fill a gap.
      const normalized = successorEdgesOf({ succ, successorEdges:checkedLabels });
      outgoing.set(index, normalized);
      for (const edge of normalized) {
        incoming.get(edge.to).add(index);
        edges.push(freeze({ from:index, to:edge.to, kinds:freeze(edge.kinds) }));
      }
    }
    for (const [index, { data }] of byIndex) {
      if (!sameSet(queryArray(data.pred, guard), incoming.get(index))) return reject('predecessor-inventory-mismatch');
    }
    const { header, yes, no, join } = region.selection;
    if (byIndex.get(header)?.block !== blocks[header] || byIndex.get(join)?.block !== region.joinBlock
        || header === join || yes === no || queryArray(raw.ipdom, guard)[header] !== join
        || !sameSet((outgoing.get(header) ?? []).map(edge => edge.to), new Set([yes, no]))) {
      return reject('conditional-boundary-mismatch');
    }
    const headerInsts = queryArray(byIndex.get(header).data.insts, guard);
    if (headerInsts.at(-1) !== region.branch || queryRecord(region.branch, guard, 128).op !== 'cbr') {
      return reject('conditional-terminator-mismatch');
    }
    const headerEdges = outgoing.get(header), yesKinds = headerEdges.find(edge => edge.to === yes).kinds,
      noKinds = headerEdges.find(edge => edge.to === no).kinds;
    if (yesKinds.length !== 1 || yesKinds[0] !== 'conditional-true' || !noKinds.includes('conditional-false')
        || noKinds.some(kind => !['conditional-false', 'fallthrough'].includes(kind))) {
      return reject('conditional-polarity-unavailable');
    }
    const arms = [];
    for (const role of ['yes', 'no']) {
      const entry = region.selection[role], colors = new Map(), members = new Set(), stack = [[entry, false]];
      while (stack.length) {
        guard.take('workItems');
        const [index, exit] = stack.pop();
        if (index === join) continue;
        if (exit) { colors.set(index, 2); continue; }
        if (colors.get(index) === 1 || index === header) return reject('cyclic-region');
        if (colors.get(index) === 2) continue;
        const block = byIndex.get(index), successors = outgoing.get(index);
        if (!block || !successors?.length) return reject('region-exit-before-join');
        if (raw.entry === index || block.data.isEntry === true) return reject('region-has-function-entry');
        const insts = queryArray(block.data.insts, guard);
        const op = queryRecord(insts.at(-1), guard, 128).op;
        // This prerequisite admits only explicit final BR/CBR terminators.
        // Trailing metadata and switch/residual forms need separate handling.
        if (!['br', 'cbr'].includes(op) || successors.length !== (op === 'br' ? 1 : 2)) return reject('unsupported-region-terminator');
        guard.take('allocationUnits', successors.length + 2);
        colors.set(index, 1); members.add(index); stack.push([index, true]);
        for (const edge of successors) stack.push([edge.to, false]);
      }
      const emitted = region.arms.find(arm => arm.role === role).emittedBlocks;
      if (!sameSet(emitted.map(block => block.index), members)
          || emitted.some(block => byIndex.get(block.index)?.block !== block)) return reject('emitted-membership-mismatch');
      arms.push({ role, entry, members });
    }
    if ([...arms[0].members].some(index => arms[1].members.has(index))) return reject('shared-arm-membership');
    const members = new Set([header, ...arms[0].members, ...arms[1].members]);
    for (const arm of arms) for (const index of arm.members) {
      guard.take('workItems', incoming.get(index).size);
      if ([...incoming.get(index)].some(from => !arm.members.has(from) && !(from === header && index === arm.entry))) {
        return reject('foreign-region-entry');
      }
    }
    const regionEdges = edges.filter(edge => members.has(edge.from));
    if (regionEdges.some(edge => edge.kinds.some(kind => !ORDINARY.has(kind)))) return reject('nonordinary-region-edge');
    const joinIncomingEdges = edges.filter(edge => edge.to === join);
    if (joinIncomingEdges.some(edge => edge.kinds.some(kind => !ORDINARY.has(kind)))) return reject('nonordinary-join-entry');
    const allValues = queryArray(raw.values, guard), valueSet = new Set(allValues);
    const allInstructions = queryArray(raw.instructions, guard), instructionSet = new Set(allInstructions);
    guard.take('allocationUnits', allValues.length + allInstructions.length);
    const phis = [], memoryPhis = [], instructions = [];
    for (const index of [...members, join]) {
      const { block, data } = byIndex.get(index);
      const blockPhis = queryArray(data.phis, guard);
      if (index === join && (blockPhis.length !== region.joinPhis.length
          || blockPhis.some((phi, offset) => phi !== region.joinPhis[offset]))) return reject('join-phi-producer-mismatch');
      for (const phi of blockPhis) {
        const definition = queryRecord(phi, guard, 128), operands = queryArray(definition.incoming, guard);
        const inputs = operands.map(item => queryRecord(item, guard));
        if (!instructionSet.has(phi) || definition.op !== 'phi' || definition.block !== index || !valueSet.has(definition.dst)
            || !sameSet(inputs.map(input => input.from), incoming.get(index))
            || inputs.some(input => !valueSet.has(input.value))) return reject('phi-inventory-mismatch');
        guard.take('allocationUnits', inputs.length + 1);
        phis.push(freeze({ block, phi, incoming:freeze(inputs.map((input, offset) => freeze({
          operand:operands[offset], predecessor:byIndex.get(input.from).block, value:input.value,
          role:input.from === header ? 'header' : arms.find(arm => arm.members.has(input.from))?.role ?? 'outside',
        }))) }));
      }
      const pendingMemoryPhis = queryArray(data.memPhis ?? [], guard);
      guard.take('allocationUnits', pendingMemoryPhis.length);
      memoryPhis.push(...pendingMemoryPhis.map(phi => freeze({ block, phi, validation:'required' })));
      const insts = queryArray(data.insts, guard); guard.take('allocationUnits', insts.length);
      if (insts.some(inst => !instructionSet.has(inst) || queryRecord(inst, guard, 128).block !== index)) {
        return reject('instruction-inventory-mismatch');
      }
      instructions.push(...insts);
    }
    // Enumerate every instruction as an outstanding semantics obligation. No
    // opcode shortlist can certify absence of memory, traps or other effects.
    const result = freeze({ version:1, status:'complete', scope:'conditional-region-structure-only',
      transformAuthorization:false, semanticValidation:'required', region,
      blocks:freeze(blocks), functionEntry:byIndex.get(raw.entry).block, cfgEdges:freeze(edges),
      arms:freeze(arms.map(arm => freeze({ role:arm.role, entry:byIndex.get(arm.entry).block,
        members:freeze([...arm.members].map(index => byIndex.get(index).block)) }))),
      edges:freeze(regionEdges), joinIncomingEdges:freeze(joinIncomingEdges),
      phis:freeze(phis), memoryPhis:freeze(memoryPhis), instructions:freeze(instructions),
    });
    guard.check();
    if (readSemanticConditionalRegion(record, ir) !== region) return reject('stale-region');
    issued.set(result, { record, region, ir, identity:guard.identity, guard });
    return result;
  } catch (error) { return reject(guard?.reason() ?? error.reason ?? 'structure-unavailable'); }
}
