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

    if (bundle.mnemonic === 'new') {
      const produced = bundle.producedValues?.[0];
      const allocation = allocationMetadata(produced);
      if (!allocation) continue;
      changed = true;
      nodeReplacements.set(node.id, {
        ...node,
        kind: 'intrinsic',
        operator: 'jvm-new',
        intrinsic: jvmAllocationIntrinsic(node),
        attributes: {
          ...node.attributes,
          semantic: 'allocation',
          allocatedClass: allocation.allocatedClass,
          allocationId: allocation.allocationId,
          allocationState: allocation.allocationState,
          fresh: allocation.fresh,
        },
        metadata: {
          ...(node.metadata ?? {}),
          allocatedClass: allocation.allocatedClass,
          allocationId: allocation.allocationId,
          allocationState: allocation.allocationState,
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
      if (!allocations.some(Boolean)) continue;
      changed = true;
      const allocationIds = [...new Set(allocations.filter(Boolean).map((entry) => entry.allocationId))];
      nodeReplacements.set(node.id, {
        ...node,
        attributes: {
          ...node.attributes,
          allocationIds,
          preservesAllocationIdentity: true,
        },
      });
      for (let index = 0; index < node.outputs.length; index += 1) {
        const allocation = allocations[index];
        if (!allocation) continue;
        const value = old.values.find((candidate) => candidate.id === node.outputs[index]);
        if (value) valueReplacements.set(value.id, replaceValueMetadata(value, allocation));
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
  const nodes = old.nodes.map((node) => nodeReplacements.get(node.id) ?? node);
  const values = old.values.map((value) => valueReplacements.get(value.id) ?? value);
  const semanticIr = createSemanticIrFunction({ ...old, nodes, values }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}
