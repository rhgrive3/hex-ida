export * from './semantic-function-base.js';

import { architecturePluginV2 } from '../targets/architecture/index.js';
import { resolveABIPlugin } from '../targets/abi/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../semantics/compat/index.js';
import { decompileSemantic } from '../decompiler/semantic.js';
import { enhanceSemanticDecompilation } from '../decompiler/pipeline.js';
import {
  SEMANTIC_FUNCTION_ROUTE,
  canonicalDecodedInstructions,
  createSemanticCallPrototypeAuthority,
  decompilerSnapshot,
  decompileSemanticProjection,
  isSemanticCallPrototypeAuthority,
  normalizeSemanticEndianness,
  semanticMachineEffectsContext,
  semanticAbiAdapter,
  semanticControlUnknowns,
} from './semantic-function-base.js';

function abortIfRequested(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('semantic-function-analysis-cancelled');
  error.name = 'AbortError';
  throw error;
}

// Shared strict geometry contract with semantic-function-base.js: structured
// instruction address/length must not launder into CFG authority via BigInt().
function canonicalInstructionAddress(value, code) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed >= 0n) return parsed;
  }
  throw new TypeError(code);
}

function addressOf(instruction) {
  return canonicalInstructionAddress(instruction.address, 'semantic-function-instruction-address-invalid');
}
function instructionLengthOf(instruction) {
  const length = canonicalInstructionAddress(
    instruction.length ?? instruction.size,
    'semantic-function-instruction-length-invalid',
  );
  if (length === 0n) throw new TypeError('semantic-function-instruction-length-invalid');
  return length;
}
function endOf(instruction) {
  return addressOf(instruction) + instructionLengthOf(instruction);
}
function keyOf(address) { return `block-${BigInt(address).toString(16)}`; }

const CONTROL_FLOW_KINDS = new Set([
  'fallthrough',
  'call',
  'branch',
  'conditional-branch',
  'return',
  'unknown',
]);

function controlKind(plugin, instruction) {
  try {
    const kind = plugin.classifyControlFlow?.(instruction);
    if (kind == null || kind === '') return 'fallthrough';
    return typeof kind === 'string' && CONTROL_FLOW_KINDS.has(kind) ? kind : 'unknown';
  } catch { return 'unknown'; }
}

function directTarget(plugin, instruction) {
  try {
    const target = plugin.directControlTarget?.(instruction);
    if (target == null) return null;
    if (typeof target === 'string' && target !== target.trim()) return null;
    return canonicalInstructionAddress(target, 'semantic-function-direct-control-target-invalid');
  } catch { return null; }
}

function prototypeNoreturnState(prototype) {
  if (!prototype || typeof prototype !== 'object') return 'unknown';
  if (prototype.noreturn === true || prototype.returns === false) return true;
  if (prototype.noreturn === false || prototype.returns === true) return false;
  return 'unknown';
}

function callPrototypeAuthorityFor(instructions, architecturePlugin, options = {}) {
  if (isSemanticCallPrototypeAuthority(options?.callPrototypeAuthority)) return options.callPrototypeAuthority;
  const callsites = [];
  for (const instruction of instructions) {
    if (controlKind(architecturePlugin, instruction) !== 'call') continue;
    callsites.push({
      instruction,
      address:addressOf(instruction),
      target:directTarget(architecturePlugin, instruction),
    });
  }
  return createSemanticCallPrototypeAuthority(callsites, options);
}

export function partitionDecodedFunction(instructions, architecturePlugin, options = {}) {
  const { instructions: ordered, byAddress } = canonicalDecodedInstructions(instructions);

  const callPrototypeAuthority = callPrototypeAuthorityFor(ordered, architecturePlugin, options);
  const controlByAddress = new Map();
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    const callPrototype = kind === 'call' ? callPrototypeAuthority.prototypeForInstruction(instruction) : null;
    controlByAddress.set(address.toString(), {
      kind,
      target,
      callPrototype,
      noreturn: kind === 'call' && prototypeNoreturnState(callPrototype) === true,
    });
  }

  const starts = new Set([addressOf(ordered[0]).toString()]);
  for (let index = 0; index < ordered.length; index++) {
    const instruction = ordered[index];
    const control = controlByAddress.get(addressOf(instruction).toString());
    const { kind, target } = control;
    if (target != null && byAddress.has(target.toString()) && ['branch','conditional-branch'].includes(kind)) starts.add(target.toString());
    if (ordered[index + 1] && addressOf(ordered[index + 1]) !== endOf(instruction)) {
      starts.add(addressOf(ordered[index + 1]).toString());
    }
    if ((['branch','conditional-branch','return','unknown'].includes(kind) || control.noreturn) && ordered[index + 1]) {
      starts.add(addressOf(ordered[index + 1]).toString());
    }
  }

  const blocks = [];
  let current = null;
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    if (!current || starts.has(address.toString())) {
      current = { key:keyOf(address), startAddress:address, instructions:[], successors:[] };
      blocks.push(current);
    }
    current.instructions.push({ decoded:instruction });
  }

  const byStart = new Map(blocks.map((block) => [block.startAddress.toString(), block]));
  for (const block of blocks) {
    const instruction = block.instructions.at(-1).decoded;
    const control = controlByAddress.get(addressOf(instruction).toString());
    const { kind, target } = control;
    const targetBlock = target == null ? null : byStart.get(target.toString());
    const fallthroughBlock = byStart.get(endOf(instruction).toString()) || null;
    if (kind === 'conditional-branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'conditional-true' });
      if (fallthroughBlock && fallthroughBlock.key !== targetBlock?.key) {
        block.successors.push({ to:fallthroughBlock.key, kind:'conditional-false' });
      }
    } else if (kind === 'branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'branch' });
    } else if (!['return','unknown'].includes(kind) && !control.noreturn && fallthroughBlock) {
      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });
    }
  }
  return blocks;
}

function legacyProjectionSnapshot(legacy) {
  return {
    name:legacy.name,
    functionId:legacy.functionId,
    startAddress:legacy.startAddress,
    truncated:legacy.truncated === true,
    entry:legacy.entry,
    instructions:(legacy.instructions || []).map((instruction) => ({
      id:instruction.id,
      op:instruction.op,
      sub:instruction.sub ?? null,
      row:instruction.row,
      address:instruction.address ?? null,
      block:instruction.block,
      args:(instruction.args || []).map((arg) => ({
        valueId:arg?.value?.semanticSsaValueId ?? arg?.value?.semanticValueId ?? arg?.value?.id ?? null,
        bits:arg?.bits ?? arg?.value?.bits ?? null,
      })),
      semanticNodeId:instruction.semanticNodeId ?? null,
      sourceInstructionIds:instruction.sourceInstructionIds ?? [],
      origin:instruction.origin ?? null,
    })),
    blocks:(legacy.blocks || []).map((block) => ({
      index:block.index,
      semanticBlockId:block.semanticBlockId,
      startRow:block.startRow,
      endRow:block.endRow,
      succ:block.succ ?? [],
      successorEdges:block.successorEdges ?? [],
      pred:block.pred ?? [],
      isEntry:block.isEntry === true,
      isExit:block.isExit === true,
      origin:block.origin ?? null,
    })),
    origin:legacy.origin,
    compat:{
      projection:legacy.compat?.projection,
      version:legacy.compat?.version,
      semanticFunctionId:legacy.compat?.semanticFunctionId,
      scalarSsa:legacy.compat?.scalarSsa === true,
      memorySsa:legacy.compat?.memorySsa === true,
      origins:legacy.compat?.origins ?? {},
    },
  };
}

function pipelineSnapshot(pipeline) {
  return {
    mode:pipeline.mode,
    pipelineVersion:pipeline.pipelineVersion,
    path:pipeline.path,
    semanticSchemaVersion:pipeline.semanticSchemaVersion,
    architectureId:pipeline.architectureId,
    architectureSemanticVersion:pipeline.architectureSemanticVersion,
    decoderSemanticVersion:pipeline.decoderSemanticVersion,
    scalarSsaPassVersion:pipeline.scalarSsaPassVersion,
    memorySsaPassVersion:pipeline.memorySsaPassVersion,
    binaryId:pipeline.binaryId,
    sliceId:pipeline.sliceId,
    functionId:pipeline.functionId,
    machineEffects:pipeline.machineEffects,
    semanticIr:pipeline.semanticIr,
    cfg:pipeline.cfg,
    ssa:pipeline.ssa,
    regions:pipeline.regions,
    memorySsa:pipeline.memorySsa,
    legacyV1:legacyProjectionSnapshot(pipeline.legacyV1),
    instrumentation:pipeline.instrumentation,
  };
}

function addressWidthBitsFor(architecturePlugin) {
  let descriptors = [];
  try { descriptors = architecturePlugin.registerFile() || []; } catch { descriptors = []; }
  const stack = descriptors.find((descriptor) => String(descriptor?.kind ?? '') === 'stack-pointer');
  const bits = Number(stack?.bits ?? 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : 64;
}

export function assertRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`semantic-function-${label}-required`);
  }
  return value.trim();
}

function normalizedProtocolSelector(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim().toLowerCase();
  if (!text) throw new TypeError(code);
  return text;
}

export function analyzeSemanticFunction(input = {}, options = {}) {
  abortIfRequested(options.signal);
  const architectureId = normalizedProtocolSelector(input.architecture, 'semantic-function-architecture-required');
  const architecturePlugin = architecturePluginV2(architectureId);
  if (!architecturePlugin || architecturePlugin.id !== architectureId) throw new TypeError('semantic-function-architecture-not-registered');
  if (typeof architecturePlugin.liftExact !== 'function') throw new TypeError('semantic-function-architecture-lifter-required');
  const endianness = normalizeSemanticEndianness(input, architecturePlugin);
  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });
  if (!abiPlugin?.supported) throw new TypeError('semantic-function-supported-abi-required');
  if (abiPlugin.architectureId !== architectureId) throw new TypeError('semantic-function-abi-architecture-mismatch');
  const decoderSemanticVersion = assertRequiredString(input.decoderSemanticVersion, 'decoder-semantic-version');
  const binaryId = assertRequiredString(input.binaryId, 'binary-id');
  const sliceId = assertRequiredString(input.sliceId, 'slice-id');
  const orderedInstructions = canonicalDecodedInstructions(input.instructions).instructions;
  const callPrototypeAuthority = callPrototypeAuthorityFor(orderedInstructions, architecturePlugin, {
    callPrototype:input.callPrototype ?? null,
    callPrototypeFor:input.callPrototypeFor,
  });
  const cfgOptions = { callPrototypeAuthority };
  const blocks = partitionDecodedFunction(orderedInstructions, architecturePlugin, cfgOptions);
  const controlUnknowns = semanticControlUnknowns(blocks, architecturePlugin, cfgOptions);
  const abiAdapter = semanticAbiAdapter(abiPlugin, input, { callPrototypeAuthority });
  let defaultMode = null;
  try { defaultMode = architecturePlugin.modes()?.[0] ?? null; } catch { defaultMode = null; }
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addressWidthBits:addressWidthBitsFor(architecturePlugin),
    mode:input.mode ?? defaultMode ?? 'default',
    entryBlockKey:blocks[0].key,
    blocks,
    completeness: controlUnknowns.length ? 'partial' : 'complete',
    unknowns: controlUnknowns,
    functionPrototype:input.functionPrototype ?? null,
    abiAdapter,
    machineEffectsContext:semanticMachineEffectsContext(input, endianness),
  }, { signal:options.signal, abiAdapter,
    ...(options.canonicalProjectionOnly === true
      ? { snapshotId: assertRequiredString(input.snapshotId, 'snapshot-id') } : {}),
  });
  abortIfRequested(options.signal);
  // Opt-in first-party query transport: canonical owners have finished, but a
  // focused SSA/MSSA query does not need pseudocode or a presentation model.
  // The ordinary decompiler path below remains unchanged. No second lifter,
  // CFG, SSA, or MemorySSA is introduced by this projection-only return.
  if (options.canonicalProjectionOnly === true) {
    if (architectureId !== 'arm64') throw new TypeError('scoped-canonical-arm64-required');
    // Only an in-process first-party consumer can borrow the actual owner.
    // No message-supplied callback or serialized IR becomes an owner context.
    if (options.captureCanonicalOwner != null) {
      if (typeof options.captureCanonicalOwner !== 'function') throw new TypeError('scoped-owner-capture-callback');
      // The pipeline establishes the canonical function identity. Rebind the
      // SAME registered classifier through its existing adapter now that this
      // identity is known; do not patch serialized ABI result envelopes.
      const scopedAbiAdapter = semanticAbiAdapter(abiPlugin, { ...input, functionId: pipeline.functionId }, { callPrototypeAuthority });
      const owner = Object.freeze({ pipeline, abiAdapter: scopedAbiAdapter, decodedInstructions: input.instructions, snapshotId: input.snapshotId });
      SCOPED_DECOMPILER_OWNERS.set(owner, { input, orderedInstructions });
      options.captureCanonicalOwner(owner);
      abortIfRequested(options.signal);
    }
    return Object.freeze({
      route: SEMANTIC_FUNCTION_ROUTE,
      version: String(input.analysisVersion ?? options.analysisVersion ?? '1'),
      architectureId,
      architectureSemanticVersion: architecturePlugin.semanticVersion,
      abiId: abiPlugin.id,
      abiSemanticVersion: abiPlugin.semanticVersion,
      decoderSemanticVersion,
      analysisContext: Object.freeze({
        dataEndianness: endianness.dataEndianness,
        instructionEndianness: endianness.instructionEndianness,
        architectureProfile: input.architectureProfile ?? null,
      }),
      pipeline: pipelineSnapshot(pipeline),
      decompiler: null,
      projection: 'canonical-only',
    });
  }
  const decompiler = decompileCanonicalPipeline(pipeline, orderedInstructions, input, abiAdapter);
  if (!decompiler) throw new Error('semantic-function-shared-decompiler-produced-no-result');
  return Object.freeze({
    route:SEMANTIC_FUNCTION_ROUTE,
    version:String(input.analysisVersion ?? options.analysisVersion ?? '1'),
    architectureId,
    architectureSemanticVersion:architecturePlugin.semanticVersion,
    abiId:abiPlugin.id,
    abiSemanticVersion:abiPlugin.semanticVersion,
    decoderSemanticVersion,
    analysisContext:Object.freeze({
      dataEndianness:endianness.dataEndianness,
      instructionEndianness:endianness.instructionEndianness,
      architectureProfile:input.architectureProfile ?? null,
    }),
    pipeline:pipelineSnapshot(pipeline),
    decompiler:decompilerSnapshot(decompiler),
  });
}

// Owners are in-process capabilities, never deserialized protocol data.
const SCOPED_DECOMPILER_OWNERS = new WeakMap();
export function assertScopedCanonicalOwner(owner) {
  if (!SCOPED_DECOMPILER_OWNERS.has(owner)) throw new TypeError('scoped-canonical-issued-owner-required');
  return owner;
}
function decompileCanonicalPipeline(pipeline, orderedInstructions, input, abiAdapter, projectionOptions = {}) {
  const { decoderSemanticVersion, binaryId, sliceId } = input;
  const decodedByInstructionId = new Map(pipeline.machineEffects.map((bundle, index) => [bundle.instructionId, orderedInstructions[index]]));
  const legacyRows = new Map();
  for (const legacy of pipeline.legacyV1.instructions) {
    const candidates = (legacy.origin?.instructionIds || []).map((id) => decodedByInstructionId.get(id)).filter(Boolean);
    const decoded = candidates.sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0)[0] ?? orderedInstructions[0];
    if (!legacyRows.has(legacy.row)) legacyRows.set(legacy.row, {
      row:legacy.row,
      address:legacy.address == null ? addressOf(decoded) : BigInt(legacy.address),
      size:Number(decoded.length ?? decoded.size),
      mn:String(decoded.mnemonic || decoded.instructionFamily || ''),
      ops:String(decoded.opStr || ''),
    });
  }
  const maximumRow = Math.max(...legacyRows.keys());
  for (const block of pipeline.legacyV1.blocks) {
    const proven = (block.insts || []).map((instruction) => instruction.address).filter((address) => address != null).map(BigInt)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0];
    if (proven == null) continue;
    const prior = legacyRows.get(block.startRow);
    legacyRows.set(block.startRow, { ...(prior || { row:block.startRow, size:0, mn:'', ops:'' }), address:proven });
  }
  const model = {
    name:String(input.name || `sub_${addressOf(orderedInstructions[0]).toString(16)}`),
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => legacyRows.get(row) ?? {
      row, address:addressOf(orderedInstructions[0]), size:0, mn:'', ops:'',
    }),
    switches:[],
  };
  const decompiler = projectionOptions.scopedTransformEvidence === true
    ? decompileSemantic(model, {
      ir:pipeline.legacyV1,
      abiAdapter,
      decoderSemanticVersion,
      binaryId,
      sliceId,
      addr:addressOf(orderedInstructions[0]),
      name:model.name,
      functionPrototype:input.functionPrototype ?? null,
      ...projectionOptions,
    })
    : decompileSemanticProjection(model, {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addr:addressOf(orderedInstructions[0]),
    name:model.name,
    functionPrototype:input.functionPrototype ?? null,
    ...projectionOptions,
    renderProvenance:true,
  });
  if (!decompiler) throw new Error('semantic-function-shared-decompiler-produced-no-result');
  return projectionOptions.scopedTransformEvidence === true
    ? enhanceSemanticDecompilation(decompiler, model, { ...projectionOptions, ir: pipeline.legacyV1, abiAdapter,
      decoderSemanticVersion, binaryId, sliceId, addr: addressOf(orderedInstructions[0]), name: model.name })
    : decompiler;
}
/** Runs the SAME presentation pipeline over an issued canonical owner. No
 * relift, reconstructed SSA/MSSA, or user-supplied ownership flag is accepted.
 * Only the bounded transform-projection consumer uses this opt-in path.
 */
export function decompileScopedCanonicalOwner(owner, projectionOptions = {}) {
  const context = SCOPED_DECOMPILER_OWNERS.get(owner);
  if (!context) throw new TypeError('scoped-decompiler-issued-owner-required');
  return decompileCanonicalPipeline(owner.pipeline, context.orderedInstructions, context.input, owner.abiAdapter, projectionOptions);
}
