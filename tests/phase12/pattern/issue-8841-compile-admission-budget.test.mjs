import assert from 'node:assert/strict';
import {
  PATTERN_COMPILE_MAX_CONTENT_BYTES,
  PATTERN_COMPILE_MAX_NODES,
  compilePattern,
  evaluatePattern,
  parsePattern,
} from '../../../js/pattern/index.js';

function deepType(levels) {
  let type = { kind: 'primitive', name: 'u8' };
  for (let index = 0; index < levels; index++) type = { kind: 'pointer', space: 'file', target: type };
  return type;
}

function resourceError(thunk, expectedCode, label) {
  let thrown = null;
  try {
    thunk();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${label} must be rejected`);
  assert.notEqual(thrown.constructor.name, 'RangeError', `${label} must never surface a raw stack overflow`);
  assert.ok(!(thrown instanceof RangeError), `${label} must never surface a raw stack overflow`);
  assert.equal(thrown.code, expectedCode, `${label} must fail with the bounded resource code`);
}

// Counterexample 1: a 50k-deep object AST must fail under bounded depth
// admission before any recursive digest/freeze/type-check pass runs.
resourceError(
  () => compilePattern({ kind: 'struct', name: 'Root', fields: [{ name: 'x', type: deepType(50_000) }] }),
  'pattern-source-depth-exceeded',
  'deep object AST compilation',
);

// Counterexample 2: a union above the global node ceiling must fail before
// full traversal/materialization, with the node-limit resource code.
resourceError(
  () => compilePattern({
    kind: 'struct',
    name: 'Root',
    fields: [{ name: 'x', type: { kind: 'union', options: Array.from({ length: PATTERN_COMPILE_MAX_NODES + 1 }, () => ({ kind: 'primitive', name: 'u8' })) } }],
  }),
  'pattern-source-node-limit',
  'union above the global node ceiling',
);

// Binary-rich caller material must be charged to the content budget, not
// boxed into the canonical digest before admission.
resourceError(
  () => compilePattern({
    kind: 'struct',
    name: 'Root',
    fields: [{ name: 'x', type: { kind: 'primitive', name: 'u8' } }],
    junk: new Uint8Array(PATTERN_COMPILE_MAX_CONTENT_BYTES + 1),
  }),
  'pattern-source-content-limit',
  'binary-rich field on an object AST',
);

resourceError(
  () => compilePattern('struct Root { x: u8; }', { compileOptions: { junk: new Uint8Array(PATTERN_COMPILE_MAX_CONTENT_BYTES + 1) } }),
  'pattern-source-content-limit',
  'binary-rich compileOptions',
);

// The compiled-object envelope path must admit before the whole-graph clone.
resourceError(
  () => evaluatePattern(
    {
      languageVersion: 'hex-pattern-language-v1',
      patternId: 'pattern:x',
      sourceHash: 'x',
      ast: { kind: 'struct', name: 'Root', fields: [{ name: 'x', type: deepType(50_000) }] },
    },
    Uint8Array.from([1]),
  ),
  'pattern-source-depth-exceeded',
  'over-deep compiled-pattern envelope',
);

// Textual/JSON source bytes and tokens share the same bounded admission.
resourceError(
  () => parsePattern(`struct Root { x: u${'8'.repeat(300 * 1024)}; }`),
  'pattern-source-text-limit',
  'oversized textual source',
);
resourceError(
  () => parsePattern(JSON.stringify(Array(PATTERN_COMPILE_MAX_NODES + 1).fill(1))),
  'pattern-source-node-limit',
  'oversized JSON source graph',
);

// Exactly-at-limit patterns still compile deterministically through both the
// textual and object paths, and small patterns are unchanged.
const nested = compilePattern({ kind: 'struct', name: 'Root', fields: [{ name: 'x', type: deepType(63) }] });
const again = compilePattern({ kind: 'struct', name: 'Root', fields: [{ name: 'x', type: deepType(63) }] });
assert.equal(nested.patternId, again.patternId, 'exactly-at-limit object ASTs remain deterministic');
const roundTrip = compilePattern(parsePattern({ kind: 'struct', name: 'Root', fields: [{ name: 'x', type: deepType(63) }] }).ast);
assert.equal(roundTrip.patternId, nested.patternId, 'admitted graphs keep the same canonical identity');

const simple = compilePattern('struct Root { value: u8; }');
const evaluated = evaluatePattern(simple, Uint8Array.from([0x2a]));
assert.equal(evaluated.status, 'complete');
assert.equal(evaluated.value.fields.value.value, 42);

console.log('[phase12][pattern] issue-8841 compile admission budget regression passed');
