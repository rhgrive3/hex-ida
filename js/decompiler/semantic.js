export * from './semantic-core.js';

import { irFor, getSemanticMigrationMode, OP } from '../ir.js';
import { exactViewTrace, projectSemanticViews } from './semantic-views.js';
import {
  decompileSemantic as decompileSemanticCore,
  recoverInductionVariables as recoverInductionVariablesCore,
} from './semantic-core.js';

function irOptionsFromDecompilerOptions(opts = {}) {
  return {
    rowOfAddress: opts.rowOfAddress,
    returnType: opts.returnType,
    functionPrototype: opts.functionPrototype,
    prototype: opts.prototype,
    returnClass: opts.returnClass,
    returnBits: opts.returnBits,
    returnsValue: opts.returnsValue,
    decoderSemanticVersion: opts.decoderSemanticVersion,
    binaryId: opts.binaryId,
    sliceId: opts.sliceId,
    abiAdapter: opts.abiAdapter,
    rootDescriptorProvider: opts.rootDescriptorProvider,
    regionOptions: opts.regionOptions,
    semanticIrOptions: opts.semanticIrOptions,
    ssaOptions: opts.ssaOptions,
    memorySsaOptions: opts.memorySsaOptions,
    compatOptions: opts.compatOptions,
    signal: opts.signal,
  };
}

/*
 * Keep the public decompiler facade's historical runtime-model compatibility:
 * callers may supply the canonical runtime index directly, the ObjC model that
 * owns it, or the mixed Apple runtime aggregate. Normalize that evidence before
 * delegating so the split facade does not weaken issue #529 runtime wiring.
 */
function canonicalRuntimeOptions(opts = {}) {
  const objcRuntimeIndex = opts.objcRuntimeIndex || opts.objcModel || opts.appleRuntime?.objc || null;
  return objcRuntimeIndex === opts.objcRuntimeIndex ? opts : { ...opts, objcRuntimeIndex };
}


function compatBlockTerm(block) {
  const insts = block?.insts || [];
  for (let index = insts.length - 1; index >= 0; index--) {
    if ([OP.CBR, OP.BR, OP.RET].includes(insts[index].op)) return insts[index];
  }
  return null;
}

function compatInductionRoot(value) {
  return exactViewTrace(value)?.root ?? value ?? null;
}

/*
 * Semantic-v2 compatibility keeps physical-state width changes explicit, so a
 * loop-carried scalar may reach its PHI through exact MOV/trunc/zext projections.
 * Recover only that already-proven recurrence shape after the legacy detector
 * declines it; no opcode text or architecture-specific register knowledge is used.
 */
function recoverCompatInductionVariables(ir, ctx = null) {
  const out = [];
  for (const loop of ir?.loops || []) {
    const block = ir.blocks?.[loop.header];
    for (const phi of block?.phis || []) {
      if (!phi.dst || (phi.incoming || []).length !== 2) continue;
      const outside = phi.incoming.find((edge) => !loop.nodes.has(edge.from));
      const inside = phi.incoming.find((edge) => loop.nodes.has(edge.from));
      if (!outside || !inside) continue;
      const updateValue = compatInductionRoot(inside.value);
      const stepDef = updateValue?.def;
      if (!stepDef || stepDef.op !== OP.BIN || !['add', 'sub'].includes(stepDef.sub)) continue;
      const left = stepDef.args?.[0]?.value ?? null;
      const right = stepDef.args?.[1]?.value ?? null;
      const leftRoot = compatInductionRoot(left);
      const rightRoot = compatInductionRoot(right);
      let step = null;
      if (leftRoot?.id === phi.dst.id && right?.const != null) {
        step = stepDef.sub === 'add' ? right.const : -right.const;
      } else if (stepDef.sub === 'add' && rightRoot?.id === phi.dst.id && left?.const != null) {
        step = left.const;
      }
      if (step == null) continue;
      const term = compatBlockTerm(block);
      if (!term || term.op !== OP.CBR) continue;
      const name = `i${out.length || ''}`;
      out.push({
        loop,
        phi,
        value: phi.dst,
        name,
        init: outside.value,
        step,
        conditionInst: term,
        initText: null,
        conditionText: null,
        compatExactView: true,
        ...(ctx ? { contextAvailable: true } : {}),
      });
    }
  }
  return out;
}

export function recoverInductionVariables(ir, ctx = null) {
  const direct = recoverInductionVariablesCore(ir, ctx);
  if (direct.length || ir?.compat?.projection !== 'semantic-ir-v2-to-v1') return direct;
  return recoverCompatInductionVariables(ir, ctx);
}

/**
 * Preserve the historical legacy decompiler construction exactly. Full ABI /
 * prototype context and the committed-snapshot compatibility projections are
 * enabled only for the explicit semantic-v2-to-v1 route.
 */
export function decompileSemantic(model, opts = {}) {
  const semanticOpts = canonicalRuntimeOptions(opts);
  const v2Requested = getSemanticMigrationMode() === 'semantic-v2-compat';
  let ir = semanticOpts.ir || irFor(model, v2Requested
    ? irOptionsFromDecompilerOptions(semanticOpts)
    : { rowOfAddress: semanticOpts.rowOfAddress });
  const isV2Compat = ir?.compat?.projection === 'semantic-ir-v2-to-v1';
  if (isV2Compat) {
    ir = projectSemanticViews(ir, semanticOpts);
  }
  return decompileSemanticCore(model, { ...semanticOpts, ir });
}
