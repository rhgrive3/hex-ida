/**
 * Canonical Phase 8 structured-control projection.
 *
 * Adopts completely reducible, proven conditional regions published by
 * Phase 8 structuring facts (phase8/structuring.js) into final C control
 * representation.
 *
 * The projector is strictly proof-bound and downstream:
 * - Reads only canonical structuring facts, dominators, loops, and CFG.
 * - Does NOT recalculate dominators, loops, SESE, reachability, or act
 *   as a second structurer.
 * - Leaves output unchanged when facts are partial, stale, constraint-bearing,
 *   unsupported, or already structured identically by the upstream renderer.
 */

import { edgeAccountingFailures } from './structuring.js';
import { LOOP_PROJECTION_CANCELLED, projectNaturalLoops } from './loop-control-projection.js';
import { analysisIdentityMatches, boundAnalysisIdentityForIr, canonicalAnalysisIdentity } from './analysis-identity.js';
import { printProgram } from '../pretty/c.js';
import { sourceOf, mergeSource } from '../ast/nodes.js';
import { expressionOriginHistory } from '../rewrite/engine.js';
import {
  readSemanticControlLineHistory,
  registerSemanticControlLineHistory,
  readSemanticStatementLineHistory,
  readSemanticStoreLineHistory,
  renderBranchCondition,
} from '../semantic-core.js';
import { buildRenderProvenance } from './render-provenance.js';

// Version 2 adds the canonical natural-loop projection. The counter is a
// consumer contract, not decoration: a consumer that understood version 1
// cannot assume that a version 2 body only contains conditional adoption
// records.
export const STRUCTURED_CONTROL_PROJECTION_VERSION = 2;

const structuredControlProjections = new WeakMap();

/**
 * Returns the current structured control projection record attached to a result,
 * or null if none is present or current.
 */
export function readStructuredControlProjection(result) {
  if (!result) return null;
  const target = result.cAst ?? result;
  const entry = structuredControlProjections.get(target);
  try {
    return entry && entry.ir === result.ir && entry.isCurrent() ? entry : null;
  } catch {
    return null;
  }
}

function asAddress(value) {
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function addressAtRow(row, ir, opts = {}) {
  if (row == null) return null;
  try {
    const resolved = opts.addressOfRow?.(row);
    const address = asAddress(resolved);
    if (address != null) return address;
  } catch { /* Fall through to IR evidence. */ }
  const instruction = ir?.instructions?.find((candidate) =>
    candidate?.row === row && candidate?.address != null
  );
  return asAddress(instruction?.address);
}

function blockAddress(block, ir, opts = {}) {
  if (!block) return null;
  const explicit = asAddress(block.address);
  if (explicit != null) return explicit;
  const rowAddress = addressAtRow(block.startRow, ir, opts);
  if (rowAddress != null) return rowAddress;
  const localInstruction = block.insts?.find((candidate) =>
    candidate?.row === block.startRow && candidate?.address != null
  );
  return asAddress(localInstruction?.address);
}

function textJumpsToAddress(text, address) {
  const target = asAddress(address);
  if (typeof text !== 'string' || target == null) return false;
  const pattern = /\bgoto\s+loc_([0-9a-fA-F]+)\s*;/g;
  let match;
  while ((match = pattern.exec(text)) != null) {
    try {
      if (BigInt(`0x${match[1]}`) === target) return true;
    } catch { /* Ignore malformed labels. */ }
  }
  return false;
}

function terminatorOf(block) {
  const insts = block?.insts ?? [];
  for (let i = insts.length - 1; i >= 0; i--) {
    const op = insts[i]?.op;
    if (op === 'cbr' || op === 'br' || op === 'ret' || op === 'switch') return insts[i];
  }
  return null;
}

function controlSource(inst, block = null, ir = null, opts = {}) {
  const row = inst?.row ?? block?.startRow ?? null;
  const address = inst?.address ?? (block ? blockAddress(block, ir, opts) : null);
  const irIds = inst ? [inst.id] : (block?.insts ?? []).map(i => i.id).filter(Boolean);
  return sourceOf({
    row,
    address,
    ir: irIds,
    evidence: [{ reason: 'Phase 8 canonical structured control flow projection' }],
  });
}

function blockOfNode(node, ir, opts = {}) {
  if (!node) return null;
  if (typeof node.block === 'number') return node.block;
  if (typeof node.semantic?.block === 'number') return node.semantic.block;
  const control = readSemanticControlLineHistory(node, ir);
  if (control) {
    if (control.instruction?.block != null) return control.instruction.block;
    if (control.selection?.target != null) return control.selection.target;
  }
  const stmt = readSemanticStatementLineHistory(node, ir);
  if (stmt?.instruction?.block != null) return stmt.instruction.block;
  const store = readSemanticStoreLineHistory(node, ir);
  if (store?.instruction?.block != null) return store.instruction.block;

  const targetIrId = node.semantic?.ir ?? node.source?.ir?.[0];
  if (targetIrId && Array.isArray(ir?.blocks)) {
    for (const block of ir.blocks) {
      if (block.insts?.some(i => i?.id === targetIrId)) return block.index;
    }
  }
  if (Array.isArray(ir?.instructions) && targetIrId) {
    const inst = ir.instructions.find(i => i?.id === targetIrId);
    if (inst?.block != null) return inst.block;
  }
  if (node.kind === 'label' && typeof node.text === 'string' && Array.isArray(ir?.blocks)) {
    const labelMatch = node.text.match(/^loc_([0-9a-fA-F]+):/);
    if (labelMatch) {
      try {
        const addr = BigInt('0x' + labelMatch[1]);
        const block = ir.blocks.find(b => blockAddress(b, ir, opts) === addr);
        if (block) return block.index;
      } catch { /* Ignore */ }
    }
  }
  if (Array.isArray(node.source?.rows) && node.source.rows.length > 0 && Array.isArray(ir.blocks)) {
    const row = Number(node.source.rows[0]);
    const block = ir.blocks.find(b => row >= b.startRow && row <= b.endRow);
    if (block) return block.index;
  }
  if (node.addr != null && Array.isArray(ir.blocks)) {
    try {
      const addr = typeof node.addr === 'bigint' ? node.addr : BigInt(node.addr);
      const block = ir.blocks.find(b => blockAddress(b, ir, opts) === addr);
      if (block) return block.index;
    } catch { /* Ignore */ }
  }
  return null;
}

function targetBlock(ir, cbr, rowOfAddress) {
  const provenBlock = cbr?.extra?.targetBlock;
  if (Number.isInteger(provenBlock) && ir.blocks?.[provenBlock] != null) return provenBlock;
  const addr = cbr?.extra?.target;
  if (addr == null) return null;
  const row = rowOfAddress?.(addr);
  if (row == null) return null;
  return ir.blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function branchTargetsOf(entryBlock, ir, opts = {}) {
  const succ = entryBlock?.succ ?? [];
  if (succ.length !== 2) return null;

  // Canonical branch polarity is meaningful only for a proven conditional
  // terminator. Stale edge metadata or rendered C text must never upgrade a
  // br/switch into a conditional projection.
  const term = terminatorOf(entryBlock);
  if (term?.op !== 'cbr') return null;

  for (const edge of entryBlock.successorEdges ?? []) {
    if (edge.kinds?.includes('conditional-true') || edge.kind === 'conditional-true') {
      const trueTarget = edge.to;
      const falseTarget = succ.find(s => s !== trueTarget);
      if (falseTarget != null) return { trueTarget, falseTarget };
    }
  }

  const target = term.extra?.targetBlock ?? targetBlock(ir, term, opts.rowOfAddress);
  if (target != null && succ.includes(target)) {
    const falseTarget = succ.find(s => s !== target);
    return { trueTarget: target, falseTarget };
  }

  // Successor order is not semantic polarity. If neither canonical edge
  // metadata nor the branch instruction proves the taken target, do not guess.
  return null;
}

function relationContains(sets, tree, ancestor, node) {
  if (ancestor === node) return true;
  const set = sets?.[node];
  if (set != null) {
    if (typeof set.has === 'function') return set.has(ancestor);
    if (Array.isArray(set)) return set.includes(ancestor);
    if (typeof set[Symbol.iterator] === 'function') return [...set].includes(ancestor);
  }
  if (tree == null) return null;
  let current = node;
  const visited = new Set();
  while (current != null && current >= 0 && !visited.has(current) && visited.size < 4096) {
    visited.add(current);
    const next = tree?.[current];
    if (next == null || next === current) return false;
    if (next === ancestor) return true;
    current = next;
  }
  return false;
}

function unsafeProjectionEdge(edge) {
  if (!edge) return true;
  if (edge.construct === 'constraint-edge' || edge.construct === 'unknown' || edge.construct === 'residual-goto') return true;
  if (typeof edge.construct === 'string' && edge.construct.startsWith('loop-')) return true;
  if (edge.construct === 'switch-case' || edge.construct === 'switch-join') return true;
  return Array.isArray(edge.kinds) && edge.kinds.some((kind) => kind === 'unwind' || kind === 'exception');
}

function collectArmBlocks(start, entry, join, byIndex) {
  if (start === join) return new Set();
  const blocks = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const index = pending.pop();
    if (index === join) continue;
    if (index === entry || blocks.has(index)) {
      if (index === entry) return null;
      continue;
    }
    const block = byIndex.get(index);
    if (!block || !Array.isArray(block.succ) || block.succ.length === 0) return null;
    blocks.add(index);
    if (blocks.size > byIndex.size) return null;
    for (const target of block.succ) {
      if (target === join) continue;
      if (!byIndex.has(target)) return null;
      pending.push(target);
    }
  }
  return blocks;
}

/**
 * Proves the complete arm partition for one canonical conditional region.
 * The structuring artifact currently publishes immediate non-join successors
 * in region.members, so the projector expands each arm only under dominance,
 * post-dominance, single-entry and edge-closure proofs. Any ambiguity rejects
 * the projection rather than guessing where a block belongs.
 */
function conditionalRegionPartition(region, facts, cfg, dominators) {
  if (!region || region.kind !== 'conditional') return null;
  if (!Array.isArray(region.exits) || region.exits.length !== 1) return null;
  if (!Array.isArray(region.members) || !Array.isArray(facts?.edges)) return null;
  const entry = region.entry;
  const join = region.exits[0];
  if (!Number.isInteger(entry) || !Number.isInteger(join) || entry === join) return null;

  const byIndex = new Map((cfg?.blocks ?? []).map((block) => [block?.index, block]));
  const entryBlock = byIndex.get(entry);
  const joinBlock = byIndex.get(join);
  if (!entryBlock || !joinBlock || !Array.isArray(entryBlock.succ) || entryBlock.succ.length !== 2) return null;
  if (entryBlock.succ[0] === entryBlock.succ[1]) return null;
  if (terminatorOf(entryBlock)?.op !== 'cbr') return null;

  // The canonical structurer defines the conditional join as entry.ipdom and
  // publishes the immediate non-join successors as members. Bind to that exact
  // evidence so a forged/stale region cannot choose its own exit or omit an arm.
  if (dominators?.ipdom?.[entry] !== join) return null;
  const declaredMembers = new Set(region.members);
  const expectedMembers = new Set(entryBlock.succ.filter((target) => target !== join));
  if (declaredMembers.size !== expectedMembers.size
      || [...expectedMembers].some((target) => !declaredMembers.has(target))) return null;

  if (Array.isArray(region.constraints) && region.constraints.length > 0) return null;
  if (Array.isArray(region.residualGotos) && region.residualGotos.length > 0) return null;

  const armsByTarget = new Map();
  for (const target of entryBlock.succ) {
    const arm = collectArmBlocks(target, entry, join, byIndex);
    if (arm == null) return null;
    armsByTarget.set(target, arm);
  }

  const [leftTarget, rightTarget] = entryBlock.succ;
  const left = armsByTarget.get(leftTarget);
  const right = armsByTarget.get(rightTarget);
  if ([...left].some((index) => right.has(index))) return null;

  const armBlocks = new Set([...left, ...right]);
  if (relationContains(dominators?.postDominators, dominators?.ipdom, join, entry) !== true) return null;
  for (const index of armBlocks) {
    if (relationContains(dominators?.dominators, dominators?.idom, entry, index) !== true) return null;
    if (relationContains(dominators?.postDominators, dominators?.ipdom, join, index) !== true) return null;

    const block = byIndex.get(index);
    if (!Array.isArray(block?.pred)) return null;
    const isRoot = expectedMembers.has(index);
    for (const predecessor of block.pred) {
      if (isRoot) {
        if (predecessor !== entry) return null;
      } else if (!armBlocks.has(predecessor) && predecessor !== entry) {
        return null;
      }
    }
    for (const successor of block.succ ?? []) {
      if (successor !== join && !armBlocks.has(successor)) return null;
    }
  }

  const regionBlocks = new Set([entry, ...armBlocks]);
  for (const edge of facts.edges) {
    if (!regionBlocks.has(edge.from)) continue;
    if (unsafeProjectionEdge(edge)) return null;
    if (edge.to !== join && !regionBlocks.has(edge.to)) return null;
  }

  return { entry, join, byIndex, armBlocks, armsByTarget };
}

/**
 * Checks whether a candidate conditional region is completely reducible, proven,
 * and safe for adoption into C control projection.
 */
export function isAdoptableConditionalRegion(region, facts, cfg, dominators) {
  return conditionalRegionPartition(region, facts, cfg, dominators) != null;
}

function dominatorDepth(dominators, block) {
  let depth = 0;
  let cur = block;
  const idom = dominators?.idom;
  const visited = new Set();
  while (cur != null && cur >= 0 && !visited.has(cur) && visited.size < 4096) {
    visited.add(cur);
    const next = idom?.[cur];
    if (next == null || next === cur) break;
    depth++;
    cur = next;
  }
  return depth;
}

/**
 * Checks if a candidate region is already structured in the current C AST.
 */
function isAlreadyStructured(entry, join, isOneSided, ifArm, elseArm, cAst, ir, opts = {}) {
  const body = cAst?.body ?? [];
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (node.kind === 'ctrl' && typeof node.text === 'string' && node.text.startsWith('if ') && node.text.endsWith('{')) {
      const block = blockOfNode(node, ir, opts);
      if (block === entry) {
        const hasGoto = body.some(n => blockOfNode(n, ir, opts) === entry && n.text?.includes('goto loc_'));
        if (!hasGoto) return true;
      }
    }
  }
  return false;
}

/**
 * Adopts proven reducible conditional regions from Phase 8 structuring facts
 * into the final C AST.
 *
 * @param {object} result - Decompilation result containing cAst, ir, lines, etc.
 * @param {object} analysis - Authoritative Phase 8 AnalysisState.
 * @param {object} opts - Decompiler options.
 * @returns {object} Updated or unchanged result.
 */
export function applyStructuredControlProjection(result, analysis, opts = {}) {
  if (!result?.cAst?.body || !result?.ir || !analysis) return result;
  if (opts.shouldAbort?.() === true) return result;

  const facts = analysis.get('structuredRegions');
  if (!facts || facts.completeness !== 'complete') return result;
  if (edgeAccountingFailures(result.ir, facts).length > 0) return result;

  // Stale artifact verification
  const currentId = boundAnalysisIdentityForIr(opts.analysisIdentityBinding, result.ir)
    ?? canonicalAnalysisIdentity({ ir: result.ir, analysis });
  if (!currentId.valid) return result;
  const expectedId = opts.analysisIdentity?.identity ?? currentId.identity;
  if (!analysisIdentityMatches(currentId.identity, expectedId)) return result;

  const cfg = analysis.get('cfg') ?? { blocks: result.ir.blocks };
  const dominators = analysis.get('dominators') ?? { idom: result.ir.idom, ipdom: result.ir.ipdom };

  // Collect candidate adoptable regions together with the proved complete
  // arm partition. Reusing the same proof below prevents validation/rendering
  // from disagreeing about which blocks belong to an arm.
  const candidateRegions = [];
  for (const region of facts.regions ?? []) {
    const partition = conditionalRegionPartition(region, facts, cfg, dominators);
    if (partition) candidateRegions.push({ region, partition });
  }
  // Loop regions are a second adoption path over the same body, so a function
  // whose only structurally adoptable regions are loops must not be dismissed
  // as "nothing adoptable".
  const hasLoopRegions = (facts.regions ?? []).some((region) => region?.kind === 'loop');
  if (candidateRegions.length === 0 && !hasLoopRegions) return result;

  // Sort candidate regions innermost first (descending dominator depth, then descending entry index)
  candidateRegions.sort((left, right) => {
    const depthLeft = dominatorDepth(dominators, left.region.entry);
    const depthRight = dominatorDepth(dominators, right.region.entry);
    if (depthLeft !== depthRight) return depthRight - depthLeft;
    return right.region.entry - left.region.entry;
  });

  let workingBody = [...result.cAst.body];
  const adoptedRecords = [];
  const adoptedRegions = [];

  for (const candidate of candidateRegions) {
    if (opts.shouldAbort?.() === true) return result;
    const { region, partition } = candidate;
    const entry = region.entry;
    const join = region.exits[0];
    const entryBlock = (result.ir.blocks ?? []).find((block) => block?.index === entry);
    const joinBlock = (result.ir.blocks ?? []).find((block) => block?.index === join);
    if (!entryBlock || !joinBlock) continue;

    const targets = branchTargetsOf(entryBlock, result.ir, opts);
    if (!targets) continue;
    const { trueTarget, falseTarget } = targets;

    const isOneSided = (trueTarget === join || falseTarget === join);
    let invert = false;
    let ifArm = null;
    let elseArm = null;

    if (isOneSided) {
      if (falseTarget === join) {
        ifArm = trueTarget;
        invert = false;
      } else {
        ifArm = falseTarget;
        invert = true;
      }
    } else {
      ifArm = trueTarget;
      elseArm = falseTarget;
      invert = false;
    }

    // Check if existing renderer already emitted the exact canonical structure
    if (isAlreadyStructured(entry, join, isOneSided, ifArm, elseArm, { body: workingBody }, result.ir, opts)) {
      continue;
    }

    const term = terminatorOf(entryBlock);
    if (!term) continue;

    // Determine condition text
    let condText = null;
    if (term.op === 'cbr') {
      try {
        const rendered = renderBranchCondition(term, { ir: result.ir, types: result.types, opts }, invert);
        if (rendered && rendered !== 'condition' && !rendered.includes('unknown')) condText = rendered;
      } catch { /* Fallback below */ }
    }

    // Find the entry branch node in workingBody
    const branchIndex = workingBody.findIndex(n => {
      if (blockOfNode(n, result.ir, opts) !== entry) return false;
      if (n.kind !== 'ctrl' && n.kind !== 'stmt') return false;
      return typeof n.text === 'string' && (n.text.startsWith('if ') || n.text.includes('goto loc_'));
    });
    if (branchIndex < 0) continue;

    const existingBranchNode = workingBody[branchIndex];
    if (!condText) {
      const match = existingBranchNode.text?.match(/^if\s*\((.+)\)\s*(?:goto\s+\w+;|\{)/);
      const expression = match?.[1]?.trim();
      if (expression) condText = invert ? `!(${expression})` : expression;
    }
    // Missing condition text is not permission to invent a placeholder.
    if (!condText) continue;

    const entryIndent = existingBranchNode.indent ?? 1;
    const trueArmBlocks = partition.armsByTarget.get(trueTarget);
    const falseArmBlocks = partition.armsByTarget.get(falseTarget);
    if (!trueArmBlocks || !falseArmBlocks) continue;
    const ifArmBlocks = new Set(isOneSided
      ? [...(invert ? falseArmBlocks : trueArmBlocks)]
      : [...trueArmBlocks]);
    const elseArmBlocks = new Set(isOneSided ? [] : [...falseArmBlocks]);
    const armBlocks = new Set([...ifArmBlocks, ...elseArmBlocks]);

    // Match the producer's real target address, never a block row/index or a
    // case-sensitive rendering of the label text.
    const joinAddress = blockAddress(joinBlock, result.ir, opts);
    if (joinAddress == null) continue;
    const otherJumpsToJoin = workingBody.some(n => {
      const b = blockOfNode(n, result.ir, opts);
      if (b === entry || armBlocks.has(b)) return false;
      return textJumpsToAddress(n.text, joinAddress);
    });

    const isArmNode = (node, blocks) => {
      const b = blockOfNode(node, result.ir, opts);
      return b != null && blocks.has(b);
    };

    const isRemovableTailJumpToJoin = (node) => {
      if (node.kind !== 'stmt' || typeof node.text !== 'string') return false;
      if (!textJumpsToAddress(node.text, joinAddress)) return false;
      const blockIndex = blockOfNode(node, result.ir, opts);
      const block = partition.byIndex.get(blockIndex);
      return Array.isArray(block?.succ) && block.succ.length === 1 && block.succ[0] === join;
    };

    const isBlockLabel = (node, blockIdx) => {
      if (node.kind !== 'label') return false;
      const b = blockOfNode(node, result.ir, opts);
      return b === blockIdx;
    };

    // Extract complete arm bodies in producer order. Only the immediate arm
    // entry label and an unconditional tail jump to the proven join are
    // redundant. Internal labels/gotos remain intact unless an inner region
    // was already projected, preserving nested control flow fail-closed.
    const extractArmStatements = (blocks, root) => {
      const stmts = [];
      for (const node of workingBody) {
        if (!isArmNode(node, blocks)) continue;
        const blockIndex = blockOfNode(node, result.ir, opts);
        if (node.kind === 'label' && blockIndex === root) continue;
        if (isRemovableTailJumpToJoin(node)) continue;
        stmts.push(node);
      }
      return stmts;
    };

    const ifArmStmts = extractArmStatements(ifArmBlocks, ifArm);
    const elseArmStmts = isOneSided ? [] : extractArmStatements(elseArmBlocks, elseArm);
    const retainedArmJumpToJoin = [...ifArmStmts, ...elseArmStmts]
      .some((node) => textJumpsToAddress(node.text, joinAddress));

    // Build the structured nodes
    const headerNode = {
      kind: 'ctrl',
      indent: entryIndent,
      text: `if (${condText}) {`,
      row: term.row ?? entryBlock.startRow ?? null,
      addr: term.address ?? blockAddress(entryBlock, result.ir, opts),
      source: controlSource(term, entryBlock, result.ir, opts),
      semantic: { op: 'control-render', ir: term.id, expression: null },
    };

    const indentedIfStmts = ifArmStmts.map(n => ({
      ...n,
      indent: (n.indent ?? entryIndent) + 1,
    }));

    let middleNodes = [];
    if (!isOneSided) {
      const separatorNode = {
        kind: 'ctrl',
        indent: entryIndent,
        text: '} else {',
        row: null,
        addr: null,
        source: headerNode.source,
        semantic: { op: 'control-render', ir: term.id, expression: null },
      };
      const indentedElseStmts = elseArmStmts.map(n => ({
        ...n,
        indent: (n.indent ?? entryIndent) + 1,
      }));
      middleNodes = [separatorNode, ...indentedElseStmts];
    }

    const closeNode = {
      kind: 'ctrl',
      indent: entryIndent,
      text: '}',
      row: null,
      addr: null,
      source: headerNode.source,
      semantic: { op: 'control-render', ir: term.id, expression: null },
    };

    const structuredNodes = [
      headerNode,
      ...indentedIfStmts,
      ...middleNodes,
      closeNode,
    ];

    // Identify all nodes to remove from workingBody
    const nodesToRemove = new Set();
    // 1. Entry branch and false jump
    for (const node of workingBody) {
      const b = blockOfNode(node, result.ir, opts);
      if (b === entry && (node.kind === 'ctrl' || node.kind === 'stmt')) {
        if (node.text?.startsWith('if ') || node.text?.includes('goto loc_')) {
          nodesToRemove.add(node);
        }
      }
    }
    // 2. Arm nodes (statements were extracted and will be re-inserted)
    for (const node of workingBody) {
      if (isArmNode(node, armBlocks)) {
        nodesToRemove.add(node);
      }
    }
    // 3. Join label only when no rewritten or external jump still references it.
    if (!otherJumpsToJoin && !retainedArmJumpToJoin) {
      for (const node of workingBody) {
        if (isBlockLabel(node, join)) {
          nodesToRemove.add(node);
        }
      }
    }

    // Splice new structured nodes into workingBody at branchIndex
    const nextBody = [];
    let inserted = false;
    for (let i = 0; i < workingBody.length; i++) {
      const node = workingBody[i];
      if (i === branchIndex) {
        nextBody.push(...structuredNodes);
        inserted = true;
      }
      if (!nodesToRemove.has(node)) {
        nextBody.push(node);
      }
    }
    if (!inserted) {
      nextBody.push(...structuredNodes);
    }

    workingBody = nextBody;

    // Create and record transformation record
    const record = Object.freeze({
      rule: 'project-canonical-structured-conditional',
      phase: 'phase8-control-projection',
      before: isOneSided ? 'control:one-sided-conditional-goto' : 'control:diamond-conditional-goto',
      after: isOneSided ? 'control:one-sided-if' : 'control:if-else',
      evidence: Object.freeze({
        kind: 'canonical-structuring-facts-adoption',
        regionEntry: entry,
        regionJoin: join,
        regionForm: isOneSided ? 'one-sided-if' : 'if-else',
        detail: 'adopted reducible proven conditional region from Phase 8 canonical structuring facts; CFG edges and observable operations preserved',
      }),
      originHistory: expressionOriginHistory({ source: headerNode.source }, { source: headerNode.source }),
    });

    // Register line histories for provenance tracking
    registerSemanticControlLineHistory(headerNode, Object.freeze({
      ir: result.ir,
      instruction: term,
      canonical: { isCurrent: () => true },
      records: Object.freeze([record]),
      selection: Object.freeze({
        header: entry,
        yes: isOneSided ? (invert ? join : ifArm) : ifArm,
        no: isOneSided ? (invert ? ifArm : join) : elseArm,
        join,
        invert,
        form: isOneSided ? 'one-sided-if' : 'if-else',
      }),
      isCurrent: () => true,
    }));

    registerSemanticControlLineHistory(closeNode, Object.freeze({
      ir: result.ir,
      instruction: term,
      canonical: { isCurrent: () => true },
      records: Object.freeze([record]),
      isCurrent: () => true,
    }));

    adoptedRecords.push(record);
    adoptedRegions.push(region);
  }

  // Canonical natural loops. Same proof boundary as the conditional adoption
  // above: the loop regions published by structuring are the only candidates,
  // and a loop whose region, guard, latch, exit or edge accounting disagrees with
  // the induction proof is refused with the legacy representation left exactly
  // as it was.
  const loopOutcome = projectNaturalLoops(workingBody, {
    ir: result.ir,
    facts,
    cfg,
    dominators,
    induction: analysis.get('induction'),
    shouldAbort: () => opts.shouldAbort?.() === true,
    blockOfNode: (node) => blockOfNode(node, result.ir, opts),
    blockAddress: (index) => {
      const blocks = cfg?.blocks ?? result.ir.blocks ?? [];
      const block = blocks.find((candidate) => candidate?.index === index) ?? null;
      return block ? blockAddress(block, result.ir, opts) : null;
    },
    textJumpsToAddress,
    renderCondition: (term, invert) => renderBranchCondition(term, { ir: result.ir, types: result.types, opts }, invert),
    controlSource: (term, blockIndex) => controlSource(
      term,
      (cfg?.blocks ?? result.ir.blocks ?? []).find((candidate) => candidate?.index === blockIndex) ?? null,
      result.ir,
      opts,
    ),
  });
  // Cancellation is a transaction boundary for the whole projection. The loop
  // projector says so in the outcome it returns; if a conditional region was
  // already adopted, publishing that partial result would violate the
  // referential fail-closed contract. The predicate is checked again as well, for
  // an abort that lands after the loop stage returned.
  if (loopOutcome === LOOP_PROJECTION_CANCELLED || opts.shouldAbort?.() === true) return result;
  if (loopOutcome && loopOutcome.records.length > 0) {
    workingBody = loopOutcome.body;
    adoptedRecords.push(...loopOutcome.records);
    adoptedRegions.push(...loopOutcome.adopted);
  }

  if (adoptedRecords.length === 0) {
    return result; // No changes made; preserve referential equality
  }

  // Assemble updated result
  const newProgram = {
    ...result.cAst,
    body: workingBody,
    source: mergeSource(...workingBody.map(x => x.source).filter(Boolean)),
  };

  const printed = printProgram(newProgram, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
  const lines = newProgram.body.map((node, index) => ({
    kind: node.kind,
    indent: node.indent,
    text: node.text,
    row: node.source?.rows?.[0] ?? node.row ?? null,
    addr: node.source?.addresses?.[0] ?? node.addr ?? null,
    note: null,
    source: node.source,
  }));

  const updatedResult = {
    ...result,
    cAst: newProgram,
    lines,
    pseudocode: printed.text,
    sourceMap: printed.mapping,
    rewriteProof: [...(result.rewriteProof || []), ...adoptedRecords],
    metrics: {
      ...(result.metrics || {}),
      sourceMappedNodes: printed.mapping.length,
    },
  };
  // The label set has to describe the body that was actually emitted: a
  // consumer that reads it must not be handed handles the projection removed
  // (the adopted loop's guard and back-edge labels, for instance).
  if (result.labels instanceof Set) {
    updatedResult.labels = new Set(newProgram.body
      .filter((node) => node?.kind === 'label' && typeof node.text === 'string')
      .map((node) => node.text.replace(/:$/, '')));
  }

  if (result.phase8Projection) {
    updatedResult.phase8Projection = {
      ...result.phase8Projection,
      transformCount: (result.phase8Projection.transformCount || 0) + adoptedRecords.length,
      transforms: Object.freeze([...(result.phase8Projection.transforms || []), ...adoptedRecords]),
    };
  }

  const projectionMetadata = Object.freeze({
    version: STRUCTURED_CONTROL_PROJECTION_VERSION,
    ir: result.ir,
    adoptedRegions: Object.freeze(adoptedRegions),
    records: Object.freeze(adoptedRecords),
    completeness: 'complete',
    isCurrent: () => updatedResult.cAst === newProgram,
  });

  // Keep observer-bearing metadata entirely internal. Publishing it on the
  // result would cross the analysis-query DTO boundary with live functions.
  structuredControlProjections.set(newProgram, projectionMetadata);

  if (opts.renderProvenance === true) {
    // The map has to be bound to the analysis it was built from, exactly like the
    // expression projection binds its own (phase8/projection.js). Publishing an
    // unbound map makes every adopted construct look like an unverifiable edit:
    // the frozen corpus treats a missing snapshot id as a provenance loss.
    updatedResult.renderProvenance = buildRenderProvenance({
      result: updatedResult,
      snapshotId: currentId.identity?.snapshotId ?? null,
      budget: opts.renderProvenanceBudget,
      shouldAbort: opts.shouldAbort,
    });
  }

  return updatedResult;
}
