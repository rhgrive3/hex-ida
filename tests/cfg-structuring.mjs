import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg } from '../js/cfg.js';
import { decompile, decompiledText } from '../js/decompile.js';
import { analyzeGraph } from '../js/controlflow.js';

const BASE = 0x100000000n;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function asm(lines) {
  return lines.map((line, i) => {
    const x = String(line).trim(); const p = x.indexOf(' ');
    return { row: i, address: BASE + BigInt(i) * 4n,
      mn: p < 0 ? x : x.slice(0, p), ops: p < 0 ? '' : x.slice(p + 1) };
  });
}
function make(lines) {
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(lines.length) * 4n ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(asm(lines), { startRow: 0, endRow: lines.length - 1, rowOfAddress });
  const result = decompile(model, { addr: BASE, rowOfAddress,
    addrOfRow: (r) => BASE + BigInt(r) * 4n, symbolFor: () => null });
  return { model, cfg: buildCfg(model, { rowOfAddress }), result, text: decompiledText(result) };
}

// Optimized cleanup layout: row 5 jumps backwards to row 1, but row 1 does not
// dominate row 5. There is no cycle and therefore no loop.
const cleanup = make([
  'cbz x0, #0x100000010',
  'mov x1, #0x1',
  'b #0x100000018',
  'nop',
  'mov x2, #0x2',
  'b #0x100000004',
  'ret',
]);
assert(cleanup.model.backEdges.length === 0, 'blocks.js misclassified cleanup jump as loop');
assert(cleanup.cfg.backEdges.length === 0, 'cfg.js misclassified cleanup jump as loop');
assert(cleanup.result.coverage && cleanup.result.coverage.missing === 0, 'decompiler dropped reachable blocks');
assert(!cleanup.text.includes('条件は読み取れません */ 1'), 'decompiler invented an infinite loop condition');
assert(!cleanup.text.includes('while (1)'), 'cleanup jump became a fake infinite loop');

const loop = make([
  'mov x0, #0x0',
  'add x0, x0, #0x1',
  'cmp x0, #0xa',
  'b.ne #0x100000004',
  'ret',
]);
assert(loop.model.backEdges.length === 1, 'real natural loop disappeared from semantic model');
assert(loop.cfg.backEdges.length === 1, 'real natural loop disappeared from CFG');
assert(loop.result.coverage.missing === 0, 'real loop decompile lost a block');
assert(/while \(|do\s+\{/.test(loop.text), 'real natural loop was not structured');

// A branch that can either exit or disappear into a closed infinite SCC has no
// safe immediate post-dominator. Treating one as a merge would invent an if.
const nonTerm = analyzeGraph([[1, 2], [1], []], 0);
assert(nonTerm.immediatePostDominators[0] == null,
  'post-dominator invented across a non-terminating path');

// #6310: a shared prefix must remain eligible even when a later branch can
// either exit normally or enter a closed non-terminating SCC.
const mixedTermination = analyzeGraph([
  [1],
  [2, 3],
  [],
  [3],
], 0);
assert(mixedTermination.immediatePostDominators[0] === 1,
  'shared prefix lost its immediate post-dominator');
assert(mixedTermination.postDominators[0].has(1),
  'shared prefix lost a valid post-dominator');
assert(!mixedTermination.postDominators[1].has(2),
  'normal exit became a false post-dominator across a non-terminating branch');
assert([...mixedTermination.nonTerminatingReachable].sort((a, b) => a - b).join(',') === '0,1,3',
  'non-terminating reachability reporting changed');

const pureInfinite = analyzeGraph([[0]], 0);
assert(pureInfinite.immediatePostDominators[0] == null,
  'pure infinite loop gained a synthetic immediate post-dominator');
assert([...pureInfinite.postDominators[0]].join(',') === '0',
  'pure infinite loop gained a false original-node post-dominator');

const multipleNonTerminatingSinks = analyzeGraph([
  [1],
  [2],
  [3, 4, 5],
  [],
  [4],
  [5],
], 0);
assert(multipleNonTerminatingSinks.immediatePostDominators[0] === 1,
  'first shared prefix disappeared with multiple non-terminating sinks');
assert(multipleNonTerminatingSinks.immediatePostDominators[1] === 2,
  'second shared prefix disappeared with multiple non-terminating sinks');
assert(multipleNonTerminatingSinks.immediatePostDominators[2] == null,
  'mixed normal/non-terminating split gained a false immediate post-dominator');

// Indirect branches are not statically connected to their jump-table targets.
// The decompiler must still preserve both the `br` itself and every block in
// the function range instead of silently dropping the disconnected chunk.
const indirect = make([
  'br x8',
  'mov x0, #0x1',
  'ret',
]);
assert(indirect.text.includes('__asm("br x8")'), 'indirect branch disappeared');
assert(indirect.result.coverage.missing === 0, 'disconnected function block disappeared');
assert(indirect.result.coverage.emitted === indirect.result.coverage.total,
  'coverage does not include every Basic Block');
assert(indirect.result.coverage.mode === 'linear', 'disconnected CFG did not use faithful mode');

// A conditional with two disjoint return arms has no concrete post-dominator,
// but it is still a closed acyclic source-level if/else.  Keep it structured
// instead of abandoning the whole function to label/goto mode.
const terminalIfElse = make([
  'cbz x0, #0x10000000c',
  'mov x0, #0x1',
  'ret',
  'mov x0, #0x2',
  'ret',
]);
assert(terminalIfElse.cfg.graph.immediatePostDominators[0] == null,
  'terminal split unexpectedly gained a concrete post-dominator');
assert(terminalIfElse.result.coverage.mode === 'structured',
  'disjoint terminal arms fell back to faithful CFG mode');
assert(terminalIfElse.result.coverage.structuredMissing === 0,
  'terminal if/else left reachable blocks unstructured');
assert(terminalIfElse.text.includes('if (') && terminalIfElse.text.includes('} else {'),
  'terminal split was not emitted as if/else');
assert(!terminalIfElse.text.includes('goto loc_'),
  'terminal if/else retained an avoidable goto');

// Shared cleanup with a nested early return has no concrete post-dominator at
// the outer branch: one nested path returns while the other reaches cleanup.
// The non-cleanup arm is nevertheless a closed acyclic region whose only exits
// are RET or the cleanup block, so preserve it as a one-sided early-exit if.
const sharedCleanupEarlyExit = make([
  'cbz x0, #0x100000014',
  'cbz x1, #0x100000010',
  'str x2, [x3]',
  'b #0x100000014',
  'ret',
  'str x4, [x5]',
  'ret',
]);
assert(sharedCleanupEarlyExit.cfg.graph.immediatePostDominators[0] == null,
  'shared-cleanup early-exit unexpectedly gained a concrete post-dominator');
assert(sharedCleanupEarlyExit.result.coverage.mode === 'structured',
  'shared-cleanup early-exit fell back to faithful CFG mode');
assert(sharedCleanupEarlyExit.result.coverage.structuredMissing === 0,
  'shared-cleanup early-exit left reachable blocks unstructured');
assert(!sharedCleanupEarlyExit.text.includes('goto loc_'),
  'shared-cleanup early-exit retained an avoidable goto');
assert((sharedCleanupEarlyExit.text.match(/if \(/g) || []).length >= 2,
  'shared-cleanup early-exit did not retain nested structured conditions');
assert((sharedCleanupEarlyExit.text.match(/field_0 =/g) || []).length === 2,
  'shared-cleanup early-exit duplicated or dropped a side-effecting store');

// Counterexample: the candidate arm has a reachable side entry from outside
// the conditional region.  Folding it under the header would hide a real CFG
// entry, so this must remain explicit/fail closed.
const sharedCleanupSideEntry = make([
  'cbz x0, #0x100000018',
  'cbz x1, #0x100000014',
  'cbz x2, #0x100000004',
  'mov x3, #0x1',
  'b #0x100000018',
  'ret',
  'ret',
]);
assert(sharedCleanupSideEntry.result.coverage.mode === 'linear',
  'side-entry arm was incorrectly absorbed into an early-exit region');
assert(sharedCleanupSideEntry.text.includes('goto loc_'),
  'side-entry counterexample lost its explicit CFG edge');

// Counterexample: one arm can enter a closed infinite SCC.  There is no proof
// that both arms terminate, so the no-join transform must fail closed.
const mixedTerminalLoop = make([
  'cbz x0, #0x10000000c',
  'mov x0, #0x1',
  'ret',
  'b #0x10000000c',
]);
assert(mixedTerminalLoop.cfg.graph.immediatePostDominators[0] == null,
  'mixed terminal/non-terminating split unexpectedly gained a post-dominator');
assert(mixedTerminalLoop.result.coverage.mode === 'linear',
  'non-terminating arm was incorrectly accepted as terminal if/else');
assert(mixedTerminalLoop.text.includes('goto loc_'),
  'fail-closed mixed termination case lost its explicit edge');

// The shared continuation can sit below both direct successors. One branch may
// return before it, so the continuation is not a post-dominator of the header,
// but both non-returning paths still reconverge there. Recover the if/else and
// emit the cleanup exactly once instead of falling back to faithful CFG mode.
const deepSharedCleanupEarlyExit = make([
  'cbz x0, #0x10000000c',
  'str x1, [x2]',
  'b #0x10000001c',
  'cbz x3, #0x100000018',
  'str x4, [x5]',
  'b #0x10000001c',
  'ret',
  'str x6, [x7]',
  'ret',
]);
assert(deepSharedCleanupEarlyExit.cfg.graph.immediatePostDominators[0] == null,
  'deep shared-cleanup early-exit unexpectedly gained a concrete post-dominator');
assert(deepSharedCleanupEarlyExit.result.coverage.mode === 'structured',
  'deep shared-cleanup early-exit fell back to faithful CFG mode');
assert(deepSharedCleanupEarlyExit.result.coverage.structuredMissing === 0,
  'deep shared-cleanup early-exit left reachable blocks unstructured');
assert(!deepSharedCleanupEarlyExit.text.includes('goto loc_'),
  'deep shared-cleanup early-exit retained an avoidable goto');
assert((deepSharedCleanupEarlyExit.text.match(/field_0 =/g) || []).length === 3,
  'deep shared-cleanup early-exit duplicated or dropped a side-effecting store');

// Counterexample: the would-be continuation participates in a cycle. It has a
// reachable predecessor outside the two pre-continuation arms, so hoisting it
// after the if/else would claim a closed region that was not proven.
const cyclicSharedContinuation = make([
  'cbz x0, #0x10000000c',
  'mov x1, #0x1',
  'b #0x10000001c',
  'cbz x2, #0x100000018',
  'mov x3, #0x1',
  'b #0x10000001c',
  'ret',
  'cbz x4, #0x100000020',
  'b #0x10000001c',
]);
assert(cyclicSharedContinuation.result.coverage.mode === 'linear',
  'cyclic shared continuation was incorrectly absorbed into an if/else region');
assert(cyclicSharedContinuation.text.includes('goto loc_'),
  'cyclic shared-continuation counterexample lost its explicit CFG edge');

console.log('cfg-structuring regression: ok');
