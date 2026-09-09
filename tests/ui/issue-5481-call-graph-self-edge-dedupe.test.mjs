// Regression for #5481: callGraph() explored callers and callees separately
// with node-only dedupe, so a self-recursive function published the identical
// A->A call edge twice at depth 1. Contract now: the edge set is deduped by
// (from, to, kind) — one logical call edge appears once.
import assert from 'node:assert/strict';
import { callGraph } from '../../js/graphview-base.js';

// 1. The issue's scenario: a self-recursive function at depth 1.
{
  const A = 0x1000n;
  const program = {
    callersOf: (addr) => (addr === A ? [{ addr: A }] : []),
    functionRange: (addr) => (addr === A ? { start: A, end: A + 4n } : null),
    calleesOf: (start) => (start === A ? [{ addr: A }] : []),
  };
  const graph = callGraph(program, null, A, { depth: 1 });
  assert.equal(graph.nodes.length, 1, 'one node for the self-recursive function');
  assert.equal(graph.edges.length, 1, `the A->A edge must appear exactly once, got ${graph.edges.length}`);
  assert.deepEqual(graph.edges[0], { from: A.toString(), to: A.toString(), kind: 'call' });
}

// 2. Callers and callees of DIFFERENT functions were never duplicated — keep
//    that behavior explicit.
{
  const entry = 0x2000n;
  const caller = 0x2100n;
  const callee = 0x2200n;
  const program = {
    callersOf: (addr) => (addr === entry ? [{ addr: caller }] : []),
    functionRange: (addr) => (addr === entry ? { start: entry, end: entry + 4n } : null),
    calleesOf: (start) => (start === entry ? [{ addr: callee }] : []),
  };
  const graph = callGraph(program, null, entry, { depth: 1 });
  assert.equal(graph.edges.length, 2, 'caller edge and callee edge are distinct and both kept');
  const keys = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
  assert.equal(keys.size, 2);
}

// 3. A cycle entry -> callee -> (callers back to entry) at depth 1 must not
//    duplicate the shared edge either.
{
  const entry = 0x3000n;
  const other = 0x3100n;
  const program = {
    callersOf: (addr) => (addr === entry ? [{ addr: other }] : []),
    functionRange: (addr) => (addr === entry ? { start: entry, end: entry + 4n } : addr === other ? { start: other, end: other + 4n } : null),
    calleesOf: (start) => (start === entry ? [{ addr: other }] : []),
  };
  const graph = callGraph(program, null, entry, { depth: 1 });
  const forward = graph.edges.filter((e) => e.from === entry.toString() && e.to === other.toString());
  const backward = graph.edges.filter((e) => e.from === other.toString() && e.to === entry.toString());
  assert.equal(forward.length, 1, 'entry->other call edge appears once');
  assert.equal(backward.length, 1, 'other->entry caller edge appears once');
}

// 4. Issue-mandated mutual recursion A -> B -> A at depth > 1: repeated
//    traversal at depth 2, 3 and 5 re-observes the same relations but must
//    publish exactly the two distinct logical call edges, preserving node and
//    depth behavior.
{
  const A = 0x3000n;
  const B = 0x3100n;
  const program = {
    callersOf: (addr) => (addr === A ? [{ addr: B }] : addr === B ? [{ addr: A }] : []),
    functionRange: (addr) => (addr === A ? { start: A, end: A + 4n } : addr === B ? { start: B, end: B + 4n } : null),
    calleesOf: (start) => (start === A ? [{ addr: B }] : start === B ? [{ addr: A }] : []),
  };
  for (const depth of [2, 3, 5]) {
    const graph = callGraph(program, null, A, { depth, limit: 8 });
    assert.deepEqual(
      graph.nodes.map((n) => n.id).sort(),
      [A.toString(), B.toString()].sort(),
      `depth ${depth}: exactly the two mutually recursive nodes`,
    );
    const forward = graph.edges.filter((e) => e.from === A.toString() && e.to === B.toString());
    const backward = graph.edges.filter((e) => e.from === B.toString() && e.to === A.toString());
    assert.equal(forward.length, 1, `depth ${depth}: A->B appears exactly once`);
    assert.equal(backward.length, 1, `depth ${depth}: B->A appears exactly once`);
    assert.equal(graph.edges.length, 2, `depth ${depth}: no duplicated relations beyond the two logical edges`);
  }
}

// 5. limit still applies per traversal level alongside the dedupe: the stub
//    models the real program.calleesOf contract (limit applied by the
//    program, {addr} items), so a callGraph that stopped forwarding the limit
//    would publish all five callees instead of three.
{
  const entry = 0x4000n;
  const callees = [1, 2, 3, 4, 5].map((i) => ({ addr: 0x4100n + BigInt(i) * 0x10n }));
  const program = {
    callersOf: (addr, limit) => [],
    functionRange: (addr) => (addr === entry ? { start: entry, end: entry + 4n } : null),
    calleesOf: (start, end, limit) => callees.slice(0, limit ?? 999),
  };
  const graph = callGraph(program, null, entry, { depth: 1, limit: 3 });
  assert.equal(graph.edges.length, 3, 'the traversal limit keeps capping fan-out');
  assert.equal(callGraph(program, null, entry, { depth: 1, limit: 999 }).edges.length, 5,
    'a larger limit reaches every callee');
}

console.log('issue-5481 call-graph self-edge dedupe: ok');
