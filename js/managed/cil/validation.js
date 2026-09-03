import { createManagedValidationReport } from '../shared/validation.js';

function safeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stackValue(value) {
  const bits = value?.bits;
  return Object.freeze({ bits: safeInteger(bits) && bits > 0 ? bits : null });
}

function cloneStack(stack) {
  return stack.map((value) => ({ ...value }));
}

function mergeStacks(existing, incoming) {
  if (existing.length !== incoming.length) return { ok:false, reason:'cil-stack-height-merge-mismatch' };
  const merged = [];
  let imprecise = false;
  for (let i = 0; i < existing.length; i++) {
    const left = existing[i]?.bits ?? null;
    const right = incoming[i]?.bits ?? null;
    if (left != null && right != null && left !== right) return { ok:false, reason:'cil-stack-type-merge-mismatch' };
    const bits = left === right ? left : null;
    if (bits == null && left !== right) imprecise = true;
    merged.push({ bits });
  }
  return { ok:true, stack:merged, imprecise };
}

function regionMembership(regions, offset) {
  return regions
    .filter((region) => safeInteger(region.startOffset) && safeInteger(region.endOffset)
      && offset >= region.startOffset && offset < region.endOffset)
    .map((region) => region.id)
    .sort();
}

function sameMembership(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function instructionEndOffset(bundle) {
  const offset = bundle?.bytecodeOffset;
  if (!safeInteger(offset)) return null;
  const range = bundle?.origin?.byteRanges?.[0];
  const start = range?.start;
  const end = range?.end;
  if (typeof start === 'number' && Number.isSafeInteger(start)
    && typeof end === 'number' && Number.isSafeInteger(end) && end > start) {
    return offset + (end - start);
  }
  return offset + 1;
}

function branchTargets(bundle) {
  const targets = [];
  for (const effect of bundle.controlEffects || []) {
    if ((effect?.kind === 'branch' || effect?.kind === 'conditional-branch') && safeInteger(effect.targetOffset)) {
      targets.push(effect.targetOffset);
    }
  }
  return targets;
}

function isTerminal(bundle) {
  return (bundle.controlEffects || []).some((effect) => effect?.kind === 'return' || effect?.kind === 'throw');
}

function hasUnconditionalBranch(bundle) {
  return (bundle.controlEffects || []).some((effect) => effect?.kind === 'branch');
}

function handlerEntryStack(region) {
  if (region?.handlerKind === 'catch' || region?.handlerKind === 'filter') return [{ bits:64 }];
  return [];
}

export function validateCilEffectFunction(decoded, context = {}) {
  const bundles = Array.isArray(decoded?.bundles) ? decoded.bundles : [];
  const methodId = decoded?.methodId;
  const errors = [];
  const warnings = [];
  const verifierFacts = [];
  const offsets = new Map();
  let endOffset = 0;

  for (let i = 0; i < bundles.length; i++) {
    const offset = bundles[i]?.bytecodeOffset;
    if (!safeInteger(offset) || offsets.has(offset)) {
      errors.push({ code:'cil-invalid-instruction-boundary', operationId:bundles[i]?.operationId ?? null, offset });
      continue;
    }
    offsets.set(offset, i);
    endOffset = Math.max(endOffset, instructionEndOffset(bundles[i]) ?? (offset + 1));
  }

  const maxStack = decoded?.entryState?.maxStack;
  const maxStackKnown = safeInteger(maxStack);
  if (!maxStackKnown) warnings.push({ code:'cil-max-stack-unavailable' });

  const regions = Array.isArray(decoded?.exceptionRegions) ? decoded.exceptionRegions : [];
  const validBoundary = (offset, allowEnd = false) => safeInteger(offset) && (offsets.has(offset) || (allowEnd && offset === endOffset));
  for (const region of regions) {
    if (!validBoundary(region?.startOffset) || !validBoundary(region?.endOffset, true)
      || !validBoundary(region?.handlerOffset) || region.endOffset <= region.startOffset) {
      errors.push({ code:'cil-invalid-exception-region-boundary', regionId:region?.id ?? null });
    }
    if (region?.filterOffset != null && !validBoundary(region.filterOffset)) {
      errors.push({ code:'cil-invalid-filter-boundary', regionId:region?.id ?? null, offset:region.filterOffset });
    }
  }

  const states = new Map();
  const queue = [];
  const enqueue = (offset, stack, source) => {
    if (!offsets.has(offset)) {
      errors.push({ code:'cil-invalid-branch-target', sourceOffset:source ?? null, targetOffset:offset });
      return;
    }
    const previous = states.get(offset);
    if (!previous) {
      states.set(offset, cloneStack(stack));
      queue.push(offset);
      return;
    }
    const merged = mergeStacks(previous, stack);
    if (!merged.ok) {
      errors.push({ code:merged.reason, sourceOffset:source ?? null, targetOffset:offset,
        existingHeight:previous.length, incomingHeight:stack.length });
      return;
    }
    const changed = merged.stack.some((value, index) => value.bits !== previous[index]?.bits);
    if (merged.imprecise) warnings.push({ code:'cil-stack-type-merge-imprecise', targetOffset:offset });
    if (changed) {
      states.set(offset, merged.stack);
      queue.push(offset);
    }
  };

  if (bundles.length > 0 && safeInteger(bundles[0]?.bytecodeOffset)) enqueue(bundles[0].bytecodeOffset, [], null);
  for (const region of regions) {
    if (safeInteger(region?.handlerOffset) && offsets.has(region.handlerOffset)) enqueue(region.handlerOffset, handlerEntryStack(region), null);
    if (safeInteger(region?.filterOffset) && offsets.has(region.filterOffset)) enqueue(region.filterOffset, [{ bits:64 }], null);
  }

  const returnStackSlots = context?.returnStackSlots;
  const returnShapeKnown = safeInteger(returnStackSlots);
  const processed = new Set();
  while (queue.length) {
    const offset = queue.shift();
    const stateKey = `${offset}:${JSON.stringify(states.get(offset))}`;
    if (processed.has(stateKey)) continue;
    processed.add(stateKey);
    const index = offsets.get(offset);
    const bundle = bundles[index];
    if (!bundle) continue;
    let stack = cloneStack(states.get(offset) || []);
    const consumed = Array.isArray(bundle.consumedValues) ? bundle.consumedValues : [];
    const produced = Array.isArray(bundle.producedValues) ? bundle.producedValues : [];

    if (stack.length < consumed.length) {
      errors.push({ code:'cil-stack-underflow', operationId:bundle.operationId ?? null, bytecodeOffset:offset,
        stackHeight:stack.length, required:consumed.length });
      continue;
    }
    for (const requirement of consumed) {
      const actual = stack.pop();
      const expectedBits = safeInteger(requirement?.bits) && requirement.bits > 0 ? requirement.bits : null;
      if (expectedBits != null && actual?.bits != null && actual.bits !== expectedBits) {
        errors.push({ code:'cil-stack-type-mismatch', operationId:bundle.operationId ?? null, bytecodeOffset:offset,
          expectedBits, actualBits:actual.bits });
      }
    }
    for (const value of produced) stack.push(stackValue(value));
    if (maxStackKnown && stack.length > maxStack) {
      errors.push({ code:'cil-max-stack-exceeded', operationId:bundle.operationId ?? null, bytecodeOffset:offset,
        stackHeight:stack.length, maxStack });
    }

    if ((bundle.callEffects || []).length > 0) {
      warnings.push({ code:'cil-call-stack-effect-unresolved', operationId:bundle.operationId ?? null, bytecodeOffset:offset });
      continue;
    }

    const controls = Array.isArray(bundle.controlEffects) ? bundle.controlEffects : [];
    for (const effect of controls) {
      if ((effect?.kind === 'branch' || effect?.kind === 'conditional-branch') && !safeInteger(effect.targetOffset)) {
        errors.push({ code:'cil-invalid-branch-target', operationId:bundle.operationId ?? null,
          sourceOffset:offset, targetOffset:effect?.targetOffset ?? null });
      }
    }
    if (controls.some((effect) => effect?.kind === 'return')) {
      if (returnShapeKnown && stack.length !== returnStackSlots) {
        errors.push({ code:'cil-return-stack-shape-invalid', operationId:bundle.operationId ?? null,
          bytecodeOffset:offset, stackHeight:stack.length, expected:returnStackSlots });
      }
      continue;
    }
    if (controls.some((effect) => effect?.kind === 'throw')) continue;

    for (const target of branchTargets(bundle)) {
      const sourceMembership = regionMembership(regions, offset);
      const targetMembership = regionMembership(regions, target);
      if (!sameMembership(sourceMembership, targetMembership)) {
        errors.push({ code:'cil-branch-crosses-protected-region', operationId:bundle.operationId ?? null,
          sourceOffset:offset, targetOffset:target });
      }
      enqueue(target, stack, offset);
    }

    if (!hasUnconditionalBranch(bundle) && !isTerminal(bundle)) {
      const next = bundles[index + 1]?.bytecodeOffset;
      if (safeInteger(next)) enqueue(next, stack, offset);
    }
  }

  const semanticPartial = bundles.some((bundle) => bundle?.completeness === 'unknown' || bundle?.completeness === 'partial');
  const resolutionPartial = warnings.some((warning) => warning.code === 'cil-call-stack-effect-unresolved');
  const status = errors.length > 0 ? 'invalid' : semanticPartial || resolutionPartial ? 'partial' : 'valid';
  verifierFacts.push({ code:'cil-stack-dataflow-validated', reachedBlocks:states.size, maxStack: maxStackKnown ? maxStack : null });

  return createManagedValidationReport({
    targetId:methodId,
    profileId:decoded?.profileId ?? null,
    status,
    errors,
    warnings,
    verifierFacts,
    completeness:{
      structural: errors.some((error) => error.code.includes('boundary') || error.code === 'cil-invalid-branch-target') ? 'partial' : 'complete',
      specValidation: errors.length > 0 ? 'failed' : (resolutionPartial ? 'partial' : 'valid'),
      semanticEffect: semanticPartial ? 'partial' : 'complete',
      resolution: resolutionPartial ? 'partial' : 'complete',
    },
  });
}
