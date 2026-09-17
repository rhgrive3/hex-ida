import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

function effectBundleForNode(node, bundleByEffect) {
  const effectId = node?.sourceEffectIds?.find((id) => bundleByEffect.has(id));
  return effectId == null ? null : bundleByEffect.get(effectId);
}

function replaceValueMetadata(value, extraMetadata) {
  return {
    ...value,
    metadata: {
      ...(value.metadata ?? {}),
      ...extraMetadata,
    },
  };
}

function allocationMetadata(value) {
  if (!value || typeof value.allocationId !== 'string' || typeof value.allocatedClass !== 'string') return null;
  return {
    allocationId: value.allocationId,
    allocatedClass: value.allocatedClass,
    allocationState: value.allocationState === 'initialized' ? 'initialized' : 'uninitialized',
    fresh: value.fresh === true,
    referenceKind: value.referenceKind ?? 'new-allocation',
  };
}

function instanceofMetadata(value) {
  if (!value || typeof value.predicateTargetClass !== 'string') return null;
  return {
    predicateKind: value.predicateKind ?? 'jvm-instanceof',
    predicateTargetClass: value.predicateTargetClass,
    booleanEncoding: value.booleanEncoding ?? 'int32-0-or-1',
    referenceKind: value.referenceKind ?? 'type-test-result',
  };
}

function jvmInstanceofIntrinsic(node) {
  return {
    inputs: [...node.inputs],
    outputs: [...node.outputs],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'input-dependent',
    symbolicDetail: 'available',
  };
}

function machineTypeKey(machineType) {
  if (!machineType) return '';
  return `${machineType.kind}:${machineType.widthBits}:${machineType.format || ''}:${machineType.addressSpace || ''}`;
}

// #8843 req 1/2/3/5: `dup` is a stack identity transformation, not a
// computation. The lowering core creates one fresh canonical value per
// `producedValues` entry and publishes them behind an `operator: null`
// `complete` unary node, so no consumer can recover the JVM-mandated equality
// between the two result slots. A canonical node also cannot name one value id
// twice (`semantic-ir-invalid-node-inputs-duplicate`), so the schema's
// sanctioned fallback applies: lower `dup` to a single canonical `copy` of the
// input value whose result values all share that one definition, each carrying
// explicit alias authority (`duplicatedValueId` plus group membership) and the
// source value's evidence, instead of an invented unary computation.
const DUPLICATED_VALUE_EVIDENCE = Object.freeze(
  ['constant', 'isNull', 'valueType', 'referenceKind', 'stringRef'],
);

function applyDupIdentityAuthority({ dupPlans, nodeReplacements, valueReplacements, valuesById }) {
  for (const plan of dupPlans) {
    if (!plan.inputId || plan.duplicates.length === 0) continue;
    const source = valuesById.get(plan.inputId);
    if (!source) continue;
    const resultIds = [plan.surviving, ...plan.duplicates];
    const machineType = machineTypeKey(source.machineType);
    let shapeOk = plan.node.kind === 'unary' || plan.node.kind === 'copy';
    for (const resultId of resultIds) {
      const value = valuesById.get(resultId);
      if (!value || value.kind !== 'definition' || machineTypeKey(value.machineType) !== machineType) shapeOk = false;
    }
    if (!shapeOk) continue;
    const evidence = {};
    for (const key of DUPLICATED_VALUE_EVIDENCE) {
      if (source.metadata && source.metadata[key] !== undefined) evidence[key] = source.metadata[key];
    }
    const base = nodeReplacements.get(plan.nodeId) ?? plan.node;
    nodeReplacements.set(plan.nodeId, {
      ...base,
      kind: 'copy',
      inputs: [plan.inputId],
      outputs: resultIds,
      attributes: {
        ...(base.attributes ?? {}),
        stackManipulation: 'dup',
        duplicatedValueId: plan.inputId,
        duplicateValueIds: resultIds,
      },
    });
    for (const resultId of resultIds) {
      valueReplacements.set(resultId, replaceValueMetadata(valuesById.get(resultId), {
        ...evidence,
        duplicatedValueId: plan.inputId,
        duplicateValueIds: resultIds,
      }));
    }
  }
}

function jvmAllocationIntrinsic(node) {
  return {
    inputs: [...node.inputs],
    outputs: [...node.outputs],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    // Heap allocation/freshness is intentionally still fail-closed: the
    // canonical memory-effect schema cannot name a fresh object allocation.
    memoryWrite: { scope: 'unknown' },
    controlEffects: [],
    determinism: 'nondeterministic',
    symbolicDetail: 'summary-only',
  };
}

export function overlayJvmObjectLowering(fn, lowered, options = {}) {
  if (fn?.frontendId !== 'jvm') return lowered;
  const old = lowered.semanticIr;
  const bundleByEffect = new Map((fn.bundles ?? []).map((bundle) => [bundle.operationId, bundle]));
  const nodeReplacements = new Map();
  const valueReplacements = new Map();
  const dupPlans = [];
  let changed = false;

  for (const node of old.nodes) {
    const bundle = effectBundleForNode(node, bundleByEffect);
    if (!bundle) continue;

    if (bundle.mnemonic === 'instanceof') {
      const produced = bundle.producedValues?.[0];
      const predicate = instanceofMetadata(produced);
      if (!predicate) continue;
      changed = true;
      nodeReplacements.set(node.id, {
        ...node,
        kind: 'intrinsic',
        operator: 'jvm-instanceof',
        intrinsic: jvmInstanceofIntrinsic(node),
        attributes: {
          ...node.attributes,
          semantic: 'type-test',
          predicate: 'instanceof',
          targetType: { kind: 'jvm-class', name: predicate.predicateTargetClass },
          resultPredicate: {
            kind: 'predicate',
            widthBits: 1,
            encoding: predicate.booleanEncoding,
            trueValue: 1,
            falseValue: 0,
          },
        },
        metadata: {
          ...(node.metadata ?? {}),
          typeTestTargetClass: predicate.predicateTargetClass,
          typeTestPredicate: predicate.predicateKind,
        },
      });
      for (const outputId of node.outputs) {
        const value = old.values.find((candidate) => candidate.id === outputId);
        if (value) valueReplacements.set(outputId, replaceValueMetadata(value, predicate));
      }
      continue;
    }

    if (bundle.mnemonic === 'new'
      || bundle.mnemonic === 'newarray'
      || bundle.mnemonic === 'anewarray'
      || bundle.mnemonic === 'multianewarray') {
      const produced = bundle.producedValues?.[0];
      const allocation = allocationMetadata(produced);
      if (!allocation) continue;
      const isArrayAllocation = bundle.mnemonic !== 'new';
      changed = true;
      nodeReplacements.set(node.id, {
        ...node,
        kind: 'intrinsic',
        operator: `jvm-${bundle.mnemonic}`,
        intrinsic: jvmAllocationIntrinsic(node),
        attributes: {
          ...node.attributes,
          semantic: 'allocation',
          allocatedClass: allocation.allocatedClass,
          allocationId: allocation.allocationId,
          allocationState: allocation.allocationState,
          fresh: allocation.fresh,
          ...(isArrayAllocation ? { allocationKind: 'array' } : {}),
        },
        metadata: {
          ...(node.metadata ?? {}),
          allocatedClass: allocation.allocatedClass,
          allocationId: allocation.allocationId,
          allocationState: allocation.allocationState,
          ...(isArrayAllocation ? { allocationKind: 'array' } : {}),
        },
      });
      for (const outputId of node.outputs) {
        const value = old.values.find((candidate) => candidate.id === outputId);
        if (value) valueReplacements.set(outputId, replaceValueMetadata(value, allocation));
      }
      continue;
    }

    if (bundle.mnemonic === 'dup') {
      const allocations = (bundle.producedValues ?? []).map(allocationMetadata);
      const allocationIds = [...new Set(allocations.filter(Boolean).map((entry) => entry.allocationId))];
      const allocation = allocations.find(Boolean) ?? null;
      changed = true;
      nodeReplacements.set(node.id, {
        ...node,
        attributes: {
          ...node.attributes,
          ...(allocationIds.length ? { allocationIds, preservesAllocationIdentity: true } : {}),
        },
      });
      for (let index = 0; index < node.outputs.length; index += 1) {
        const entry = allocations[index];
        if (!entry) continue;
        const value = old.values.find((candidate) => candidate.id === node.outputs[index]);
        if (value) valueReplacements.set(value.id, replaceValueMetadata(value, entry));
      }
      if (allocation == null || allocationIds.length <= 1) {
        dupPlans.push({
          nodeId: node.id,
          node,
          inputId: typeof node.inputs?.[0] === 'string' ? node.inputs[0] : null,
          surviving: node.outputs[0],
          duplicates: node.outputs.slice(1),
        });
      }
      continue;
    }

    if (bundle.mnemonic === 'invokespecial') {
      const call = bundle.callEffects?.[0];
      if (!call?.initializesAllocation || typeof call.receiverAllocationId !== 'string') continue;
      changed = true;
      nodeReplacements.set(node.id, {
        ...node,
        attributes: {
          ...node.attributes,
          receiverAllocationId: call.receiverAllocationId,
          initializesAllocation: true,
          ...(typeof call.owner === 'string' ? { constructorOwner: call.owner } : {}),
        },
        metadata: {
          ...(node.metadata ?? {}),
          receiverAllocationId: call.receiverAllocationId,
          initializesAllocation: true,
        },
      });
    }
  }

  if (!changed) return lowered;
  if (dupPlans.length) {
    applyDupIdentityAuthority({
      dupPlans,
      nodeReplacements,
      valueReplacements,
      valuesById: new Map(old.values.map((value) => [value.id, value])),
    });
  }
  const nodes = old.nodes.map((node) => nodeReplacements.get(node.id) ?? node);
  const values = old.values.map((value) => valueReplacements.get(value.id) ?? value);
  const semanticIr = createSemanticIrFunction({ ...old, nodes, values }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}
