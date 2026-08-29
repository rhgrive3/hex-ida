import { architecturePluginV2 } from '../targets/architecture/index.js';
import { resolveABIPlugin } from '../targets/abi/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../semantics/compat/index.js';
import { decompileSemantic } from '../decompiler/semantic.js';

/**
 * Architecture-neutral function-level semantic analysis driver.
 *
 * This is the single shared route from decoded instructions to the decompiler:
 *
 *   decoded instructions
 *     -> architecture MachineEffects lifter
 *     -> Semantic IR
 *     -> CFG -> SSA -> MemorySSA -> alias/dataflow
 *     -> v1 compatibility projection
 *     -> shared decompiler
 *
 * Everything architecture-specific is reached through the ArchitecturePluginV2
 * and ABIPlugin boundaries: `liftExact`, `classifyControlFlow`,
 * `directControlTarget`, `registerFile`, `modes`. This module never inspects a
 * mnemonic, an operand-shape, a register name, or an architecture id to decide
 * behaviour, which is what makes "same middle-end" a checkable property rather
 * than a claim.
 *
 * `SEMANTIC_FUNCTION_ROUTE` is the identity of this route, not of an
 * architecture; x86-64 and RISC-V64 both travel it, and the architecture is
 * reported separately as `architectureId`.
 */
export const SEMANTIC_FUNCTION_ROUTE = 'phase5-shadow-v2';

function abortIfRequested(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('semantic-function-analysis-cancelled');
  error.name = 'AbortError';
  throw error;
}

function addressOf(instruction) { return BigInt(instruction.address); }
function endOf(instruction) { return addressOf(instruction) + BigInt(instruction.length ?? instruction.size); }
function keyOf(address) { return `block-${BigInt(address).toString(16)}`; }

function controlKind(plugin, instruction) {
  try { return String(plugin.classifyControlFlow?.(instruction) || 'fallthrough'); }
  catch { return 'unknown'; }
}

function directTarget(plugin, instruction) {
  try {
    const target = plugin.directControlTarget?.(instruction);
    return target == null ? null : BigInt(target);
  } catch { return null; }
}

function callNoreturnState(options = {}) {
  const prototype = options?.callPrototype;
  if (!prototype || typeof prototype !== 'object') return 'unknown';
  if (prototype.noreturn === true || prototype.returns === false) return true;
  if (prototype.noreturn === false || prototype.returns === true) return false;
  return 'unknown';
}

function isAuthoritativeNoreturnCall(kind, options = {}) {
  return kind === 'call' && callNoreturnState(options) === true;
}

/**
 * Convert decoder-proven instruction starts into discovery facts for the shared
 * semantic pipeline. This is architecture-front-end work: generic CFG/SSA never
 * inspect register names or mnemonics.
 */
export function partitionDecodedFunction(instructions, architecturePlugin, options = {}) {
  if (!Array.isArray(instructions) || !instructions.length) throw new TypeError('semantic-function-decoded-instructions-required');
  const ordered = instructions.slice().sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0);
  const byAddress = new Map();
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    if (byAddress.has(address.toString())) throw new TypeError('semantic-function-duplicate-instruction-address');
    byAddress.set(address.toString(), instruction);
  }

  const starts = new Set([addressOf(ordered[0]).toString()]);
  for (let index = 0; index < ordered.length; index++) {
    const instruction = ordered[index];
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    if (target != null && byAddress.has(target.toString()) && ['branch','conditional-branch'].includes(kind)) starts.add(target.toString());
    if ((['branch','conditional-branch','return','unknown'].includes(kind) || isAuthoritativeNoreturnCall(kind, options)) && ordered[index + 1]) starts.add(addressOf(ordered[index + 1]).toString());
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
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const instruction = block.instructions.at(-1).decoded;
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    const targetBlock = target == null ? null : byStart.get(target.toString());
    const fallthroughBlock = byStart.get(endOf(instruction).toString()) || blocks[index + 1] || null;
    if (kind === 'conditional-branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'conditional-true' });
      if (fallthroughBlock && (!targetBlock || fallthroughBlock.key !== targetBlock.key)) {
        block.successors.push({ to:fallthroughBlock.key, kind:'conditional-false' });
      }
    } else if (kind === 'branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'branch' });
    } else if (!['return','unknown'].includes(kind) && !isAuthoritativeNoreturnCall(kind, options) && fallthroughBlock) {
      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });
    }
  }
  return blocks;
}

export function semanticAbiAdapter(abiPlugin, options = {}) {
  const plugin = abiPlugin && typeof abiPlugin === 'object' ? abiPlugin : null;
  const pluginId = String(plugin?.id || 'unknown');
  const semanticVersion = plugin?.semanticVersion == null ? null : String(plugin.semanticVersion);
  const semanticIdentity = plugin?.semanticIdentity == null ? null : String(plugin.semanticIdentity);
  const architectureId = plugin?.architectureId == null ? null : String(plugin.architectureId);
  const targetArchitecture = options?.architectureId || options?.architecture || architectureId;
  const platformId = options?.platformId || options?.platform || null;
  const supported = !!plugin && plugin.supported !== false && pluginId !== 'unknown'
    && !!semanticVersion && !!semanticIdentity && !!architectureId;
  const identity = Object.freeze({
    id:pluginId,
    semanticVersion,
    semanticIdentity,
    architectureId,
    targetArchitecture:targetArchitecture == null ? null : String(targetArchitecture),
    platform:platformId == null ? null : String(platformId),
    architectureProfile:options?.architectureProfile ?? null,
  });
  const provenance = Object.freeze({
    source:'canonical-abi-registry',
    abiId:pluginId,
    semanticIdentity,
    semanticVersion,
    architectureId,
  });
  const invalidation = Object.freeze({
    abiSemanticIdentity:semanticIdentity,
    abiSemanticVersion:semanticVersion,
    architectureId,
    targetArchitecture:identity.targetArchitecture,
    architectureProfile:identity.architectureProfile,
    binaryId:options?.binaryId ?? null,
    sliceId:options?.sliceId ?? null,
    functionId:options?.functionId ?? null,
    semanticFunctionRoute:SEMANTIC_FUNCTION_ROUTE,
  });
  const stackRules = (() => { try { return plugin?.stackRules?.() ?? {}; } catch { return {}; } })();
  const unwindRules = (() => { try { return plugin?.unwindRules?.() ?? {}; } catch { return {}; } })();

  function classifyCanonicalArguments({ functionPrototype = null, call = null } = {}) {
    if (!plugin?.classifyArguments) return null;
    const prototype = functionPrototype ?? call?.callPrototype ?? options?.callPrototype ?? null;
    const instruction = {
      callTarget:call?.target ?? call?.callTarget ?? null,
      callPrototype:prototype,
    };
    const classifyOptions = { ...options, callPrototype:prototype };
    try { return plugin.classifyArguments(instruction, classifyOptions) || null; }
    catch { return null; }
  }

  function classifyCanonicalFunctionReturn({ functionPrototype = null, ...returnOptions } = {}) {
    if (!plugin?.classifyFunctionReturn) return null;
    const prototype = functionPrototype ?? options?.functionPrototype ?? null;
    try {
      return plugin.classifyFunctionReturn({
        functionPrototype:prototype,
        prototype,
        ...returnOptions,
      }) || null;
    } catch { return null; }
  }

  function canonicalReturnLocations(classified) {
    if (!classified || classified.partial === true || classified.unsupported === true) return [];
    const pieces = Array.isArray(classified.pieces) && classified.pieces.length
      ? classified.pieces
      : Array.isArray(classified.parts) && classified.parts.length
        ? classified.parts
        : null;
    const rawRegisters = pieces
      ? pieces.map((piece) => piece?.reg).filter((reg) => typeof reg === 'string' && reg.length > 0)
      : Array.isArray(classified.regs) && classified.regs.length
        ? classified.regs
        : typeof classified.reg === 'string' && classified.reg.length > 0 ? [classified.reg] : [];
    const locations = rawRegisters.map((rawReg, index) => {
      const piece = pieces?.[index] ?? null;
      return {
        kind:'register',
        reg:String(rawReg),
        abiClass:piece?.abiClass ?? classified.abiClass ?? null,
        pieceIndex:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        bits:piece?.bits ?? classified.bits ?? null,
        byteOffset:piece?.byteOffset ?? null,
        stackOffset:piece?.stackOffset ?? null,
        order:index,
        aggregate:classified.aggregate === true || rawRegisters.length > 1,
      };
    });
    if (locations.length || classified.indirect !== true) return locations;
    const hidden = typeof classified.hiddenResultPointer === 'string'
      ? classified.hiddenResultPointer
      : classified.hiddenResultPointer?.input;
    return hidden ? [{ kind:'indirect', reg:String(hidden), role:'result-address', aggregate:true }] : [];
  }

  return Object.freeze({
    id:pluginId,
    semanticVersion,
    semanticIdentity,
    architectureId,
    targetArchitecture:identity.targetArchitecture,
    platformId:identity.platform,
    architectureProfile:identity.architectureProfile,
    supported,
    identity,
    provenance,
    invalidation,
    completeness:supported ? 'canonical' : 'unsupported',
    stackRules:() => stackRules,
    unwindRules:() => unwindRules,
    /**
     * Canonical ABI classification entry points.  These deliberately return
     * the registry classifier's evidence object unchanged: the adapter carries
     * identity/provenance around the one ABI truth, but never reimplements
     * placement or aggregate classification.
     */
    classifyArguments:classifyCanonicalArguments,
    classifyFunctionReturn:classifyCanonicalFunctionReturn,
    classifyEntryRegister(reg) {
      try { return plugin?.classifyEntryRegister?.(reg) || null; }
      catch { return null; }
    },
    /**
     * Physical register that carries a returned value of `returnType`, or null
     * when the ABI does not designate one. Generic decompiler code must ask for
     * this rather than assume a register name: AArch64's result register `x0`
     * is RISC-V's hardwired *zero* register, so a hardcoded name is not merely
     * imprecise, it reads the wrong location.
     */
    returnRegister({ returnType = null } = {}) {
      const type = String(returnType ?? '').trim();
      if (!type || type.toLowerCase() === 'void') return null;
      let classified = null;
      try {
        classified = plugin?.classifyFunctionReturn?.({
          functionPrototype:{ returnType:type, returnsValue:true },
          returnType:type,
          returnsValue:true,
        });
      } catch { classified = null; }
      return classified?.reg ?? null;
    },
    /**
     * Ordered physical registers that carry incoming integer arguments. Generic
     * type recovery must ask the ABI for these: assuming `x0..x7` is an AAPCS64
     * fact, and on RISC-V those ids are the zero register, the return address,
     * the stack pointer, and the temporaries, so the assumption does not just
     * lose arguments, it reports the stack pointer as one.
     */
    argumentLocations({ functionPrototype = null } = {}) {
      const classified = classifyCanonicalArguments({ functionPrototype });
      const locations = [];
      const seen = new Set();
      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        const registers = Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [];
        for (const register of registers) {
          const reg = String(register || '');
          if (!reg) continue;
          const key = String(entry.index ?? locations.length) + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index:Number.isInteger(Number(entry.index)) ? Number(entry.index) : locations.length,
            reg,
            abiClass:entry.abiClass ?? null,
            aggregate:entry.aggregate === true || Array.isArray(entry.pieces) || registers.length > 1,
            pieceIndex:Array.isArray(entry.pieces)
              ? (entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg) >= 0
                ? entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg)
                : null)
              : null,
            pieces:Array.isArray(entry.pieces) ? entry.pieces : null,
          }));
        }
      }
      return Object.freeze(locations);
    },
    argumentRegisters(options = {}) {
      return Object.freeze(this.argumentLocations(options).map((location) => location.reg));
    },
    /**
     * Registers whose spill/restore is pure call-frame bookkeeping rather than
     * program data: the frame pointer and the return address.
     */
    frameBookkeepingRegisters() {
      const named = [
        unwindRules.framePointer, stackRules.framePointer,
        unwindRules.returnAddressRegister, stackRules.returnAddressRegister,
        unwindRules.linkRegister, stackRules.linkRegister,
      ].filter((value) => typeof value === 'string' && value.length > 0);
      return Object.freeze([...new Set(named)]);
    },
      classifyCall({ call }) {
      const classified = classifyCanonicalArguments({ call });
      const instruction = {
        callTarget:call?.target ?? null,
        callPrototype:options.callPrototype ?? call?.callPrototype ?? null,
      };
      let returned = null;
      try { returned = plugin?.classifyCallReturn?.(instruction, { ...options, callPrototype:instruction.callPrototype }) ?? null; }
      catch { returned = null; }
      const returnLocations = canonicalReturnLocations(returned);
      const explicitArguments = Array.isArray(classified?.arguments) ? classified.arguments : null;
      const implicitInputs = Array.isArray(classified?.implicitInputs)
        ? classified.implicitInputs.map((input, index) => Object.freeze({
          ...input,
          index:`implicit:${index}`,
          location:input.location ?? 'register',
          abiClass:input.abiClass ?? 'abi-implicit-input',
          implicit:true,
          variadicVectorRegisterCount:classified?.variadicVectorRegisterCount ?? null,
          countKnown:Number.isSafeInteger(classified?.variadicVectorRegisterCount),
        }))
        : [];
      return {
        arguments:explicitArguments == null ? (implicitInputs.length ? implicitInputs : null) : [...explicitArguments, ...implicitInputs],
        explicitArguments,
        implicitInputs,
        variadicVectorRegisterCount:classified?.variadicVectorRegisterCount ?? null,
        partial:classified?.partial === true || classified == null,
        completeness:classified == null || classified?.unsupported === true ? 'unknown' : classified.partial === true ? 'partial' : 'complete',
        stackArguments:classified?.stackArguments ?? null,
        stackArgsUnknown:classified?.stackArgsUnknown ?? true,
        stackArgsMayContainPointers:classified?.stackArgsMayContainPointers ?? true,
        argumentEvidence:classified?.evidence ?? `abi-${pluginId}`,
        clobbers:(() => { try { return plugin?.callerSaved?.(options) ?? []; } catch { return []; } })(),
        returnReg:returned?.reg ?? null,
        returnBits:returned?.bits ?? null,
        returnEvidence:returned == null ? null : `abi-${pluginId}-return`,
        returnLocations,
        returnPieces:Array.isArray(returned?.pieces) ? returned.pieces : Array.isArray(returned?.parts) ? returned.parts : null,
        returnAggregate:returned?.aggregate === true,
        returnIndirect:returned?.indirect === true,
        returnHiddenResultPointer:returned?.hiddenResultPointer ?? null,
        noreturn:callNoreturnState(options),
        abiId:pluginId,
        abiSemanticVersion:semanticVersion,
        abiSemanticIdentity:semanticIdentity,
        abiIdentity:identity,
        provenance,
        invalidation,
      };
    },
  });
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

function decompilerSnapshot(result) {
  return {
    semantic:result.semantic === true,
    signature:result.signature,
    summary:result.summary,
    pseudocode:result.pseudocode,
    lines:result.lines,
    evidence:result.evidence,
    warnings:result.warnings,
    labels:[...(result.labels || [])],
    coverage:result.coverage,
    unknownInstructions:result.ctx?.unknownInstructions ?? 0,
  };
}

function addressWidthBitsFor(architecturePlugin) {
  let descriptors = [];
  try { descriptors = architecturePlugin.registerFile() || []; } catch { descriptors = []; }
  const stack = descriptors.find((descriptor) => String(descriptor?.kind ?? '') === 'stack-pointer');
  const bits = Number(stack?.bits ?? 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : 64;
}

function assertRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`semantic-function-${label}-required`);
  }
  return value.trim();
}

export function analyzeDecodedSemanticFunction(input = {}, options = {}) {
  abortIfRequested(options.signal);
  if (!input || typeof input !== 'object') throw new TypeError('semantic-function-input-object-required');
  if (!Array.isArray(input.instructions)) throw new TypeError('semantic-function-decoded-instructions-required');
  const architectureId = String(input.architecture || '').trim().toLowerCase();
  const architecturePlugin = architecturePluginV2(architectureId);
  if (!architecturePlugin) throw new TypeError(`semantic-function-unsupported-architecture:${architectureId}`);
  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null && requestedInstructionEndianness !== 'unknown') {
    const endian = String(requestedInstructionEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedInstructionEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null && requestedMemoryEndianness !== 'unknown') {
    const endian = String(requestedMemoryEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedMemoryEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
  }
  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });
  if (!abiPlugin?.supported) throw new TypeError('semantic-function-supported-abi-required');
  if (abiPlugin.architectureId !== architectureId) throw new TypeError('semantic-function-abi-architecture-mismatch');
  const decoderSemanticVersion = assertRequiredString(input.decoderSemanticVersion, 'decoder-semantic-version');
  const binaryId = assertRequiredString(input.binaryId, 'binary-id');
  const sliceId = assertRequiredString(input.sliceId, 'slice-id');
  const blocks = partitionDecodedFunction(input.instructions, architecturePlugin, { callPrototype:input.callPrototype ?? null });
  const abiAdapter = semanticAbiAdapter(abiPlugin, input);
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
    abiAdapter,
    machineEffectsContext:input.machineEffectsContext ?? {
      dataEndianness:input.dataEndianness,
      instructionEndianness:input.instructionEndianness,
    },
  }, { signal:options.signal, abiAdapter });
  abortIfRequested(options.signal);
  const decodedByInstructionId = new Map(pipeline.machineEffects.map((bundle, index) => [bundle.instructionId, input.instructions[index]]));
  const legacyRows = new Map();
  for (const legacy of pipeline.legacyV1.instructions) {
    const candidates = (legacy.origin?.instructionIds || []).map((id) => decodedByInstructionId.get(id)).filter(Boolean);
    const decoded = candidates.sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0)[0] ?? input.instructions[0];
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
    name:String(input.name || `sub_${addressOf(input.instructions[0]).toString(16)}`),
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => legacyRows.get(row) ?? {
      row, address:addressOf(input.instructions[0]), size:0, mn:'', ops:'',
    }),
    switches:[],
  };
  const decompiler = decompileSemantic(model, {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addr:addressOf(input.instructions[0]),
    name:model.name,
    functionPrototype:input.functionPrototype ?? null,
  });
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
      dataEndianness:input.dataEndianness ?? null,
      instructionEndianness:input.instructionEndianness ?? null,
      architectureProfile:input.architectureProfile ?? null,
    }),
    pipeline:pipelineSnapshot(pipeline),
    decompiler:decompilerSnapshot(decompiler),
  });
}
