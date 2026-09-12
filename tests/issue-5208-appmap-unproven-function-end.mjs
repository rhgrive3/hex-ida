import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMap } from '../js/appmap.js';

// #5208 — a method whose function end is unproven owns no bounded extent:
// refsFrom/calleesOf must not walk into the next function's string/API facts.
const FN_A = 0x1000n; // end unproven
const FN_B = 0x1100n; // proven extent
const STRING_ADDR = 0x2000n;
const CALLEE_ADDR = 0x1108n;

function fixture() {
  const symbols = {
    functionCount: 2,
    functionAt(addr) {
      if (addr === FN_A) return { start: FN_A, end: null };
      if (addr >= FN_B && addr < 0x1120n) return { start: FN_B, end: 0x1120n };
      return null;
    },
    nameAt: (addr) => (addr === CALLEE_ADDR ? 'connectToNetworkHost' : null),
  };
  const queries = { refs: [], callees: [] };
  const program = {
    regions: [{ vmAddr: 0x1000n, size: 0x200n }],
    functionRange(addr) {
      const fn = symbols.functionAt(addr);
      if (!fn) return null;
      return { start: fn.start, end: fn.end ?? null, region: program.regions[0] };
    },
    refsFrom(start, end, limit) {
      queries.refs.push([start.toString(), end === null ? null : end.toString(), limit]);
      if (end == null || end > 0x1104n) {
        return [{ site: 0x1104n, target: STRING_ADDR, kind: 'string' }];
      }
      return [];
    },
    calleesOf(start, end, limit) {
      queries.callees.push([start.toString(), end === null ? null : end.toString(), limit]);
      if (end == null || end > CALLEE_ADDR) {
        return [{ addr: CALLEE_ADDR, site: CALLEE_ADDR, count: 1 }];
      }
      return [];
    },
    callCountOf: () => 0,
  };
  return { symbols, program, queries };
}

test('#5208 unproven function end must not adopt next-function string/API facts', async () => {
  const { symbols, program, queries } = fixture();
  const appmap = buildAppMap({
    program,
    symbols,
    strings: [{ addr: STRING_ADDR, text: 'https://evil.example.com/upload' }],
    fields: {
      classCount: 1,
      classes: new Map([['c1', { name: 'HelperClass', methods: [{ addr: FN_A, sel: 'helper' }] }]]),
    },
  });

  const cls = appmap.classes.find((c) => c.name === 'HelperClass');
  assert.ok(cls, 'class must be classified');
  const polluted = (cls.why || []).filter((w) => w.code === 'string' || w.code === 'api');
  assert.equal(polluted.length, 0, `next-function facts must not classify HelperClass — got ${JSON.stringify(cls.why)}`);

  // The bounded control: a method with a proven end still collects its own facts.
  const { program: program2, symbols: symbols2 } = fixture();
  const appmap2 = buildAppMap({
    program: {
      ...program2,
      functionRange(addr) {
        const fn = symbols2.functionAt(addr);
        if (!fn) return null;
        // same function, now with a proven end before FN_B's refs
        return { start: fn.start, end: fn.start === FN_A ? 0x1100n : fn.end, region: program2.regions[0] };
      },
    },
    symbols: symbols2,
    strings: [{ addr: STRING_ADDR, text: 'https://example.com/a' }],
    fields: {
      classCount: 1,
      classes: new Map([['c2', { name: 'BoundedClass', methods: [{ addr: FN_A, sel: 'bounded' }] }]]),
    },
  });
  const bounded = appmap2.classes.find((c) => c.name === 'BoundedClass');
  assert.ok(bounded, 'bounded class must be classified');

  // All range queries for the unproven method must carry a non-null upper bound.
  for (const [, end] of [...queries.refs, ...queries.callees]) {
    assert.notEqual(end, null, 'refsFrom/calleesOf must never receive a null upper bound from classifyClass');
  }
});
