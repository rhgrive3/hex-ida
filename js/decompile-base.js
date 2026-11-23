/* IR-first compatibility facade. Legacy decompilation is used only when Semantic IR cannot faithfully cover a function/instruction. */
import { decompile as legacyDecompile } from './decompile-legacy.js';
import { decompileSemantic } from './decompiler/semantic.js';
import { repairCanonicalPostTestLoop } from './decompiler/loop-repair.js';
import { structureKnownSwitches } from './decompiler/switch.js';
import { normalizeProjectedCompatibilityLine } from './decompiler/phase8/projection.js';
import { enhanceSemanticDecompilation } from './decompiler/pipeline.js';
import { sourceOf, mergeSource } from './decompiler/ast/nodes.js';
import { buildRenderProvenance } from './decompiler/phase8/render-provenance.js';
import { applyDecompilerProfile } from './decompiler/profiles.js';
import { closeFunctionOutput } from './decompiler/c-output-closure.js';
import { eliminateAvoidableGotos } from './decompiler/goto-closure.js';
import { lowerArm64RawAssembly } from './decompiler/arm64-extra-semantics.js';

// Preserve every historical helper export (stackNaming, decompiledText, etc.).
// Explicit exports below intentionally override only the public decompile entry.
export * from './decompile-legacy.js';
export { decompileSemantic } from './decompiler/semantic.js';
export { structureKnownSwitches } from './decompiler/switch.js';
export { enhanceSemanticDecompilation } from './decompiler/pipeline.js';
export { renderValue as renderSemanticValue, renderMemoryLocation, renderBranchCondition, recoverInductionVariables, reachingRegisterValue } from './decompiler/semantic.js';

function textOf(lines) {
  return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
}

function asmCount(result) {
  let n = 0;
  for (const l of result?.lines || []) if ((l.kind === 'stmt' || l.kind === 'ctrl') && /__asm\(/.test(l.text || '')) n++;
  return n;
}

function normalizeCompatibility(result) {
  if (!result) return result;
  let changed = false;
  for (const l of result.lines || []) {
    const before = l?.text;
    normalizeProjectedCompatibilityLine(l, result.ir);
    if (l?.text !== before) changed = true;
  }
  if (result.semantic && (changed || !result.pseudocode)) result.pseudocode = textOf(result.lines);
  return result;
}

function augmentLegacy(fallback, reason, semantic = null) {
  fallback.warnings = [...(fallback.warnings || []), reason];
  fallback.summary = fallback.summary || semantic?.summary || 'Semantic IR が安全に表現できない領域があるため、互換Decompilerへ切り替えました。';
  fallback.pseudocode = fallback.pseudocode || textOf(fallback.lines);
  fallback.evidence = [...(semantic?.evidence || []), ...(fallback.evidence || [])];
  fallback.semantic = false;
  fallback.legacyFallback = true;
  fallback.ctx = {
    ...(fallback.ctx || {}),
    semanticIRFallback: semantic ? {
      irPrimary: true,
      unsupportedInstructions: semantic.ctx?.unknownInstructions || 0,
      coverage: semantic.coverage || null,
      warnings: semantic.warnings || [],
    } : null,
  };
  // Keep the IR available to expert callers even when textual fallback is used.
  if (semantic?.ir && !fallback.ir) fallback.ir = semantic.ir;
  return fallback;
}

function finalize(result, model, opts) {
  opts = applyDecompilerProfile(opts);
  result = structureKnownSwitches(result, model, opts);
  result = normalizeCompatibility(result);
  let deferredProvenance = false;
  let deferredSnapshotId = null;
  if (result?.semantic) {
    result = enhanceSemanticDecompilation(result, model, {
      ...opts,
      renderProvenance: true,
      deferRenderProvenance: true,
      _onDeferRenderProvenance: (snapshotId) => {
        deferredProvenance = true;
        deferredSnapshotId = snapshotId ?? null;
      },
    });
  }
  result = normalizeCompatibility(result);
  const prevLowerings = result?.ctx?.exactArm64FallbackLowerings || 0;
  result = lowerArm64RawAssembly(result, { ...opts, model });
  const loweredArm64 = (result?.ctx?.exactArm64FallbackLowerings || 0) > prevLowerings;
  const closed = closePublicCOutput(result, opts, {
    forceRefreshProvenance: loweredArm64 || deferredProvenance,
    deferredProvenance,
    deferredSnapshotId,
    model,
  });
  if (!closed?.semantic && closed?.switchRenderHistory) {
    // No semantic-mode promotion or invented analysis snapshot for fallback
    // output. Missing snapshot identity remains explicit in the shared map.
    try { closed.renderProvenance = buildRenderProvenance({ result: closed, budget: opts.renderProvenanceBudget, shouldAbort: opts.shouldAbort }); }
    catch {
      closed.renderProvenance = null;
      closed.expressionHistoryBinding = Object.freeze({ scope:'producer-consumer-observations',
        completeness:'incomplete', reasons:Object.freeze(['switch-map-unavailable']) });
    }
  }
  return closed;
}

/*
 * The public text is the artifact a caller copies, so the last step of every
 * path removes the jumps that structured execution of the text itself proves
 * redundant (js/decompiler/goto-closure.js), then declares the storage it uses
 * and defines the fixed-width spelling it uses
 * (js/decompiler/c-output-closure.js).  Everything textual — the semantic
 * emitter, the legacy fallback, switch/loop repair and the ARM64 raw lowering —
 * has already run at this point.  When the result carries an index-keyed render
 * provenance map, that map is refreshed over the final line array so entity
 * keys stay aligned with the published lines instead of a shifted pre-closure
 * index space.
 */
function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function refreshRenderProvenance(closed, opts, internal = {}) {
  const previous = closed.renderProvenance ?? null;
  if (!previous && !internal.deferredProvenance) return;
  const snapshotId = internal.deferredProvenance
    ? (internal.deferredSnapshotId ?? previous?.snapshotId ?? null)
    : (previous?.snapshotId ?? null);
  try {
    closed.renderProvenance = buildRenderProvenance({
      result: closed,
      snapshotId,
      budget: opts.renderProvenanceBudget,
      shouldAbort: opts.shouldAbort,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Keep the previous observation rather than publishing a silently
    // unbound map for the changed line array.
    closed.renderProvenance = previous ?? null;
  }
}

function closePublicCOutput(result, opts = {}, internal = {}) {
  if (!result?.lines?.length) {
    if (result && internal.deferredProvenance) refreshRenderProvenance(result, opts, internal);
    return result;
  }
  // Provably redundant jumps go first: the declaration closure below must
  // declare storage for the text that will actually be published, and a jump
  // that is gone cannot leave an address nobody reads behind.  Either closure
  // can change the line array, so the index-keyed provenance map is refreshed
  // once, over the final text, instead of being left over a shifted index
  // space or rebuilt after each step.
  let linesChanged = false;
  const noteLinesChanged = () => { linesChanged = true; };
  const withoutJumps = eliminateAvoidableGotos(result, {
    shouldAbort: opts.shouldAbort,
    onLinesChanged: noteLinesChanged,
  });
  const closureOptions = {
    ...(opts?.context !== undefined ? { context: opts.context } : {}),
    ...(opts?.binary !== undefined ? { binary: opts.binary } : {}),
    ...(opts?.image !== undefined ? { image: opts.image } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : internal?.model !== undefined ? { model: internal.model } : {}),
    ...(opts?.sections !== undefined ? { sections: opts.sections } : {}),
    ...(opts?.segments !== undefined ? { segments: opts.segments } : {}),
    ...(opts?.regions !== undefined ? { regions: opts.regions } : {}),
    ...(opts?.relocations !== undefined ? { relocations: opts.relocations } : {}),
    ...(opts?.fileBytes !== undefined ? { fileBytes: opts.fileBytes } : {}),
    ...(opts?.bytes !== undefined ? { bytes: opts.bytes } : {}),
    ...(opts?.readBytes !== undefined ? { readBytes: opts.readBytes } : {}),
    ...(opts?.readByte !== undefined ? { readByte: opts.readByte } : {}),
    ...(opts?.byteAt !== undefined ? { byteAt: opts.byteAt } : {}),
    ...(opts?.stringFor !== undefined ? { stringFor: opts.stringFor } : {}),
    ...(opts?.addressRefs !== undefined ? { addressRefs: opts.addressRefs } : {}),
    render: textOf,
    onLinesChanged: noteLinesChanged,
  };
  const closed = closeFunctionOutput(withoutJumps, closureOptions);
  if (linesChanged || internal.forceRefreshProvenance) refreshRenderProvenance(closed, opts, internal);
  return closed;
}

/** The public-output boundary is the contract the emitted C depends on. */
export function closePublicCOutputForTesting(result, opts = {}) {
  return closePublicCOutput(result, opts);
}

/*
 * Some textual disassemblers emit direct control-flow targets without '#'.
 * arm64.parseOperands then leaves them as `other`. Accept only a strict integer
 * token for known direct-control mnemonics; labels/symbol expressions are never
 * guessed into addresses.
 */
function strictTextAddress(op) {
  if (!op || op.k !== 'other') return null;
  // Target completion is control-flow authority, not display formatting: only
  // a raw primitive string can ground it. String()-coercing arrays/objects or
  // accepting numbers/booleans would launder schema-invalid operands into
  // definite branch/call targets (#5676).
  if (typeof op.text !== 'string') return null;
  const s = op.text.trim();
  if (!/^#?(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) return null;
  try { return BigInt(s.replace(/^#/, '')); } catch { return null; }
}

// Exported: the CFG-target completion boundary is a fail-closed contract of
// the decompiler entry, and consumers must be able to pin it (#5676).
export function semanticModelForDecompiler(model) {
  if (!model?.instructions?.length) return model;
  const originalInstructions = model.instructions;
  const instructionCount = originalInstructions.length;
  let instructions = null;
  for (let index = 0; index < instructionCount; index++) {
    if (!(index in originalInstructions)) continue;
    const insn = originalInstructions[index];
    const mn = String(insn.mnemonic || insn.mn || '').toLowerCase();
    const directBranch = mn === 'b' || /^b\.[a-z]{2}$/.test(mn) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mn);
    const directCall = mn === 'bl';
    if ((!directBranch || insn.branchTarget != null) && (!directCall || insn.callTarget != null)) continue;
    const ops = Array.isArray(insn.ops) ? insn.ops : [];
    const target = strictTextAddress(ops[ops.length - 1]);
    if (target == null) continue;
    instructions ||= originalInstructions.slice(0, instructionCount);
    instructions[index] = directCall ? { ...insn, callTarget: target } : { ...insn, branchTarget: target };
  }
  return instructions ? { ...model, instructions } : model;
}

function objcMethodInfo(model, opts) {
  const candidates = [opts?.name, model?.name];
  try { candidates.unshift(opts?.notes?.nameOf?.(opts.addr)); } catch { /* optional user notes */ }
  for (const value of candidates) {
    const text = String(value || '').trim();
    const match = /^([+-])\[([^\]\s]+)\s+([^\]]+)\]$/.exec(text);
    if (!match) continue;
    return {
      raw: text,
      kind: match[1],
      className: match[2],
      selector: match[3],
      arity: (match[3].match(/:/g) || []).length,
    };
  }
  return null;
}

function semanticOptionsForModel(model, opts) {
  const method = objcMethodInfo(model, opts);
  if (!method) return opts;
  if (opts.methodKind === 'objc' && opts.receiverType) return opts;
  return {
    ...opts,
    methodKind: opts.methodKind || 'objc',
    receiverType: opts.receiverType || method.className,
  };
}

function noteType(opts, addr, key) {
  try { return opts?.notes?.typeOf?.(addr, key) || null; } catch { return null; }
}

function noteName(opts, addr, key) {
  try { return opts?.notes?.varName?.(addr, key) || null; } catch { return null; }
}

function sanitizeObjcCIdentPart(value, fallback = 'anon') {
  const clean = String(value || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || fallback;
}

/* Keep the Objective-C symbol spelling while hiding implicit self/_cmd ABI args. */
function restoreObjcMethodSignature(result, model, opts) {
  if (!result?.semantic) return result;
  const method = objcMethodInfo(model, opts);
  if (!method) return result;
  const addr = opts.addr ?? model?.instructions?.[0]?.address ?? null;
  const recovered = new Map((result.types?.args || []).map((a) => [Number(a.index), a]));
  const args = [];
  for (let i = 0; i < method.arity; i++) {
    const abiIndex = i + 2; // x0=self, x1=_cmd, explicit ObjC arguments start at x2.
    const info = recovered.get(abiIndex);
    let type = noteType(opts, addr, `a${abiIndex}`) || info?.type || 'uint64';
    if (!type || type === 'unknown') type = 'uint64';
    const name = noteName(opts, addr, `a${abiIndex}`) || opts.argNames?.[abiIndex] || `a${abiIndex + 1}`;
    args.push(`${type} ${name}`);
  }
  let returnType = opts.returnType || noteType(opts, addr, 'ret') || result.types?.ret?.type || 'uint64';
  if (!returnType || returnType === 'unknown' || (returnType === 'void' && /\breturn\s+[^;]+;/.test(result.pseudocode || ''))) returnType = 'uint64';
  let signature;
  if (opts?.objcSyntax === 'c') {
    const prefix = method.kind === '+' ? 'objc_cls' : 'objc_inst';
    const clsPart = sanitizeObjcCIdentPart(method.className, 'Class');
    const selPart = sanitizeObjcCIdentPart(method.selector, 'sel');
    const cName = `${prefix}_${clsPart}_${selPart}`;
    const cArgs = ['id self', 'void * _cmd', ...args];
    signature = `${returnType} ${cName}(${cArgs.join(', ')})`;
  } else {
    signature = `${returnType} ${method.raw}(${args.length ? args.join(', ') : 'void'})`;
  }
  result.signature = signature;
  const sig = result.lines?.find((l) => l.kind === 'sig');
  if (sig) sig.text = signature;
  result.pseudocode = textOf(result.lines);
  return result;
}

function blockAddress(result, model, opts, bi) {
  const b = result?.ir?.blocks?.[bi];
  if (!b) return opts.addr ?? model.instructions?.[0]?.address ?? 0n;
  return model.instructions?.find((x) => x.row === b.startRow)?.address
    ?? opts.addrOfRow?.(b.startRow)
    ?? (opts.addr ?? model.instructions?.[0]?.address ?? 0n) + BigInt(b.startRow || 0) * 4n;
}

function labelAddress(result, model, opts, bi) {
  return `loc_${BigInt(blockAddress(result, model, opts, bi)).toString(16).toUpperCase()}`;
}

function nonNaturalBackwardEdges(result) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return [];
  const detachedExceptionBlocks = new Set(result?.ctx?.detachedExceptionBlockIndices || []);
  const edges = [];
  for (const block of ir.blocks) {
    // Exception landing pads are entered by the unwinder, not ordinary CFG.
    // Their jumps into earlier ARC cleanup blocks are expected EH exits rather
    // than evidence that the normal function contains an irreducible loop.
    if (detachedExceptionBlocks.has(block.index)) continue;
    for (const succ of block.succ || []) {
      const dst = ir.blocks[succ];
      if (!dst || dst.startRow >= block.startRow) continue;
      // Natural-loop definition: target dominates source.
      if (ir.dominators?.[block.index]?.has?.(succ)) continue;
      edges.push({ from: block, to: dst });
    }
  }
  return edges;
}

function reachableBlockSet(ir) {
  const seen = new Set();
  if (!ir?.blocks?.length) return seen;
  const entry = Number.isInteger(ir.entry) ? ir.entry : 0;
  const work = [entry];
  while (work.length) {
    const bi = work.pop();
    if (!Number.isInteger(bi) || bi < 0 || bi >= ir.blocks.length || seen.has(bi)) continue;
    seen.add(bi);
    for (const succ of ir.blocks[bi]?.succ || []) if (!seen.has(succ)) work.push(succ);
  }
  return seen;
}

function detachedBlockComponents(ir, reachable) {
  const detached = new Set((ir?.blocks || []).map((b) => b.index).filter((bi) => !reachable.has(bi)));
  if (!detached.size) return [];
  const reverse = new Map();
  for (const block of ir.blocks || []) {
    for (const succ of block.succ || []) {
      if (!reverse.has(succ)) reverse.set(succ, []);
      reverse.get(succ).push(block.index);
    }
  }
  const components = [];
  while (detached.size) {
    const seed = detached.values().next().value;
    const component = [];
    const work = [seed];
    detached.delete(seed);
    while (work.length) {
      const bi = work.pop();
      component.push(bi);
      const neighbors = [...(ir.blocks[bi]?.succ || []), ...(reverse.get(bi) || [])];
      for (const next of neighbors) {
        if (!detached.has(next)) continue;
        detached.delete(next);
        work.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

const EXCEPTION_RUNTIME_RE = /(?:objc_(?:begin|end)_catch|objc_exception_(?:throw|rethrow)|_?Unwind_Resume|__cxa_(?:begin|end)_catch|__cxa_rethrow|__clang_call_terminate|swift_willThrow)/i;

function callNamesForRows(model, opts, rows) {
  const names = [];
  for (const call of model?.calls || []) {
    if (rows.has(call?.row) && call?.name) names.push(String(call.name));
  }
  for (const insn of model?.instructions || []) {
    if (!rows.has(insn?.row)) continue;
    const mn = String(insn.mnemonic || insn.mn || '').toLowerCase();
    if (mn !== 'bl' && mn !== 'blr') continue;
    const target = insn.callTarget ?? null;
    if (target == null) continue;
    try {
      const name = opts.symbolFor?.(target);
      if (name) names.push(String(name));
    } catch { /* optional symbol resolver */ }
  }
  return names;
}

function componentRows(ir, component) {
  const rows = new Set();
  for (const bi of component) {
    const block = ir.blocks[bi];
    if (!block) continue;
    for (let row = block.startRow; row <= block.endRow; row++) rows.add(row);
  }
  return rows;
}

/*
 * Detached exception landing pads have no normal predecessor: the unwinder
 * enters them through Mach-O EH metadata rather than a B/CBZ edge. Treat only
 * components with explicit runtime EH evidence as exception-only. Any other
 * disconnected component keeps the historical whole-function safe fallback.
 */
function detachedExceptionComponents(result, model, opts) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return { reachable: new Set(), components: [], allException: true };
  const reachable = reachableBlockSet(ir);
  const components = detachedBlockComponents(ir, reachable);
  if (!components.length) return { reachable, components: [], allException: true };
  const classified = components.map((blocks) => {
    const rows = componentRows(ir, blocks);
    const callNames = callNamesForRows(model, opts, rows);
    return { blocks, rows, callNames, exception: callNames.some((name) => EXCEPTION_RUNTIME_RE.test(name)) };
  });
  return { reachable, components: classified, allException: classified.every((c) => c.exception) };
}

function ensureLegacyLabel(lines, row, label, address) {
  if (lines.some((l) => String(l.text || '').replace(/:$/, '') === label)) return;
  const open = lines.findIndex((l) => l.kind === 'ctrl' && l.text === '{');
  const floor = open >= 0 ? open + 1 : 1;
  let at = lines.findIndex((l, i) => i >= floor && l.row != null && l.row >= row && l.kind !== 'sig');
  if (at < 0) {
    const functionIndent = open >= 0 ? (lines[open]?.indent ?? 0) : null;
    at = lines.findIndex((l, i) => i >= floor && l.kind === 'ctrl' && l.text === '}'
      && (functionIndent == null || (l.indent ?? 0) === functionIndent));
  }
  if (at < 0) at = Math.min(floor, lines.length);
  const indent = Math.max(1, lines[at]?.indent || 1);
  lines.splice(at, 0, { kind: 'label', indent, text: `${label}:`, row, addr: address, note: null });
}

export function ensureLegacyLabelForTesting(lines, row, label, address = null) {
  ensureLegacyLabel(lines, row, label, address);
  return lines;
}

function ensureLegacyGoto(lines, edge, label) {
  // Only synthesize an unconditional goto when IR proves a single successor.
  // Conditional non-natural edges keep the conservative Semantic IR CFG path.
  if ((edge.from.succ || []).length !== 1) return false;
  const from = edge.from.insts?.at(-1), to = edge.to.insts?.[0];
  if (!from || !to) return false;
  const source = mergeSource(...[from, to].map(inst => sourceOf({
    row:inst.row, address:inst.address, ir:inst.id,
    evidence:[{ reason:'canonical shared-cleanup control edge' }],
  })));
  const existing = lines.find(l => l.row === edge.from.endRow && String(l.text || '').includes(`goto ${label}`));
  if (existing) { existing.source = mergeSource(existing.source, source); return true; }
  const open = lines.findIndex((l) => l.kind === 'ctrl' && l.text === '{');
  const functionIndent = open >= 0 ? (lines[open]?.indent ?? 0) : 0;
  const close = lines.findIndex((l, i) =>
    i > open && l.kind === 'ctrl' && l.text === '}' && (l.indent ?? 0) === functionIndent);
  const ceiling = close >= 0 ? close : lines.length;
  let at = -1;
  for (let i = Math.max(0, open + 1); i < ceiling; i++) {
    const r = lines[i]?.row;
    if (r != null && r <= edge.from.endRow) at = i;
  }
  if (at < 0) return false;
  const indent = Math.max(1, lines[at]?.indent || 1);
  lines.splice(at + 1, 0, { kind: 'stmt', indent, text: `goto ${label};`, row: edge.from.endRow, addr: from.address ?? null, note: null, source });
  return true;
}

export function ensureLegacyGotoForTesting(lines, edge, label) {
  return ensureLegacyGoto(lines, edge, label);
}

function ensureSemanticLabel(result, model, opts, bi) {
  const block = result?.ir?.blocks?.[bi];
  if (!block || !result?.lines) return false;
  const label = labelAddress(result, model, opts, bi);
  if (result.lines.some((l) => String(l.text || '').replace(/:$/, '') === label)) return true;
  let at = result.lines.findIndex((l) => l.row != null && l.row >= block.startRow && l.kind !== 'sig');
  if (at < 0) return false;
  const indent = Math.max(1, result.lines[at]?.indent || 1);
  result.lines.splice(at, 0, { kind: 'label', indent, text: `${label}:`, row: block.startRow, addr: blockAddress(result, model, opts, bi), note: null });
  return true;
}

function lineBelongsToRows(line, rows, opts) {
  if (line?.row != null && rows.has(line.row)) return true;
  if (line?.addr == null) return false;
  try {
    const row = opts.rowOfAddress?.(BigInt(line.addr));
    return row != null && rows.has(row);
  } catch { return false; }
}

/*
 * The linear renderer deliberately coalesces some register moves and redundant
 * branches.  In a detached EH block that would leave no visible line even
 * though the instructions are real and unwind-only.  Keep those instructions
 * as exact assembly comments instead of discarding the semantic body or
 * pretending that the omitted transfer has no effect.
 */
function exactExceptionAssemblyLines(model, block) {
  const instructions = (model?.instructions || []).filter((insn) =>
    insn?.row != null && insn.row >= block.startRow && insn.row <= block.endRow);
  if (!instructions.length) return [];
  return instructions.map((insn) => {
    const mnemonic = String(insn.mnemonic || insn.mn || 'unknown').trim();
    const operands = String(insn.operands || insn.opsText || '').trim();
    const text = `/* Exception-path assembly: ${mnemonic}${operands ? ` ${operands}` : ''} */`;
    return { kind: 'comment', indent: 2, text, row: insn.row, addr: insn.address ?? null, note: 'Detached exception-path instruction preserved verbatim.' };
  });
}

/*
 * Preserve detached EH code without replacing the normal Semantic IR body with
 * legacy register expressions. Legacy is used only to render the EH rows that
 * are unreachable through ordinary CFG edges. Runtime-only entry labels make
 * the separation explicit and prevent catch code from looking like normal code
 * that executes after a return.
 */
function cloneLegacyResult(legacy) {
  if (!legacy) return legacy;
  return {
    ...legacy,
    lines: Array.isArray(legacy.lines) ? legacy.lines.map((l) => ({ ...l })) : [],
    warnings: Array.isArray(legacy.warnings) ? legacy.warnings.slice() : [],
    evidence: Array.isArray(legacy.evidence) ? legacy.evidence.slice() : [],
    ctx: legacy.ctx ? { ...legacy.ctx } : legacy.ctx,
    coverage: legacy.coverage ? { ...legacy.coverage } : legacy.coverage,
  };
}

function graftDetachedExceptionRegions(model, semanticModel, opts, semantic, classification, getLegacy) {
  if (!classification.components.length || !classification.allException) return null;
  const closeCheck = semantic.lines?.findLastIndex?.((l) => l.kind === 'ctrl' && l.text === '}') ?? -1;
  if (closeCheck < 0) return null;
  const legacy = getLegacy ? getLegacy({ readOnly: true }) : legacyDecompile(model, opts);
  const detachedBlocks = new Set(classification.components.flatMap((c) => c.blocks));
  const regionLines = [];

  for (const component of classification.components) {
    const blocks = component.blocks
      .map((bi) => semantic.ir.blocks[bi])
      .filter(Boolean)
      .sort((a, b) => a.startRow - b.startRow);
    for (const block of blocks) {
      const rows = componentRows(semantic.ir, [block.index]);
      let rendered = (legacy.lines || []).filter((l) =>
        l.kind !== 'sig' && !(l.kind === 'ctrl' && (l.text === '{' || l.text === '}')) && l.kind !== 'label' && lineBelongsToRows(l, rows, opts));
      if (!rendered.length && block.endRow >= block.startRow) {
        rendered = exactExceptionAssemblyLines(model, block);
        if (!rendered.length) return null; // never silently omit an EH block
      }
      regionLines.push({
        kind: 'label', indent: 1,
        text: `${labelAddress(semantic, semanticModel, opts, block.index)}:`,
        row: block.startRow, addr: blockAddress(semantic, semanticModel, opts, block.index), note: null,
      });
      for (const l of rendered) regionLines.push({ ...l, indent: Math.max(2, l.indent || 1) });
    }
  }

  // A landing pad may branch into the ordinary ARC cleanup tail. Those targets
  // need an explicit label in the semantic body so every preserved goto lands.
  for (const bi of detachedBlocks) {
    for (const succ of semantic.ir.blocks[bi]?.succ || []) {
      if (!detachedBlocks.has(succ) && classification.reachable.has(succ)) {
        if (!ensureSemanticLabel(semantic, semanticModel, opts, succ)) return null;
      }
    }
  }

  const close = semantic.lines?.findLastIndex?.((l) => l.kind === 'ctrl' && l.text === '}') ?? -1;
  if (close < 0) return null;
  semantic.lines.splice(close, 0,
    { kind: 'comment', indent: 1, text: '/* Exception landing pads — entered only by runtime unwinding. */', row: null, addr: null, note: null },
    ...regionLines,
  );

  const detachedIndices = [...detachedBlocks].sort((a, b) => a - b);
  const detachedCount = detachedIndices.length;
  semantic.warnings = [
    ...(semantic.warnings || []),
    `${detachedCount} exception landing-pad Basic Block(s) are isolated from normal control flow and preserved separately.`,
  ];
  semantic.coverage = {
    ...(semantic.coverage || {}),
    total: semantic.ir.blocks.length,
    emitted: semantic.ir.blocks.length,
    missing: 0,
    detachedExceptionBlocks: detachedCount,
  };
  semantic.ctx = {
    ...(semantic.ctx || {}),
    detachedExceptionBlocks: detachedCount,
    detachedExceptionBlockIndices: detachedIndices,
  };
  semantic.pseudocode = textOf(semantic.lines);
  return semantic;
}

/**
 * Keep legacy statement rendering for a rare non-natural shared-cleanup layout,
 * but graft in only the goto/label edges proven by Semantic IR. This avoids the
 * old false-loop bug without replacing an otherwise translatable function with
 * raw assembly.
 */
function legacyWithIrCleanupEdges(model, semanticModel, opts, semantic, edges, getLegacy) {
  if (!edges.every((edge) => (edge.from.succ || []).length === 1 && edge.from.insts?.at(-1) && edge.to.insts?.[0])) {
    return null;
  }
  const fallback = augmentLegacy(
    getLegacy ? getLegacy() : legacyDecompile(model, opts),
    'A backward control-flow edge is not a proven natural loop; Semantic IR supplies the shared-cleanup goto/label edge while legacy rendering handles statements.',
    semantic,
  );
  for (const edge of edges) {
    const label = labelAddress(semantic, semanticModel, opts, edge.to.index);
    const address = blockAddress(semantic, semanticModel, opts, edge.to.index);
    ensureLegacyLabel(fallback.lines || (fallback.lines = []), edge.to.startRow, label, address);
    if (!ensureLegacyGoto(fallback.lines, edge, label)) return null;
  }
  fallback.pseudocode = textOf(fallback.lines);
  fallback.coverage = { ...(semantic.coverage || {}), mode: 'linear', total: semantic.ir?.blocks?.length || 0, emitted: semantic.ir?.blocks?.length || 0, missing: 0 };
  fallback.ctx = { ...(fallback.ctx || {}), semanticCleanupEdges: edges.length };
  return fallback;
}

function preferLegacyForUnsupported(model, opts, semantic, getLegacy) {
  const unsupported = semantic?.ctx?.unknownInstructions || 0;
  if (!unsupported) return semantic;
  const semanticAsm = asmCount(semantic);
  if (semanticAsm === 0) return semantic;
  const legacy = augmentLegacy(
    getLegacy ? getLegacy() : legacyDecompile(model, opts),
    `Semantic IR has ${unsupported} unsupported instruction(s); only this unsupported function uses the isolated legacy expression fallback.`,
    semantic,
  );
  // The legacy path is a fallback, not an unconditional preference. If it is
  // actually less faithful (more raw assembly), keep the Semantic IR result.
  return asmCount(legacy) < semanticAsm ? legacy : semantic;
}

export function decompile(model, opts = {}) {
  if (opts.semanticIR === false || opts.forceLegacyDecompiler === true) {
    return finalize(legacyDecompile(model, opts), model, opts);
  }
  const semanticModel = semanticModelForDecompiler(model);
  const semanticOpts = semanticOptionsForModel(semanticModel, opts);
  let cachedLegacy = null;
  const getLegacy = ({ readOnly = false, consume = false } = {}) => {
    if (!cachedLegacy) cachedLegacy = legacyDecompile(model, opts);
    if (readOnly) return cachedLegacy;
    if (consume) {
      const owned = cachedLegacy;
      cachedLegacy = null;
      return owned;
    }
    return cloneLegacyResult(cachedLegacy);
  };
  try {
    let result = decompileSemantic(semanticModel, semanticOpts);
    if (result) {
      const total = result.ir?.blocks?.length || 0;
      const reachable = result.coverage?.reachable ?? total;
      if (total > reachable) {
        const detached = detachedExceptionComponents(result, semanticModel, semanticOpts);
        if (detached.allException && detached.components.length) {
          const mixed = graftDetachedExceptionRegions(model, semanticModel, semanticOpts, result, detached, getLegacy);
          if (mixed) result = mixed;
          else {
            return finalize(augmentLegacy(
              getLegacy({ consume: true }),
              `Semantic IR covers ${reachable}/${total} Basic Blocks; detached exception regions could not be preserved losslessly, so the isolated faithful fallback was used.`,
              result,
            ), model, opts);
          }
        } else {
          return finalize(augmentLegacy(
            getLegacy({ consume: true }),
            `Semantic IR covers ${reachable}/${total} Basic Blocks; disconnected or indirect targets use the isolated faithful fallback.`,
            result,
          ), model, opts);
        }
      }

      const cleanupEdges = nonNaturalBackwardEdges(result);
      if (cleanupEdges.length) {
        const mixed = legacyWithIrCleanupEdges(model, semanticModel, semanticOpts, result, cleanupEdges, getLegacy);
        if (mixed) return finalize(mixed, semanticModel, semanticOpts);
      }

      result = preferLegacyForUnsupported(model, semanticOpts, result, getLegacy);
      if (!result.semantic) return finalize(result, semanticModel, semanticOpts);

      result = repairCanonicalPostTestLoop(result, (bi) => blockAddress(result, semanticModel, semanticOpts, bi));
      result = restoreObjcMethodSignature(result, semanticModel, semanticOpts);
      if (result.coverage) {
        result.coverage.total = total;
        result.coverage.emitted = result.coverage.emitted ?? total;
      }
      return finalize(result, semanticModel, semanticOpts);
    }
  } catch (error) {
    return finalize(augmentLegacy(
      getLegacy({ consume: true }),
      `Semantic IR decompiler fallback: ${error && error.message ? error.message : 'unknown error'}`,
    ), model, opts);
  }
  return finalize(augmentLegacy(getLegacy({ consume: true }), 'Semantic IR is unavailable for this function.'), model, opts);
}
