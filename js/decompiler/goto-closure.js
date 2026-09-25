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
 *
 * Everything else — backward edges, jumps over several regions, jumps whose
 * label is not in the text, switch `case` jumps — keeps its explicit goto.
 * An unstructured or irreducible region stays honest.
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
const EDGE_WARNING_RE = /^(\d+) control-flow edge\(s\) remain explicit because a safe source structure was not proven\.$/;
const SIDE_EFFECT_OPS = new Set([OP.CALL, OP.STORE, OP.CLOBBER, OP.UNKNOWN, OP.RET, OP.BR, OP.CBR]);
// Dropping a redundant branch also drops the evaluation that produced the
// condition, so the proof must cover every way that evaluation can be observed.
// A load can fault on an address the IR does not bound, and integer division or
// remainder traps on a zero divisor: neither may disappear with the branch.
const MAY_FAULT_OPS = new Set([OP.LOAD]);
const MAY_FAULT_BIN_SUBS = new Set(['sdiv', 'udiv', 'div', 'srem', 'urem', 'rem', 'smod', 'umod', 'mod']);

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
 * For every `}` line, the text of the construct it closes.  Null when the line
 * closes nothing (unbalanced input), which the callers treat as "not provable".
 */
function closerOpenerTexts(lines) {
  const stack = [];
  const openers = new Array(lines.length).fill(null);
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripNonCode(textOf(lines[index]));
    for (const character of code) {
      if (character === '{') stack.push(textOf(lines[index]));
      else if (character === '}') openers[index] = stack.pop() ?? null;
    }
  }
  return openers;
}

function isCloser(line) {
  return textOf(line).trim() === '}';
}

/**
 * A line that closes a compound statement, including `} else {` and the
 * `} while (...);` of a `do` loop.  A label may only introduce a statement, so
 * placing one of these directly after a label is not C.
 */
function startsWithCloseBrace(value) {
  return /^\s*\}/.test(typeof value === 'string' ? value : textOf(value));
}

/** Index of the last non-blank, non-comment line at or before `from`, or -1. */
function previousSignificant(lines, from) {
  for (let index = Math.min(from, lines.length - 1); index >= 0; index -= 1) {
    const text = textOf(lines[index]).trim();
    if (!text || COMMENT_RE.test(text)) continue;
    return index;
  }
  return -1;
}

/** Index of the first non-blank, non-comment line after `from`, or lines.length. */
function nextSignificant(lines, from) {
  for (let index = Math.max(0, from); index < lines.length; index += 1) {
    const text = textOf(lines[index]).trim();
    if (!text || COMMENT_RE.test(text)) continue;
    return index;
  }
  return lines.length;
}

/**
 * The label-introduces-a-statement invariant: every `loc_` label must be
 * followed, through other labels, blank lines and comments, by an actual
 * statement inside the same compound statement.  A rewrite that leaves `L: }`
 * behind publishes C that does not parse, so the closure refuses to publish it.
 */
function labelAtEndOfBlock(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!labelNameOf(lines[index])) continue;
    let violation = false;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const text = textOf(lines[scan]).trim();
      if (!text || COMMENT_RE.test(text)) continue;
      // Another label keeps the search going: labels may precede labels.
      if (labelNameOf(lines[scan]) || CASE_PREFIX_RE.test(text)) continue;
      violation = startsWithCloseBrace(text);
      break;
    }
    // Running out of lines proves nothing: an isolated line array is a fragment
    // and the brace that closes it may simply not be part of the input.
    if (violation) return true;
  }
  return false;
}

/** The last line of a region is a label, so closing a block after it is not C. */
function regionEndsWithLabel(lines) {
  const last = previousSignificant(lines, lines.length - 1);
  return last >= 0 && labelNameOf(lines[last]) != null;
}

function isTransparent(line, openerText) {
  if (line?.kind === 'label' || COMMENT_RE.test(textOf(line))) return true;
  // Completing an `if`/`else`/`switch` construct transfers control past that
  // construct, which is where the label sits.  Completing a loop does not: the
  // fallthrough re-tests the loop, so the jump and the fallthrough differ.
  if (isCloser(line) && openerText != null && !LOOP_OPENER_RE.test(openerText)) return true;
  return false;
}

function gotoTargetsIn(text) {
  const targets = [];
  ANY_GOTO_RE.lastIndex = 0;
  let match;
  while ((match = ANY_GOTO_RE.exec(text)) !== null) targets.push(match[1].toLowerCase());
  return targets;
}

function labelOccurrences(lines) {
  const counts = new Map();
  for (const line of lines) {
    const name = labelNameOf(line);
    if (name) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  }
  return counts;
}

/**
 * Index of the target label when every line between the jump and the label is
 * transparent for that jump, otherwise null.  Duplicate label names are refused
 * outright: textual jumping means "the first definition", which a duplicated
 * name cannot name.
 */
function transparentTargetIndex(lines, from, target, openers, occurrences) {
  if ((occurrences.get(target) ?? 0) !== 1) return null;
  for (let index = from + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!textOf(line).trim()) continue;
    const name = labelNameOf(line);
    if (name) {
      if (name.toLowerCase() === target) return index;
      continue;
    }
    if (COMMENT_RE.test(textOf(line))) continue;
    if (!isTransparent(line, openers[index])) return null;
    // Opening a block after the jump means the label sits inside code the jump
    // would skip but the fallthrough would enter.
    if (stripNonCode(textOf(line)).includes('{')) return null;
  }
  return null;
}

/**
 * Index of the target label when the lines between the jump and the label form
 * one balanced block scope of the jump itself.  Returns null when the region
 * closes a construct the jump is inside, leaves it, or crosses a switch case
 * entry — none of which a plain wrap can express.
 */
function guardRegionIndex(lines, from, target, occurrences) {
  if ((occurrences.get(target) ?? 0) !== 1) return null;
  const base = indentOf(lines[from]);
  let depth = 0;
  let statements = 0;
  for (let index = from + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const text = textOf(line);
    if (!text.trim()) continue;
    const name = labelNameOf(line);
    if (name) {
      if (name.toLowerCase() !== target) continue;
      if (depth !== 0 || statements <= 0) return null;
      // The generated `}` closes right after the region, so a region whose tail
      // is a label would leave `L: }` — a label that introduces no statement.
      // Such a region is not wrappable; the jump stays explicit.
      return regionEndsWithLabel(lines.slice(from + 1, index)) ? null : index;
    }
    if (COMMENT_RE.test(text)) continue;
    if (CASE_PREFIX_RE.test(text)) return null;
    if (line.kind !== 'label' && indentOf(line) < base) return null;
    const code = stripNonCode(text);
    for (const character of code) {
      if (character === '{') depth += 1;
      else if (character === '}') { depth -= 1; if (depth < 0) return null; }
    }
    statements += 1;
  }
  return null;
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
 * One closure pass.  Returns the lines of this pass plus what it changed; a
 * pass that changes nothing reports `progress: false` and ends the fixpoint.
 */
function closurePass(result) {
  const lines = result.lines;
  const ir = result.ir;
  const openers = closerOpenerTexts(lines);
  const occurrences = labelOccurrences(lines);
  const targets = lines.map((line) => gotoTargetsIn(textOf(line)));
  const out = [];
  const stats = { removedGotos: 0, removedLabels: 0, guardBlocks: 0, ifElseRegions: 0 };
  let index = 0;

  const push = (...added) => { for (const line of added) out.push(line); };
  const drop = () => { stats.removedGotos += 1; };

  while (index < lines.length) {
    const line = lines[index];
    const text = textOf(line);
    const uncond = UNCOND_GOTO_RE.exec(text);
    const cond = COND_GOTO_RE.exec(text);
    const isJump = (uncond || (cond && !CASE_PREFIX_RE.test(text))) && targets[index].length === 1;
    if (!isJump) { push(line); index += 1; continue; }

    const target = (uncond ? uncond[1] : cond[3]).toLowerCase();

    // --- if/else: two-sided region pair sharing one join -------------------
    const ifElse = buildIfElse({ lines, index, cond, target, occurrences });
    if (ifElse) {
      push(...ifElse.lines);
      stats.removedGotos += ifElse.gotos;
      stats.ifElseRegions += 1;
      index = ifElse.next;
      continue;
    }

    // --- guard block: skip forward over one region -------------------------
    if (cond) {
      const end = guardRegionIndex(lines, index, target, occurrences);
      if (end != null) {
        const header = structuralLine(indentOf(line), 'ctrl', `if (!(${cond[2]})) {`,
          mergeSource(line.source, lines[end].source));
        const footer = structuralLine(indentOf(line), 'ctrl', '}', mergeSource(line.source, lines[end].source));
        push(header, ...shiftLines(lines.slice(index + 1, end), 1), footer, lines[end]);
        drop(); stats.guardBlocks += 1;
        index = end + 1;
        continue;
      }
    }

    // --- no-op branch / fallthrough jump ----------------------------------
    const end = transparentTargetIndex(lines, index, target, openers, occurrences);
    if (end != null) {
      // Only the jump is dropped here; the label is re-examined by the orphan
      // sweep below so a jump from elsewhere keeps it.
      if (cond && !conditionIsProvenPure(line, ir)) { push(line); index += 1; continue; }
      // A label introduces a statement.  When the jump is the only statement
      // its own block gave its label, removing the jump would leave `L: }`,
      // which is not C: the honest explicit jump stays instead.
      const before = previousSignificant(lines, index - 1);
      const after = nextSignificant(lines, index + 1);
      if (after < end && startsWithCloseBrace(lines[after]) && before >= 0 && labelNameOf(lines[before])) {
        push(line); index += 1; continue;
      }
      // Only the jump line goes away: the transparent lines it skips over are
      // labels, comments and construct closers that still have to be there.
      drop();
      push(...lines.slice(index + 1, end));
      index = end;
      continue;
    }

    push(line);
    index += 1;
  }

  // --- orphan labels: nothing addresses them any more -----------------------
  const remaining = new Set();
  for (const line of out) for (const target of gotoTargetsIn(textOf(line))) remaining.add(target);
  const kept = out.filter((line) => {
    const name = labelNameOf(line);
    if (!name || remaining.has(name.toLowerCase())) return true;
    stats.removedLabels += 1;
    return false;
  });

  const progress = stats.removedGotos > 0 || stats.removedLabels > 0
    || stats.guardBlocks > 0 || stats.ifElseRegions > 0;
  return { lines: kept, stats, progress };
}

/**
 * `if (C) goto Lelse;` / then-region ending in `goto Lend;` / `Lelse:` /
 * else-region / `Lend:`.  Both regions must be single balanced scopes of the
 * jump with no switch entry, and neither label may be addressed from outside,
 * so the rewrite cannot capture a jump that was aiming somewhere else.
 */
function buildIfElse({ lines, index, cond, target, occurrences }) {
  if (!cond) return null;
  const base = indentOf(lines[index]);

  let end = index + 1;
  const thenLines = [];
  let depth = 0;
  let tailIndex = -1;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    const text = textOf(line);
    if (!text.trim()) continue;
    if (labelNameOf(line)) break;
    if (CASE_PREFIX_RE.test(text) || indentOf(line) < base) return null;
    const code = stripNonCode(text);
    for (const character of code) {
      if (character === '{') depth += 1;
      else if (character === '}') { depth -= 1; if (depth < 0) return null; }
    }
    if (depth !== 0) return null;
    thenLines.push(line);
    if (UNCOND_GOTO_RE.test(text)) { tailIndex = end; end += 1; break; }
  }
  const tail = tailIndex >= 0 ? lines[tailIndex] : null;
  const tailJump = tail ? UNCOND_GOTO_RE.exec(textOf(tail)) : null;
  if (!tailJump) return null;
  const joinLabel = labelNameOf(lines[end] ?? null);
  if (!joinLabel || joinLabel.toLowerCase() !== target) return null;

  const join = tailJump[1].toLowerCase();
  if ((occurrences.get(join) ?? 0) !== 1 || (occurrences.get(target) ?? 0) !== 1) return null;

  const elseLines = [];
  let close = end + 1;
  depth = 0;
  for (; close < lines.length; close += 1) {
    const line = lines[close];
    const text = textOf(line);
    if (!text.trim()) continue;
    const name = labelNameOf(line);
    if (name) {
      if (name.toLowerCase() === join) break;
      return null;
    }
    if (CASE_PREFIX_RE.test(text) || indentOf(line) < base) return null;
    const code = stripNonCode(text);
    for (const character of code) {
      if (character === '{') depth += 1;
      else if (character === '}') { depth -= 1; if (depth < 0) return null; }
    }
    if (depth !== 0) return null;
    elseLines.push(line);
  }
  const endLabel = labelNameOf(lines[close] ?? null);
  if (!endLabel || endLabel.toLowerCase() !== join || !elseLines.length || !thenLines.length) return null;
  // Each region becomes the tail of a new compound statement, so neither may end
  // on a label: the canonical two-sided form would otherwise emit `L: }`.
  if (regionEndsWithLabel(elseLines) || regionEndsWithLabel(thenLines.slice(0, -1))) return null;

  // Both labels must be private to this pair: a jump from outside would land
  // inside a branch that no longer matches the original ordering.  The pair's
  // own two jumps are the only admitted addresses.
  for (let scan = 0; scan < lines.length; scan += 1) {
    if (scan === index || scan === tailIndex) continue;
    for (const named of targetsOf(lines[scan])) {
      if (named === target || named === join) return null;
    }
  }

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

function targetsOf(line) {
  return gotoTargetsIn(textOf(line));
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
  const lines = Array.isArray(result?.lines) ? result.lines : null;
  if (!lines || lines.length < 2 || !result?.ir || !result?.semantic) return result;
  if (opts.shouldAbort?.() === true) return result;
  // A published render-provenance map is indexed over the lines it was built
  // from.  Changing the line array underneath it would publish a stale map, so
  // the closure refuses to run once one exists unless the caller supplies the
  // same refresh hook the other final-output closures use
  // (js/decompiler/c-output-closure.js `onLinesChanged`).  Without the hook the
  // map would be stale, and a stale map is worse than an honest goto.
  if (result.renderProvenance && typeof opts.onLinesChanged !== 'function') return result;

  const totals = { removedGotos: 0, removedLabels: 0, guardBlocks: 0, ifElseRegions: 0, passes: 0, refusedPasses: 0 };
  // The published text already renders a label with no statement under one
  // compound statement somewhere.  That is the producer's own defect, out of
  // this closure's scope, and nothing here may be published on top of it: the
  // line array passes through untouched.
  if (labelAtEndOfBlock(lines)) return result;
  let current = lines;
  for (let pass = 0; pass < 64; pass += 1) {
    if (opts.shouldAbort?.() === true) return result;
    const outcome = closurePass({ ...result, lines: current });
    totals.passes += 1;
    // A rewrite that would publish a label without a statement is a bug in the
    // rule that produced it, not a licence to emit the label.  The whole pass
    // is discarded and the fixpoint stops at the last text that was provably C.
    if (labelAtEndOfBlock(outcome.lines)) { totals.refusedPasses += 1; break; }
    totals.removedGotos += outcome.stats.removedGotos;
    totals.removedLabels += outcome.stats.removedLabels;
    totals.guardBlocks += outcome.stats.guardBlocks;
    totals.ifElseRegions += outcome.stats.ifElseRegions;
    current = outcome.lines;
    if (!outcome.progress) break;
  }
  if (current === lines || (totals.removedGotos === 0 && totals.removedLabels === 0
      && totals.guardBlocks === 0 && totals.ifElseRegions === 0)) return result;

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
  if (stats) Object.assign(stats, totals);
  // The line array changed, so any derived artifact the caller holds — an
  // index-keyed render-provenance map in particular — is refreshed by the
  // caller's own hook, exactly as closeFunctionOutput does it.
  if (typeof opts.onLinesChanged === 'function') opts.onLinesChanged(updated);
  return updated;
}
