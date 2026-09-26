/*
 * Avoidable-goto closure for rendered C.
 *
 * The emitters in this package are deliberately conservative: when a source
 * structure is not proven they keep an explicit `goto`, which is the honest
 * answer.  This closure runs on the finished line array at the public-output
 * boundary and removes only the jumps that are *provably* redundant in the text
 * that is already there.  It never invents structure and never moves a jump: a
 * jump whose control flow cannot be shown redundant stays exactly where it is.
 *
 * Two invariants bound every rule, because the artifact is C a caller copies:
 * braces stay balanced, and a `loc_` label always still introduces a statement
 * (a label directly before the brace that closes its compound statement is not
 * C, so a rewrite that would produce one is refused, not emitted).
 *
 * Rules, each derived from structured execution of the text itself:
 *
 *   fallthrough  a `goto L;` whose target label is reached by scanning only
 *                label lines, comment lines, and `}` that complete a non-loop
 *                construct is a jump to the next statement.  It is dropped,
 *                and `L:` is dropped once no other goto addresses it.
 *   no-op branch the same holds for `if (C) goto L;` — but only when the
 *                condition is proven free of observable effects and free of
 *                operations that can fault (no call, store, volatile/atomic
 *                access, load, division or remainder) from the Semantic IR that
 *                produced the line.  Unknown provenance keeps the branch.
 *   guard block  `if (C) goto L;` followed by a label-free-to-`L` region in
 *                the same block scope becomes `if (!(C)) { region }`.  The
 *                region is only moved into a branch, never reordered: entering
 *                it from another label behaves exactly as falling into it did.
 *   if/else      `if (C) goto Lelse;` + then-region ending in `goto Lend;` +
 *                `Lelse:` + else-region + `Lend:` becomes `if (C) { else } else
 *                { then }`, the canonical two-sided form of the same edges.
 *   loop wrap    `L:` + region + `goto L;` where the region is one balanced
 *                scope of the jump and L is addressed by that jump alone
 *                becomes `while (1) { region }`.  Falling into the header runs
 *                the region and returns to the header, which is exactly what
 *                the trailing jump did; every other edge of the region is a
 *                `goto` out of the new block and keeps its meaning.  This is
 *                the one rule that needs facts the text alone cannot supply:
 *                the destination block of L must be the header of a natural
 *                loop whose latch is the block that rendered the jump, and the
 *                latch must be a proven back edge (the canonical control-flow
 *                analysis only records a latch when the header dominates it).
 *                Without those exact IR facts, or when the source line carries
 *                no provenance, the explicit goto stays.
 *
 * Everything else — backward conditional edges, jumps over several regions,
 * jumps whose label is not in the text, switch `case` jumps, backwards edges
 * whose block provenance is missing or whose stored label is addressed by more
 * than one jump — keeps its explicit goto.  An unstructured or irreducible
 * region stays honest.
 *
 * Cost model.  A pass classifies every line once (text, label, brace, indent,
 * walk class, significant-neighbour index, jump index) and every rule reads
 * that index instead of rescanning the array; target and jump lookups are
 * binary searches over precomputed index lists.  The pass is therefore linear
 * in the line count plus the size of the regions a rule actually adopts — the
 * previous revision rescanned the whole line array for every conditional jump
 * (`buildIfElse`) and rescanned forward from every label (`labelAtEndOfBlock`),
 * which made a goto-dense function quadratic.  `stats.scanSteps` publishes the
 * number of line visits any one run performed, which is what the cost
 * regression asserts on: it is deterministic and does not depend on host speed.
 */

import { OP } from '../ir.js';
import { mergeSource } from './ast/nodes.js';
import { readSemanticControlLineHistory } from './semantic-core.js';

const LABEL_RE = /^\s*(loc_[0-9a-fA-F]+)\s*:\s*$/;
const UNCOND_GOTO_RE = /^\s*goto\s+(loc_[0-9a-fA-F]+)\s*;\s*$/;
const COND_GOTO_RE = /^(\s*)if\s*\((.*)\)\s*goto\s+(loc_[0-9a-fA-F]+)\s*;\s*$/;
const ANY_GOTO_RE = /\bgoto\s+(loc_[0-9a-fA-F]+)\s*;/g;
const CASE_PREFIX_RE = /^\s*(?:case\b|default\b)/;
const COMMENT_RE = /^\s*\/\*.*\*\/\s*$/;
const LOOP_OPENER_RE = /^\s*(?:while|for)\s*\(|^\s*do\b/;
const KEYWORD_STATEMENT_RE = /^(?:break|continue)\s*;\s*$/;
const EDGE_WARNING_RE = /^(\d+) control-flow edge\(s\) remain explicit because a safe source structure was not proven\.$/;
const SIDE_EFFECT_OPS = new Set([OP.CALL, OP.STORE, OP.CLOBBER, OP.UNKNOWN, OP.RET, OP.BR, OP.CBR]);
// Dropping a redundant branch also drops the evaluation that produced the
// condition, so the proof must cover every way that evaluation can be observed.
// A load can fault on an address the IR does not bound, and integer division or
// remainder traps on a zero divisor: neither may disappear with the branch.
const MAY_FAULT_OPS = new Set([OP.LOAD]);
const MAY_FAULT_BIN_SUBS = new Set(['sdiv', 'udiv', 'div', 'srem', 'urem', 'rem', 'smod', 'umod', 'mod']);

// Line classes for the forward walk rule (1)/(2).  A walk from a jump either
// skips the line, compares it as a label, or stops.
const WALK_SKIP = 0;
const WALK_LABEL = 1;
const WALK_STOP = 2;

const MAX_PASSES = 64;
const MAX_LOOP_WRAP_ROUNDS = 512;
// A candidate region is walked line by line, because "the braces balance and
// nothing leaves the scope" is not a property of a line but of the whole span.
// The walk is bounded so a pathological jump — an unbalanced or outdented span
// that is refused only at its last line — cannot put back the quadratic cost
// this revision removed.  A region larger than this is refused, not guessed.
const MAX_REGION_WALK = 256;

function textOf(line) {
  return typeof line?.text === 'string' ? line.text : '';
}

function labelNameOf(line) {
  const match = LABEL_RE.exec(textOf(line));
  return match ? match[1] : null;
}

/**
 * Indentation of a rendered line.  Producers keep the indentation in the
 * `indent` field and the printers are the only thing that turns it into leading
 * whitespace (`printProgram`, `renderedText`, `pseudocode`), so the text itself
 * is not indented.  Reading the text here would see depth 0 for every real line
 * and make both the region refusals and the emitted header indentation wrong.
 * The text is only a fallback for hand-built input.
 */
function indentOf(line) {
  if (Number.isFinite(line?.indent)) return Math.max(0, Math.trunc(line.indent));
  return /^\s*/.exec(textOf(line))[0].length;
}

/** Braces are counted on code only: comments and string bodies never open a block. */
function stripNonCode(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Braces can only be lost by `stripNonCode` when the line actually carries a
 * brace character, so a line without one never needs the two replacement passes.
 * Most rendered lines are in that class, which is what keeps the per-pass brace
 * scans from paying a regex per line.
 */
function mayCarryBraces(text) {
  return text.includes('{') || text.includes('}');
}

/**
 * For every `}` line, the text of the construct it closes.  Null when the line
 * closes nothing (unbalanced input), which the callers treat as "not provable".
 */
function closerOpenerTexts(lines) {
  const stack = [];
  const openers = new Array(lines.length).fill(null);
  for (let index = 0; index < lines.length; index += 1) {
    const text = textOf(lines[index]);
    if (!mayCarryBraces(text)) continue;
    const code = stripNonCode(text);
    for (const character of code) {
      if (character === '{') stack.push(text);
      else if (character === '}') openers[index] = stack.pop() ?? null;
    }
  }
  return openers;
}

function isCloserText(text) {
  return text.trim() === '}';
}

/**
 * A line that closes a compound statement, including `} else {` and the
 * `} while (...);` of a `do` loop.  A label may only introduce a statement, so
 * placing one of these directly after a label is not C.
 */
function startsWithCloseBrace(value) {
  return /^\s*\}/.test(typeof value === 'string' ? value : textOf(value));
}

function gotoTargetsIn(text) {
  const targets = [];
  ANY_GOTO_RE.lastIndex = 0;
  let match;
  while ((match = ANY_GOTO_RE.exec(text)) !== null) targets.push(match[1].toLowerCase());
  return targets;
}

/** Smallest element of a sorted ascending number list that is > value, or null. */
function firstIndexGreaterThan(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] > value) high = middle;
    else low = middle + 1;
  }
  return low < sorted.length ? sorted[low] : null;
}

/**
 * One classification of a line array.  Every rule in a pass reads this instead
 * of rescanning the text, so a pass visits each line a bounded number of times.
 * A pass that adopts a region still walks that region, which is the work the
 * rewrite is defined by; everything else (target lookup, jump lookup, "does the
 * next statement close a block", "does this label strand") is O(1)/O(log n).
 */
function analyzeLines(lines) {
  const count = lines.length;
  const info = {
    lines, count, steps: 0,
    raw: new Array(count), trim: new Array(count), indent: new Array(count),
    labelRaw: new Array(count), labelLower: new Array(count),
    uncond: new Array(count), cond: new Array(count),
    gotoTargets: new Array(count),
    blank: new Uint8Array(count), comment: new Uint8Array(count), closer: new Uint8Array(count),
    labelKind: new Uint8Array(count), caseLine: new Uint8Array(count), keywordLine: new Uint8Array(count),
    walk: new Uint8Array(count), walkStops: [],
    prevSig: new Int32Array(count), nextSig: new Int32Array(count + 1),
    nextLabel: new Int32Array(count), nextUncond: new Int32Array(count),
    braceCache: new Array(count),
    occurrences: new Map(), labelAt: new Map(), jumpsTo: new Map(),
  };
  const openers = closerOpenerTexts(lines);
  for (let index = 0; index < count; index += 1) {
    info.steps += 1;
    const line = lines[index];
    const text = textOf(line);
    const trimmed = text.trim();
    info.raw[index] = text;
    info.trim[index] = trimmed;
    info.indent[index] = indentOf(line);
    if (!trimmed) info.blank[index] = 1;
    else if (COMMENT_RE.test(trimmed)) info.comment[index] = 1;
    if (trimmed) {
      if (CASE_PREFIX_RE.test(trimmed)) info.caseLine[index] = 1;
      else if (KEYWORD_STATEMENT_RE.test(trimmed)) info.keywordLine[index] = 1;
    }
    const label = LABEL_RE.exec(text);
    if (label) {
      info.labelRaw[index] = label[1];
      info.labelLower[index] = label[1].toLowerCase();
      info.occurrences.set(info.labelLower[index], (info.occurrences.get(info.labelLower[index]) ?? 0) + 1);
      const at = info.labelAt.get(info.labelLower[index]);
      if (at) at.push(index); else info.labelAt.set(info.labelLower[index], [index]);
    }
    info.labelKind[index] = line?.kind === 'label' ? 1 : 0;
    info.closer[index] = trimmed === '}' ? 1 : 0;
    const targets = gotoTargetsIn(text);
    info.gotoTargets[index] = targets;
    for (const target of targets) {
      const at = info.jumpsTo.get(target);
      if (at) at.push(index); else info.jumpsTo.set(target, [index]);
    }
    info.uncond[index] = UNCOND_GOTO_RE.exec(text);
    info.cond[index] = COND_GOTO_RE.exec(text);
    const transparent = info.labelKind[index] === 1 || info.comment[index] === 1
      || (info.closer[index] === 1 && openers[index] != null && !LOOP_OPENER_RE.test(openers[index]));
    if (info.blank[index]) info.walk[index] = WALK_SKIP;
    else if (info.labelLower[index] != null) info.walk[index] = WALK_LABEL;
    else if (info.comment[index]) info.walk[index] = WALK_SKIP;
    else if (transparent) info.walk[index] = mayCarryBraces(text) && stripNonCode(text).includes('{') ? WALK_STOP : WALK_SKIP;
    else info.walk[index] = WALK_STOP;
    if (info.walk[index] === WALK_STOP) info.walkStops.push(index);
  }
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    if (!info.blank[index] && !info.comment[index]) previous = index;
    info.prevSig[index] = previous;
  }
  let next = count;
  info.nextSig[count] = count;
  for (let index = count - 1; index >= 0; index -= 1) {
    if (!info.blank[index] && !info.comment[index]) next = index;
    info.nextSig[index] = next;
  }
  // The next label line and the next full-line `goto`, per position.  The
  // if/else shape is decided by which of the two comes first, so the rule can
  // reject the vast majority of conditional jumps without walking a region.
  let nextLabel = count;
  let nextUncond = count;
  for (let index = count - 1; index >= 0; index -= 1) {
    info.nextLabel[index] = nextLabel;
    info.nextUncond[index] = nextUncond;
    if (info.labelLower[index] != null) nextLabel = index;
    if (info.uncond[index]) nextUncond = index;
  }
  return info;
}

/** Cached brace delta sequence of a line, in text order.  Null when it has none. */
function braceSeqOf(info, index) {
  const cached = info.braceCache[index];
  if (cached !== undefined) return cached;
  let seq = null;
  if (mayCarryBraces(info.raw[index])) {
    for (const character of stripNonCode(info.raw[index])) {
      if (character === '{' || character === '}') (seq ??= []).push(character === '{' ? 1 : -1);
    }
  }
  info.braceCache[index] = seq;
  return seq;
}

/**
 * The label-introduces-a-statement invariant: every `loc_` label must be
 * followed, through other labels, blank lines and comments, by an actual
 * statement inside the same compound statement.  A rewrite that leaves `L: }`
 * behind publishes C that does not parse, so the closure refuses to publish it.
 *
 * One backward sweep answers it for every label at once: `nextTrivial` is the
 * next line that is not blank, comment, label or `case`, and the recurrence
 * that "the first non-trivial line starts with `}`" is evaluated from the end.
 * The previous revision rescanned forward from every label, which is quadratic
 * on a label-dense body.
 */
function labelAtEndOfBlock(lines, info = null) {
  const state = info ?? analyzeLines(lines);
  const count = state.count;
  const violationFrom = new Uint8Array(count + 1);
  for (let index = count - 1; index >= 0; index -= 1) {
    state.steps += 1;
    const trivial = state.blank[index] === 1 || state.comment[index] === 1
      || state.labelLower[index] != null || state.caseLine[index] === 1;
    violationFrom[index] = trivial ? violationFrom[index + 1]
      : (startsWithCloseBrace(state.raw[index]) ? 1 : 0);
  }
  for (let index = 0; index < count; index += 1) {
    state.steps += 1;
    if (state.labelLower[index] == null) continue;
    // Running out of lines proves nothing: an isolated line array is a fragment
    // and the brace that closes it may simply not be part of the input.
    if (violationFrom[index + 1]) return true;
  }
  return false;
}

/** The last line of a plain line list is a label, so closing a block after it is not C. */
function regionEndsWithLabel(regionLines) {
  for (let index = regionLines.length - 1; index >= 0; index -= 1) {
    const text = textOf(regionLines[index]).trim();
    if (!text || COMMENT_RE.test(text)) continue;
    return labelNameOf(regionLines[index]) != null;
  }
  return false;
}

/**
 * Index of the target label when every line between the jump and the label is
 * transparent for that jump, otherwise null.  Duplicate label names are refused
 * outright: textual jumping means "the first definition", which a duplicated
 * name cannot name.
 *
 * The walk can only end at the first stopping line or at the label, so the
 * question reduces to "which of the two comes first": both are precomputed
 * index lists, so this is a pair of binary searches rather than a rescan.
 */
function transparentTargetIndex(info, from, target) {
  if ((info.occurrences.get(target) ?? 0) !== 1) return null;
  const at = info.labelAt.get(target)?.[0] ?? null;
  if (at == null || at <= from) return null;
  const stop = firstIndexGreaterThan(info.walkStops, from);
  if (stop != null && stop < at) return null;
  return at;
}

/**
 * Index of the target label when the lines between the jump and the label form
 * one balanced block scope of the jump itself.  Returns null when the region
 * closes a construct the jump is inside, leaves it, or crosses a switch case
 * entry — none of which a plain wrap can express.
 */
function guardRegionIndex(info, from, target) {
  if ((info.occurrences.get(target) ?? 0) !== 1) return null;
  const end = info.labelAt.get(target)?.[0] ?? null;
  if (end == null || end <= from) return null;
  if (end - from - 1 > MAX_REGION_WALK) return null;
  const base = info.indent[from];
  let depth = 0;
  let statements = 0;
  for (let index = from + 1; index < end; index += 1) {
    info.steps += 1;
    if (info.blank[index]) continue;
    const name = info.labelLower[index];
    if (name != null) continue;
    if (info.comment[index]) continue;
    if (info.caseLine[index]) return null;
    if (!info.labelKind[index] && info.indent[index] < base) return null;
    const seq = braceSeqOf(info, index);
    if (seq) {
      for (const delta of seq) {
        depth += delta;
        if (depth < 0) return null;
      }
    }
    statements += 1;
  }
  if (depth !== 0 || statements <= 0) return null;
  // The generated `}` closes right after the region, so a region whose tail
  // is a label would leave `L: }` — a label that introduces no statement.
  // Such a region is not wrappable; the jump stays explicit.
  const last = info.prevSig[end - 1];
  if (last >= from + 1 && info.labelLower[last] != null) return null;
  return end;
}

/**
 * Freedom from observable effects and from faults, proven from the Semantic IR
 * that rendered the branch line.  Removing the line removes the evaluation, so
 * every operation the condition depends on has to be observational-free,
 * fault-free and total:
 *
 *   - no write, call, clobber, unresolved operation or nested control transfer;
 *   - no volatile or atomic access, read or written;
 *   - no memory load and no division or remainder (see MAY_FAULT_* above).
 *
 * Unknown or missing provenance is not permission: the goto stays.  The walk
 * follows the same operand list the renderer used (`instruction.args`), and an
 * empty operand list proves nothing about what the condition evaluates.
 */
function conditionIsProvenPure(line, ir) {
  const control = readSemanticControlLineHistory(line, ir);
  const instruction = control?.instruction;
  if (!ir || !instruction || instruction.op !== OP.CBR) return false;
  const operands = Array.isArray(instruction.args) ? instruction.args : null;
  if (!operands?.length) return false;
  const pending = [...operands];
  const seen = new Set();
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > 4096) return false;
    const raw = pending.pop();
    const value = raw && typeof raw === 'object' && raw.value !== undefined ? raw.value : raw;
    if (!value || typeof value !== 'object') continue;
    if (value.volatile === true || value.atomic === true) return false;
    const definition = value.def;
    if (!definition || seen.has(definition)) continue;
    seen.add(definition);
    if (definition.volatile === true || definition.atomic === true
      || definition.extra?.volatile === true || definition.extra?.atomic === true) return false;
    if (SIDE_EFFECT_OPS.has(definition.op) || MAY_FAULT_OPS.has(definition.op)) return false;
    if (definition.op === OP.BIN && MAY_FAULT_BIN_SUBS.has(String(definition.sub ?? '').toLowerCase())) return false;
    for (const argument of definition.args || []) pending.push(argument);
    for (const incoming of definition.incoming || []) pending.push(incoming?.value ?? null);
  }
  return true;
}

function shiftLines(lines, delta) {
  return lines.map((line) => (textOf(line).trim() ? { ...line, indent: Math.max(0, (line.indent ?? indentOf(line)) + delta) } : line));
}

function structuralLine(indent, kind, text, source) {
  return { kind, indent, text, row: null, addr: null, note: null, source };
}

/**
 * One closure pass over rules (1), (2) and the if/else pair.  Returns the lines
 * of this pass plus what it changed; a pass that changes nothing reports
 * `progress: false` and ends the fixpoint.
 */
function closurePass(result) {
  const lines = result.lines;
  const ir = result.ir;
  const info = analyzeLines(lines);
  const raw = info.raw;
  const out = [];
  const stats = { removedGotos: 0, removedLabels: 0, guardBlocks: 0, ifElseRegions: 0, loopWraps: 0 };
  let index = 0;

  const push = (...added) => { for (const line of added) out.push(line); };
  const drop = () => { stats.removedGotos += 1; };

  while (index < lines.length) {
    info.steps += 1;
    const text = raw[index];
    const uncond = info.uncond[index];
    const cond = info.cond[index];
    const isJump = (uncond || (cond && !info.caseLine[index])) && info.gotoTargets[index].length === 1;
    if (!isJump) { push(lines[index]); index += 1; continue; }

    const target = (uncond ? uncond[1] : cond[3]).toLowerCase();

    // --- if/else: two-sided region pair sharing one join -------------------
    const ifElse = buildIfElse({ lines, info, index, cond, target });
    if (ifElse) {
      push(...ifElse.lines);
      stats.removedGotos += ifElse.gotos;
      stats.ifElseRegions += 1;
      index = ifElse.next;
      continue;
    }

    // --- guard block: skip forward over one region -------------------------
    if (cond) {
      const end = guardRegionIndex(info, index, target);
      if (end != null) {
        const header = structuralLine(info.indent[index], 'ctrl', `if (!(${cond[2]})) {`,
          mergeSource(lines[index].source, lines[end].source));
        const footer = structuralLine(info.indent[index], 'ctrl', '}', mergeSource(lines[index].source, lines[end].source));
        push(header, ...shiftLines(lines.slice(index + 1, end), 1), footer, lines[end]);
        drop(); stats.guardBlocks += 1;
        index = end + 1;
        continue;
      }
    }

    // --- no-op branch / fallthrough jump ----------------------------------
    const end = transparentTargetIndex(info, index, target);
    if (end != null) {
      // Only the jump is dropped here; the label is re-examined by the orphan
      // sweep below so a jump from elsewhere keeps it.
      if (cond && !conditionIsProvenPure(lines[index], ir)) { push(lines[index]); index += 1; continue; }
      // A label introduces a statement.  When the jump is the only statement
      // its own block gave its label, removing the jump would leave `L: }`,
      // which is not C: the honest explicit jump stays instead.
      const before = info.prevSig[index - 1] ?? -1;
      const after = info.nextSig[index + 1] ?? lines.length;
      if (after < end && startsWithCloseBrace(info.raw[after]) && before >= 0 && info.labelLower[before] != null) {
        push(lines[index]); index += 1; continue;
      }
      // Only the jump line goes away: the transparent lines it skips over are
      // labels, comments and construct closers that still have to be there.
      drop();
      push(...lines.slice(index + 1, end));
      index = end;
      continue;
    }

    push(lines[index]);
    index += 1;
  }

  // --- orphan labels: nothing addresses them any more -----------------------
  const remaining = new Set();
  for (const line of out) for (const target of gotoTargetsIn(textOf(line))) remaining.add(target);
  info.steps += out.length;
  const kept = out.filter((line) => {
    const name = labelNameOf(line);
    const lower = name == null ? null : name.toLowerCase();
    if (lower == null || remaining.has(lower)) return true;
    stats.removedLabels += 1;
    return false;
  });

  const progress = stats.removedGotos > 0 || stats.removedLabels > 0
    || stats.guardBlocks > 0 || stats.ifElseRegions > 0;
  return { lines: kept, stats, progress, steps: info.steps };
}

/**
 * `if (C) goto Lelse;` / then-region ending in `goto Lend;` / `Lelse:` /
 * else-region / `Lend:`.  Both regions must be single balanced scopes of the
 * jump with no switch entry, and neither label may be addressed from outside,
 * so the rewrite cannot capture a jump that was aiming somewhere else.
 */
function buildIfElse({ lines, info, index, cond, target }) {
  if (!cond) return null;
  const base = info.indent[index];
  // The two-sided shape needs a `goto Lend;` before the first label line, and
  // the join label to be exactly the target.  Both are index lookups, so a
  // conditional jump with no such tail costs O(1) instead of a region walk.
  const tail = info.nextUncond[index];
  const firstLabel = info.nextLabel[index];
  if (tail >= lines.length || tail <= index) return null;
  if (firstLabel < tail) return null;
  if (tail - index > MAX_REGION_WALK) return null;
  if (info.labelLower[tail + 1] !== target) return null;

  let end = index + 1;
  const thenLines = [];
  let depth = 0;
  let tailIndex = -1;
  for (; end < lines.length; end += 1) {
    info.steps += 1;
    if (info.blank[end]) continue;
    if (info.labelLower[end] != null) break;
    if (info.caseLine[end] || info.indent[end] < base) return null;
    const seq = braceSeqOf(info, end);
    if (seq) {
      for (const delta of seq) {
        depth += delta;
        if (depth < 0) return null;
      }
    }
    if (depth !== 0) return null;
    thenLines.push(lines[end]);
    if (info.uncond[end]) { tailIndex = end; end += 1; break; }
    if (end - index > MAX_REGION_WALK) return null;
  }
  const tailJump = tailIndex >= 0 ? info.uncond[tailIndex] : null;
  if (!tailJump) return null;
  const joinLabel = info.labelLower[end] ?? null;
  if (joinLabel == null || joinLabel !== target) return null;

  const join = tailJump[1].toLowerCase();
  if ((info.occurrences.get(join) ?? 0) !== 1 || (info.occurrences.get(target) ?? 0) !== 1) return null;
  // The else region ends at the first label after the join label, and that
  // label has to be the join of the pair; anything else is refused without
  // walking the region.
  const joinAt = info.labelAt.get(join)?.[0] ?? null;
  if (joinAt == null || info.nextLabel[end] !== joinAt) return null;
  if (joinAt - end > MAX_REGION_WALK) return null;

  const elseLines = [];
  let close = end + 1;
  depth = 0;
  for (; close < lines.length; close += 1) {
    info.steps += 1;
    if (info.blank[close]) continue;
    const name = info.labelLower[close];
    if (name != null) {
      if (name === join) break;
      return null;
    }
    if (info.caseLine[close] || info.indent[close] < base) return null;
    const seq = braceSeqOf(info, close);
    if (seq) {
      for (const delta of seq) {
        depth += delta;
        if (depth < 0) return null;
      }
    }
    if (depth !== 0) return null;
    elseLines.push(lines[close]);
    if (close - end > MAX_REGION_WALK) return null;
  }
  const endLabel = info.labelLower[close] ?? null;
  if (endLabel == null || endLabel !== join || !elseLines.length || !thenLines.length) return null;
  // Each region becomes the tail of a new compound statement, so neither may end
  // on a label: the canonical two-sided form would otherwise emit `L: }`.
  if (regionEndsWithLabel(elseLines) || regionEndsWithLabel(thenLines.slice(0, -1))) return null;

  // Both labels must be private to this pair: a jump from outside would land
  // inside a branch that no longer matches the original ordering.  The pair's
  // own two jumps are the only admitted addresses.
  if (addressesOf(info, target) !== index) return null;
  if (addressesOf(info, join) !== tailIndex) return null;

  const source = mergeSource(lines[index].source, lines[close].source);
  const header = { kind: 'ctrl', indent: base, text: `if (${cond[2]}) {`, row: null, addr: null, note: null, source };
  const separator = { kind: 'ctrl', indent: base, text: '} else {', row: null, addr: null, note: null, source };
  const footer = { kind: 'ctrl', indent: base, text: '}', row: null, addr: null, note: null, source };
  return {
    lines: [
      header,
      ...shiftLines(elseLines, 1),
      separator,
      ...shiftLines(thenLines.slice(0, -1), 1),
      footer,
    ],
    gotos: 2,
    next: close + 1,
  };
}

/** The single line index that addresses `target`, or null when it is not unique. */
function addressesOf(info, target) {
  const jumps = info.jumpsTo.get(target);
  return Array.isArray(jumps) && jumps.length === 1 ? jumps[0] : null;
}

/**
 * The proof that a backward jump is the latch of a natural loop, taken from the
 * canonical IR the line was rendered from — never from the text:
 *
 *   - the label line keeps its canonical control/branch provenance, so the
 *     label is the entry of a known block and its published address agrees with
 *     the address spelled in the label name;
 *   - the jump line keeps the canonical instruction that emitted it, so the
 *     source is a known block;
 *   - that block is a *latch* of a loop whose header is the label block.  The
 *     loop record is materialized by the control-flow analysis from proven back
 *     edges (`header dominates latch` inside one SCC), and when the analysis
 *     also publishes dominator sets the containment is re-checked here.
 *
 * Anything missing — no history, no selection, no loop, more than one latch —
 * is not a proof, and the goto stays explicit.
 */
function backwardLoopProof(ir, info, labelIndex, jumpIndex) {
  if (!ir) return false;
  const labelLine = info.lines[labelIndex];
  const jumpLine = info.lines[jumpIndex];
  const labelControl = readSemanticControlLineHistory(labelLine, ir);
  const header = labelControl?.selection?.target;
  if (!Number.isInteger(header)) return false;
  // The label name spells the block address the renderer published; a label
  // whose address does not agree with its own name is not a block identity.
  const declared = labelLine?.addr;
  if (declared == null) return false;
  let spelled;
  try {
    // The published spelling is `loc_<hex address>`; the address hex is the
    // only part that identifies the block.
    spelled = BigInt(`0x${info.labelRaw[labelIndex].replace(/^loc_/i, '')}`);
  } catch { return false; }
  let address;
  try {
    address = BigInt(declared);
  } catch { return false; }
  if (spelled !== address) return false;
  const jumpControl = readSemanticControlLineHistory(jumpLine, ir);
  const instruction = jumpControl?.instruction;
  const latch = instruction?.block;
  if (!Number.isInteger(latch)) return false;
  const blocks = ir.blocks;
  if (Array.isArray(blocks) && blocks[header] == null) return false;
  const loops = ir.loops;
  let proven = false;
  if (Array.isArray(loops)) {
    for (const loop of loops) {
      if (!loop || loop.header !== header) continue;
      const latches = loop.latches;
      if (latches instanceof Set ? latches.has(latch)
        : Array.isArray(latches) ? latches.includes(latch) : false) { proven = true; break; }
    }
  }
  if (!proven && Array.isArray(ir.backEdges)) {
    proven = ir.backEdges.some((edge) => edge?.from === latch && edge?.to === header);
  }
  if (!proven) return false;
  const dominators = ir.dominators;
  if (Array.isArray(dominators)) return dominators[header]?.has?.(latch) === true;
  return true;
}

/**
 * Shape test for the loop wrap: `L:` and the backward `goto L;` share one
 * labelled block — the emitters put the label at the block's indentation and
 * the block's own statements (including the closing jump) one level deeper —
 * the region between them is one balanced scope that never leaves that block,
 * the label is the only address of the jump, and the region tail after the
 * jump is removed is a real statement (not a label, which would be `L: }`) and
 * not a bare `break`/`continue` (which would silently change which loop it
 * belongs to once the region becomes a body).
 *
 * The region keeps its own indentation in the emitted body: it is already at
 * the header's body level, so nothing is re-indented except what the wrap adds.
 */
function loopWrapCandidate(info, labelIndex) {
  const name = info.labelLower[labelIndex];
  if (name == null) return null;
  if ((info.occurrences.get(name) ?? 0) !== 1) return null;
  const jumps = info.jumpsTo.get(name);
  if (!Array.isArray(jumps) || !jumps.length) return null;
  // Two emitters shape a labelled block differently: the structured emitter
  // indents the block's statements one level under its label, and the faithful
  // CFG emitter keeps them at the label's own level.  Both are a plain labelled
  // block; only the amount the body has to move into the new loop differs.
  const base = info.indent[labelIndex];
  let jumpIndex = -1;
  let shift = 0;
  for (const at of jumps) {
    if (at <= labelIndex) continue;
    if (jumpIndex >= 0) return null;
    jumpIndex = at;
  }
  if (jumpIndex < 0) return null;
  if (info.labelKind[jumpIndex] !== 0) return null;
  const uncond = info.uncond[jumpIndex];
  if (!uncond || uncond[1].toLowerCase() !== name) return null;
  if (info.gotoTargets[jumpIndex].length !== 1) return null;
  const body = info.indent[jumpIndex];
  if (body !== base && body !== base + 1) return null;
  shift = body === base ? 1 : 0;
  if (jumpIndex - labelIndex - 1 > MAX_REGION_WALK) return null;
  let depth = 0;
  for (let index = labelIndex + 1; index < jumpIndex; index += 1) {
    info.steps += 1;
    if (info.blank[index]) continue;
    if (info.labelLower[index] != null) continue;
    if (info.comment[index]) continue;
    if (info.caseLine[index]) return null;
    if (!info.labelKind[index] && info.indent[index] < body) return null;
    if (info.keywordLine[index]) return null;
    const seq = braceSeqOf(info, index);
    if (seq) {
      for (const delta of seq) {
        depth += delta;
        if (depth < 0) return null;
      }
    }
  }
  if (depth !== 0) return null;
  const last = info.prevSig[jumpIndex - 1];
  if (last >= labelIndex + 1 && info.labelLower[last] != null) return null;
  // A label another jump still addresses has to stay: the loop is entered from
  // above as well, and a jump into the top of the new block means exactly what
  // the jump to the label meant.  A label nothing else addresses is dropped with
  // the jump it existed for.
  const keepLabel = jumps.some((at) => at !== jumpIndex);
  return { name, labelIndex, jumpIndex, base, shift, keepLabel };
}

function wrapLoop(lines, candidate) {
  const source = mergeSource(lines[candidate.labelIndex].source, lines[candidate.jumpIndex].source);
  const header = structuralLine(candidate.base, 'ctrl', 'while (1) {', source);
  const footer = structuralLine(candidate.base, 'ctrl', '}', source);
  return [
    ...lines.slice(0, candidate.labelIndex),
    ...(candidate.keepLabel ? [lines[candidate.labelIndex]] : []),
    header,
    ...shiftLines(lines.slice(candidate.labelIndex + 1, candidate.jumpIndex), candidate.shift),
    footer,
    ...lines.slice(candidate.jumpIndex + 1),
  ];
}

/**
 * Rule (3): close the backward edges the IR proves are natural-loop latches.
 *
 * A wrap re-derives the line index after every accepted wrap — a kept label
 * adds a line — so no rule ever reads a stale indentation.  Labels are visited
 * from the end of the body so an inner loop is adopted before the outer region
 * that contains it.
 */
function wrapBackwardLoops(lines, ir, shouldAbort) {
  const stats = { loopWraps: 0, loopCandidates: 0, refusedLoopProof: 0, scanSteps: 0, rounds: 0 };
  let current = lines;
  for (let round = 0; round < MAX_LOOP_WRAP_ROUNDS; round += 1) {
    if (shouldAbort?.()) break;
    const info = analyzeLines(current);
    let wrapped = false;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      if (shouldAbort?.()) break;
      if (info.labelLower[index] == null) continue;
      const candidate = loopWrapCandidate(info, index);
      if (!candidate) continue;
      stats.loopCandidates += 1;
      if (!backwardLoopProof(ir, info, index, candidate.jumpIndex)) {
        stats.refusedLoopProof += 1;
        continue;
      }
      current = wrapLoop(current, candidate);
      stats.loopWraps += 1;
      stats.scanSteps += info.steps;
      stats.rounds += 1;
      wrapped = true;
      break;
    }
    if (!wrapped) { stats.scanSteps += info.steps; stats.rounds += 1; break; }
  }
  return { lines: current, stats };
}

/**
 * Drop provably redundant gotos (and the labels they were the last reason to
 * keep) from a finished semantic result.  Returns the same object untouched
 * when nothing is provable, so callers keep their identity-sensitive checks.
 *
 * `opts.onLinesChanged(result)` is called once when the line array changed, so
 * a caller holding an index-keyed derived artifact can refresh it; a result
 * that already publishes a render-provenance map is left untouched unless that
 * hook is supplied.
 */
export function eliminateAvoidableGotos(result, opts = {}, stats = null) {
  const totals = { removedGotos: 0, removedLabels: 0, guardBlocks: 0, ifElseRegions: 0,
    loopWraps: 0, loopCandidates: 0, refusedLoopProof: 0, passes: 0, refusedPasses: 0, scanSteps: 0 };
  // `stats` is a pure out-parameter for the caller's own accounting (the cost
  // regression reads `scanSteps`); it is filled on every exit, including the
  // refusals, so a measurement never has to infer why nothing happened.
  const finish = (value) => {
    if (stats) Object.assign(stats, totals);
    return value;
  };
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length < 2 || !result?.ir || !result?.semantic) return finish(result);
  if (opts.shouldAbort?.() === true) return finish(result);
  // A published render-provenance map is indexed over the lines it was built
  // from.  Changing the line array underneath it would publish a stale map, so
  // the closure refuses to run once one exists unless the caller supplies the
  // same refresh hook the other final-output closures use
  // (js/decompiler/c-output-closure.js `onLinesChanged`).  Without the hook the
  // map would be stale, and a stale map is worse than an honest goto.
  if (result.renderProvenance && typeof opts.onLinesChanged !== 'function') return finish(result);

  // The published text already renders a label with no statement under one
  // compound statement somewhere.  That is the producer's own defect, out of
  // this closure's scope, and nothing here may be published on top of it: the
  // line array passes through untouched.
  const entryInfo = analyzeLines(lines);
  totals.scanSteps += entryInfo.steps;
  if (labelAtEndOfBlock(lines, entryInfo)) return finish(result);
  // No jump and no label means no rule in this file can change a line; most
  // published functions are in that class, so the pass is skipped outright.
  let hasRuleInput = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (entryInfo.gotoTargets[index].length || entryInfo.labelLower[index] != null) { hasRuleInput = true; break; }
  }
  if (!hasRuleInput) return finish(result);
  let current = lines;

  const runTextFixpoint = () => {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      if (opts.shouldAbort?.() === true) return;
      const outcome = closurePass({ ...result, lines: current });
      totals.passes += 1;
      totals.scanSteps += outcome.steps;
      // A rewrite that would publish a label without a statement is a bug in the
      // rule that produced it, not a licence to emit the label.  The whole pass
      // is discarded and the fixpoint stops at the last text that was provably C.
      if (labelAtEndOfBlock(outcome.lines)) { totals.refusedPasses += 1; return; }
      totals.removedGotos += outcome.stats.removedGotos;
      totals.removedLabels += outcome.stats.removedLabels;
      totals.guardBlocks += outcome.stats.guardBlocks;
      totals.ifElseRegions += outcome.stats.ifElseRegions;
      totals.loopWraps += outcome.stats.loopWraps;
      current = outcome.lines;
      if (!outcome.progress) return;
    }
  };

  // Text rules first, so their IR-bound proofs (the pure-condition no-op
  // branch) still see the original line objects; then the IR-proven loop wraps;
  // then one more text fixpoint for the text the wraps rewrote.
  runTextFixpoint();
  const wrap = wrapBackwardLoops(current, result.ir, opts.shouldAbort);
  totals.loopWraps += wrap.stats.loopWraps;
  totals.loopCandidates += wrap.stats.loopCandidates;
  totals.refusedLoopProof += wrap.stats.refusedLoopProof;
  totals.scanSteps += wrap.stats.scanSteps;
  current = wrap.lines;
  if (wrap.stats.loopWraps > 0) {
    const afterWrap = analyzeLines(current);
    totals.scanSteps += afterWrap.steps;
    if (!labelAtEndOfBlock(current, afterWrap)) runTextFixpoint();
    else totals.refusedPasses += 1;
  }
  if (current === lines || (totals.removedGotos === 0 && totals.removedLabels === 0
      && totals.guardBlocks === 0 && totals.ifElseRegions === 0 && totals.loopWraps === 0)) return finish(result);

  const text = current.map((line) => textOf(line)).join('\n');
  const residualGotos = (text.match(/\bgoto\b/g) ?? []).length;
  const warnings = [];
  for (const warning of result.warnings || []) {
    const edge = EDGE_WARNING_RE.exec(warning);
    if (!edge) { warnings.push(warning); continue; }
    // The claim is only true while something is still explicit: republish the
    // counted residual, or drop the warning when the closure emptied it.
    if (residualGotos === 0) continue;
    warnings.push(`${residualGotos} control-flow edge(s) remain explicit because a safe source structure was not proven.`);
  }

  const updated = {
    ...result,
    lines: current,
    pseudocode: current.map((line) => `${'    '.repeat(Math.max(0, line.indent || 0))}${textOf(line)}`).join('\n'),
    warnings,
  };
  if (result.labels instanceof Set) {
    updated.labels = new Set(current.filter((line) => line?.kind === 'label').map((line) => textOf(line).replace(/:$/, '')));
  }
  // The line array changed, so any derived artifact the caller holds — an
  // index-keyed render-provenance map in particular — is refreshed by the
  // caller's own hook, exactly as closeFunctionOutput does it.
  if (typeof opts.onLinesChanged === 'function') opts.onLinesChanged(updated);
  return finish(updated);
}
