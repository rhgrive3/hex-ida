/** Native table candidates from captured SSA/MemorySSA and bounded file reads.
 * Enumerating file contents does not prove runtime contents, reachability,
 * pointer authentication, relocation, or target-set closure.
 */
import { createEntityId } from '../../core/identity/index.js';
import { contractFail, unsignedAddress } from '../../core/identity/structured.js';
import { canonicalDispatchSite, literalTarget } from '../query/semantic/call-targets.js';
import { singletonFact, evaluateBinaryFact } from '../../decompiler/phase8/range.js';

const MAX_SLOTS = 64, MAX_VALUES = 64;
const addressText = value => '0x' + value.toString(16);
function definition(projection, valueId) {
  const value = projection.canonicalValue(valueId);
  const reference = value && projection.entityReference('semantic-ir', value.definitionNodeId);
  return reference ? projection.source(reference) : null;
}
/** Follow only the existing SSA owner's unique dominance rename. A phi,
 * unknown clobber or subregister transform cannot be treated as identity. */
function renamedValue(projection, node, work) {
  const reference = projection.entityReference('semantic-ir', node.id), values = new Set();
  for (const edgeId of projection.adjacent(reference, 'backward')) {
    work.charge('edges');
    const edge = projection.edge(edgeId), use = projection.source(edge.from);
    if (edge.kind !== 'operation-input' || use?.proof?.kind !== 'renamed-use'
      || use.sourceEntityId !== node.id || use.proof.variableIdentity?.key !== node.variable?.key) continue;
    for (const incoming of projection.adjacent(edge.from, 'backward')) {
      work.charge('edges');
      const link = projection.edge(incoming), source = projection.source(link.from);
      if (link.kind !== 'ssa-use-def' || source?.kind !== 'definition' || source.proof?.kind !== 'renamed-definition'
        || source.proof.broadUnknown !== false || source.variableKey !== node.variable.key
        || source.proof.machineType?.widthBits !== use.proof.machineType?.widthBits
        || source.proof.transform?.proofKind !== 'dominance-renaming') return null;
      const id = source.proof.sourceSemanticValueId;
      if (typeof id !== 'string') return null;
      values.add(id);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}
function constantValue(projection, valueId, work, depth = 0) {
  work.charge('workUnits');
  if (depth >= 8) return null;
  const literal = literalTarget(projection, valueId);
  if (literal) return BigInt(literal.address);
  const node = definition(projection, valueId);
  if (node?.kind === 'const') {
    const constant = node.attributes?.constant;
    if (constant?.kind === 'bitvector' && Number.isInteger(constant.widthBits) && constant.widthBits > 0 && constant.widthBits <= 64) {
      return BigInt.asUintN(constant.widthBits, BigInt(constant.value));
    }
  }
  if (node?.kind !== 'state-read') return null;
  const next = renamedValue(projection, node, work);
  return next ? constantValue(projection, next, work, depth + 1) : null;
}
function scalarOperation(projection, node, valueId, work) {
  if (!node || node.completeness !== 'complete' || node.unknown) return null;
  if (['binary', 'address'].includes(node.kind) && ['add', 'sub', 'shl'].includes(node.operator)
    && node.inputs.length === 2) return { operator: node.operator, inputs: node.inputs };
  // The canonical owner emits A64 ADD as AddWithCarry(x, y, 0) with an
  // explicit subtract=false marker. Only that integer result is addition;
  // carry/overflow outputs and unknown/subtract forms are not addresses.
  const operationMetadata = node.attributes?.machineEffects?.operationMetadata;
  if (node.kind === 'intrinsic' && node.operator === 'add-with-carry' && node.inputs.length === 3
    && node.outputs[0] === valueId && operationMetadata && typeof operationMetadata === 'object'
    && !Array.isArray(operationMetadata) && Object.hasOwn(operationMetadata, 'subtract')
    && operationMetadata.subtract === false && constantValue(projection, node.inputs[2], work) === 0n) {
    return { operator: 'add', inputs: node.inputs.slice(0, 2) };
  }
  return null;
}
function loadPlan(projection, valueId, work, maximumHops, seen = new Set()) {
  work.charge('workUnits');
  if (seen.has(valueId) || seen.size >= Math.min(32, maximumHops)) return null;
  const nextSeen = new Set(seen).add(valueId), node = definition(projection, valueId);
  if (!node) return null;
  if (node.kind === 'load') return { node, transforms: [], references: [node.id] };
  if (node.kind === 'state-read') {
    const next = renamedValue(projection, node, work);
    const plan = next && loadPlan(projection, next, work, maximumHops, nextSeen);
    return plan ? { ...plan, references: [...plan.references, node.id] } : null;
  }
  const outputBits = projection.canonicalValue(valueId)?.machineType?.widthBits;
  if (!Number.isInteger(outputBits) || outputBits < 1 || outputBits > 64) return null;
  const scalar = scalarOperation(projection, node, valueId, work);
  if (scalar) {
    let operand = scalar.inputs[0], constant = constantValue(projection, scalar.inputs[1], work);
    if (constant === null && scalar.operator === 'add') { constant = constantValue(projection, scalar.inputs[0], work); operand = scalar.inputs[1]; }
    if (constant === null || (scalar.operator === 'shl' && constant >= BigInt(outputBits))) return null;
    const plan = loadPlan(projection, operand, work, maximumHops, nextSeen);
    return plan ? { ...plan, transforms: [...plan.transforms, { operator: scalar.operator, constant: constant.toString(), bits: outputBits, nodeId: node.id }],
      references: [...plan.references, node.id] } : null;
  }
  if (['cast', 'unary', 'sext', 'zext'].includes(node.kind) && ['sext', 'zext', 'sign-extend', 'zero-extend'].includes(node.operator) && node.inputs.length === 1) {
    const bits = projection.canonicalValue(node.inputs[0])?.machineType?.widthBits;
    if (!Number.isInteger(bits) || bits < 1 || bits > outputBits) return null;
    const plan = loadPlan(projection, node.inputs[0], work, maximumHops, nextSeen);
    return plan ? { ...plan, transforms: [...plan.transforms, { operator: ['sext', 'sign-extend'].includes(node.operator) ? 'sext' : 'zext', fromBits: bits, bits: outputBits, nodeId: node.id }],
      references: [...plan.references, node.id] } : null;
  }
  return null;
}
/** Enumerate the existing Phase8 interval/congruence, never infer index bounds
 * from adjacent data, symbol size or a guessed table sentinel. */
function ownerFiniteValues(projection, valueId, demand, work) {
  const bindings = demand.ranges.bindings.filter(row => row.semanticValueId === valueId || row.semanticSsaValueId === valueId);
  const ids = new Set(bindings.map(row => row.localId));
  const rows = demand.ranges.values.filter(row => ids.has(row.localId));
  const addresses = new Set(), evidenceIds = [], reasons = [];
  for (const row of rows) {
    work.charge('workUnits');
    if (row.completeness !== 'complete' || row.conditionalOn?.length || !Number.isInteger(row.fact?.bits)
      || row.fact.bits < 1 || row.fact.bits > 64) { reasons.push('dispatch-address-range-unqualified'); continue; }
    const node = definition(projection, valueId), fact = row.fact, range = fact.range;
    // Old compat lowering can incorrectly copy the base of an indexed address.
    // Such a row cannot authorize even finite table enumeration.
    if (node?.kind === 'address' && node.attributes?.machineEffects?.bundleMetadata?.addressing?.offsetKind === 'register'
      && fact.provenance?.operation === 'mov') {
      reasons.push('dispatch-indexed-address-owner-mismatch'); continue;
    }
    if (!['interval', 'full', 'wrapped'].includes(range?.kind) || range.bits !== fact.bits) { reasons.push('dispatch-address-range-open'); continue; }
    const lower = BigInt(range.lower), upper = BigInt(range.upper);
    const modulus = BigInt(fact.congruence?.modulus ?? 1), remainder = BigInt(fact.congruence?.remainder ?? 0);
    const ceiling = 1n << BigInt(fact.bits), zero = BigInt(fact.knownZero ?? 0), one = BigInt(fact.knownOne ?? 0);
    if (lower < 0n || upper < 0n || lower >= ceiling || upper >= ceiling || (range.kind !== 'wrapped' && upper < lower)
      || modulus < 1n || modulus > ceiling || remainder < 0n || remainder >= modulus
      || zero < 0n || one < 0n || zero >= ceiling || one >= ceiling || (zero & one) !== 0n) {
      contractFail('dispatch-address-range-invalid');
    }
    const first = lower + ((remainder - lower) % modulus + modulus) % modulus;
    let values = [];
    if (range.kind !== 'wrapped' && first <= upper && (upper - first) / modulus + 1n <= BigInt(MAX_VALUES)) {
      for (let value = first; value <= upper; value += modulus) values.push(value);
    } else {
      const unknown = [];
      for (let bit = 0; bit < fact.bits; bit++) if (((zero | one) & (1n << BigInt(bit))) === 0n) unknown.push(bit);
      if (unknown.length > 6) { reasons.push('dispatch-address-range-open'); continue; }
      values = [one];
      for (const bit of unknown) values.push(...values.map(value => value | (1n << BigInt(bit))));
    }
    evidenceIds.push(row.entityId);
    for (const value of values) {
      work.charge('workUnits');
      const inRange = range.kind === 'wrapped' ? value >= lower || value <= upper : value >= lower && value <= upper;
      if (!inRange || value % modulus !== remainder || (value & zero) !== 0n || (value & one) !== one) continue;
      if (addresses.size >= MAX_VALUES && !addresses.has(value.toString())) { reasons.push('dispatch-address-enumeration-cut'); break; }
      addresses.add(value.toString());
    }
  }
  if (!rows.length) reasons.push('dispatch-address-range-unavailable');
  return { addresses: [...addresses].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1), evidenceIds, reasons };
}
/** Bounded candidate composition uses the existing Phase8 bitvector evaluator
 * on enumerated owner facts. It does not issue or publish a new range fact. */
export function nativeDispatchAddressValues(projection, valueId, demand, work) {
  const memo = new Map(), active = new Set();
  const enumerate = (id, depth) => {
    work.charge('workUnits');
    if (memo.has(id)) return memo.get(id);
    if (depth > 16 || active.has(id) || memo.size + active.size >= 64) return { addresses: [], evidenceIds: [], reasons: ['dispatch-address-producer-cut'] };
    active.add(id);
    try {
      const owned = ownerFiniteValues(projection, id, demand, work);
      if (owned.addresses.length) { memo.set(id, owned); return owned; }
      const node = definition(projection, id), bits = projection.canonicalValue(id)?.machineType?.widthBits;
      const scalar = scalarOperation(projection, node, id, work);
      let result = owned;
      if (node?.kind === 'const') {
        const value = constantValue(projection, id, work);
        if (value !== null) result = { addresses: [value.toString()], evidenceIds: [node.id], reasons: [] };
      } else if (node?.kind === 'state-read') {
        const next = renamedValue(projection, node, work);
        if (next) result = enumerate(next, depth + 1);
      } else if (scalar && Number.isInteger(bits) && bits >= 1 && bits <= 64) {
        const left = enumerate(scalar.inputs[0], depth + 1), right = enumerate(scalar.inputs[1], depth + 1);
        if (left.addresses.length && right.addresses.length && left.addresses.length * right.addresses.length <= MAX_VALUES) {
          const values = new Set();
          for (const a of left.addresses) for (const b of right.addresses) {
            work.charge('workUnits');
            const fact = evaluateBinaryFact(scalar.operator, singletonFact(BigInt(a), { bits }), singletonFact(BigInt(b), { bits }));
            if (fact.constant?.value == null) return { addresses: [], evidenceIds: [], reasons: ['dispatch-scalar-enumeration-open'] };
            values.add(fact.constant.value.toString());
          }
          result = { addresses: [...values], evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds, node.id])], reasons: [...left.reasons, ...right.reasons] };
        }
      }
      memo.set(id, result); return result;
    } finally { active.delete(id); }
  };
  const result = enumerate(valueId, 0);
  return { ...result, addresses: result.addresses.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1) };
}
function transformTarget(bytes, endian, plan) {
  let value = 0n;
  for (const byte of endian === 'little' ? [...bytes].reverse() : bytes) value = value * 256n + BigInt(byte);
  for (const step of plan.transforms) {
    if (step.operator === 'sext') value = BigInt.asIntN(step.fromBits, value);
    else if (step.operator === 'zext') value = BigInt.asUintN(step.fromBits, value);
    else if (step.operator === 'add') value += BigInt(step.constant);
    else if (step.operator === 'sub') value -= BigInt(step.constant);
    else if (step.operator === 'shl') value <<= BigInt(step.constant);
    value = BigInt.asUintN(step.bits, value);
  }
  return BigInt.asUintN(64, value);
}
export async function nativeMemoryDispatchCandidates(projection, node, demand, request, { world, assumptions, work, readMemory, members }) {
  const candidates = [], requirements = [], sources = new Map(), selected = members.map(row => row.projection);
  const input = projection.inputIdentity, site = canonicalDispatchSite(node);
  const checkedRead = async (address, length) => {
    const key = `${address}:${length}`;
    if (sources.has(key)) return sources.get(key);
    if (sources.size >= MAX_SLOTS) { requirements.push('native-dispatch-slot-budget'); return null; }
    const value = await work.await(() => readMemory({ address, length }, { world, assumptions, projection, work }));
    work.checkpoint();
    if (value?.status !== 'completed') { requirements.push(value?.reason ?? 'native-dispatch-source-unavailable'); sources.set(key, null); return null; }
    if (value.schema !== 'native-dispatch-source/v1' || value.worldId !== world.id || value.assumptionsId !== assumptions.id
      || value.snapshotId !== input.snapshotId || value.binaryId !== input.binaryId || value.sliceId !== input.sourceLocation?.sliceId
      || unsignedAddress(value.address) !== unsignedAddress(address) || value.length !== length || value.exact !== false
      || !Array.isArray(value.bytes) || value.bytes.length !== length || value.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      contractFail('native-dispatch-memory-source-binding');
    }
    sources.set(key, value); return value;
  };
  const importCandidate = (source, references) => {
    if (!request.families.includes('import-stub') || !source.importDeclaration) return false;
    const declaration = { source, callerInput: input, relation: 'loader-declared-import-site', targetIdentityResolved: false };
    candidates.push({ targetEntityId: createEntityId({ binaryId: input.binaryId, kind: 'native-import-site', identity: {
      worldId: world.id, sliceId: source.sliceId, address: source.address, import: source.importDeclaration } }),
      binaryId: input.binaryId, address: null, family: 'import-stub', evidenceIds: [...references, source.id],
      requirements: ['import-resolver-target-open', 'weak-import-presence-unqualified', 'interposition-and-image-closure-open'],
      provenance: { schema: 'dispatch-owner-reference/v1', worldId: world.id, binaryId: input.binaryId,
        artifactId: input.producerArtifactId, ownerRevision: source.version,
        id: createEntityId({ binaryId: input.binaryId, kind: 'native-import-reference', identity: declaration }), declaration } });
    return true;
  };
  // A direct transfer to an existing loader stub still has unresolved external
  // identity; the stub address is not silently relabelled as the import target.
  if (request.families.includes('import-stub')) {
    const direct = site.address == null ? (site.targetValueIds ?? []).map(id => constantValue(projection, id, work)).filter(value => value !== null) : [BigInt(site.address)];
    for (const address of direct.slice(0, 8)) {
      if (candidates.length >= request.maxTargets) break;
      const source = await checkedRead(address.toString(), 4);
      if (source) importCandidate(source, [node.id]);
    }
  }
  for (const valueId of (site.targetValueIds ?? []).slice(0, 8)) {
    if (candidates.length >= request.maxTargets) { requirements.push('native-target-result-cut'); break; }
    const plan = loadPlan(projection, valueId, work, request.maxHops);
    if (!plan) { requirements.push('native-load-target-transform-open'); continue; }
    const accesses = (demand.memoryObjects?.accesses ?? []).filter(access => access.nodeId === plan.node.id && access.kind === 'load');
    const access = accesses[0], memoryRef = access && projection.entityReference('memoryssa', access.memoryEntityId);
    if (!access || !memoryRef || projection.source(memoryRef)?.sourceEntityId !== plan.node.id
      || access.addressValueId !== plan.node.memory.addressExpr?.valueId || access.widthBits !== plan.node.memory.widthBits
      || ![8, 16, 32, 64].includes(access.widthBits) || !['little', 'big'].includes(access.endian)) {
      requirements.push('native-table-memory-owner-unbound'); continue;
    }
    const values = nativeDispatchAddressValues(projection, access.addressValueId, demand, work);
    requirements.push(...values.reasons);
    for (const address of values.addresses) {
      if (candidates.length >= request.maxTargets) { requirements.push('native-target-result-cut'); break; }
      const source = await checkedRead(address, access.widthBits / 8);
      if (!source) continue;
      if (importCandidate(source, [node.id, access.nodeId, access.memoryEntityId])) continue;
      if (!request.families.includes('jump-table') && !request.families.includes('register')) continue;
      const targetAddress = transformTarget(source.bytes, access.endian, plan);
      if (targetAddress % 4n !== 0n) { requirements.push('native-table-target-alignment-unqualified'); continue; }
      const targets = selected.filter(target => target.inputIdentity.binaryId === input.binaryId
        && target.inputIdentity.sourceLocation?.sliceId === input.sourceLocation?.sliceId
        && BigInt(target.inputIdentity.sourceLocation.start) === targetAddress);
      const target = targets.length === 1 ? targets[0] : null;
      const declaration = { source, access, transforms: plan.transforms, rangeEvidenceIds: values.evidenceIds,
        callerInput: input, calleeInput: target?.inputIdentity ?? null,
        tableEnumeration: { selectedSlots: values.addresses.length, completeForRange: values.reasons.length === 0 },
        runtimeContentsProven: false, relation: 'current-file-load-through-canonical-scalar-target-expression' };
      const targetEntityId = target?.functionId ?? createEntityId({ binaryId: input.binaryId, kind: 'native-code-location',
        identity: { worldId: world.id, sliceId: input.sourceLocation?.sliceId, address: addressText(targetAddress) } });
      candidates.push({ targetEntityId, binaryId: input.binaryId, address: addressText(targetAddress),
        family: request.families.includes('jump-table') ? 'jump-table' : 'register',
        evidenceIds: [...new Set([node.id, ...plan.references, access.memoryEntityId, source.id, ...values.evidenceIds])],
        requirements: ['runtime-table-contents-unqualified', 'table-relocation-and-code-validity-unqualified', 'normal-target-vs-trap-domain-not-qualified',
          ...(target ? [] : ['target-not-selected-canonical-function-entry'])],
        provenance: { schema: 'dispatch-owner-reference/v1', worldId: world.id, binaryId: input.binaryId,
          artifactId: input.producerArtifactId, ownerRevision: source.version,
          id: createEntityId({ binaryId: input.binaryId, kind: 'native-table-reference', identity: declaration }), declaration } });
    }
    await work.yieldIfNeeded();
  }
  return { candidates, requirements };
}
