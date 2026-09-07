import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern, PATTERN_LANGUAGE_VERSION } from '../../../js/pattern/index.js';

const source = {
  kind: 'struct',
  name: 'EnvelopeAuthority',
  fields: [
    { name: 'flag', type: { kind: 'primitive', name: 'u8' } },
    {
      name: 'selected',
      when: {
        op: 'eq',
        left: { op: 'ref', path: 'flag' },
        right: { op: 'const', value: 1 },
      },
      type: { kind: 'primitive', name: 'u8' },
    },
  ],
};

const compiled = compilePattern(source, { snapshotId: 'snapshot-6236' });
const canonical = evaluatePattern(compiled, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' });
assert.equal(canonical.status, 'complete');
assert.equal(canonical.value.fields.selected.value, 42, 'valid binary expressions must retain their operands');

const rehydrated = structuredClone(compiled);
const rehydratedResult = evaluatePattern(rehydrated, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' });
assert.equal(rehydratedResult.status, 'complete');
assert.equal(rehydratedResult.patternId, compiled.patternId);

const invalidAst = structuredClone(compiled);
invalidAst.ast.fields[1] = {
  name: 'items',
  type: {
    kind: 'array',
    count: false,
    element: { kind: 'primitive', name: 'u8' },
  },
};
assert.throws(
  () => evaluatePattern(invalidAst, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-array-count-invalid/,
);

const forgedHash = structuredClone(compiled);
forgedHash.sourceHash = 'forged';
assert.throws(
  () => evaluatePattern(forgedHash, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-compiled-source-hash-mismatch/,
);

const forgedId = structuredClone(compiled);
forgedId.patternId = 'pattern:forged';
assert.throws(
  () => evaluatePattern(forgedId, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-compiled-id-mismatch/,
);

const wrongLanguage = structuredClone(compiled);
wrongLanguage.languageVersion = `${PATTERN_LANGUAGE_VERSION}-future`;
assert.throws(
  () => evaluatePattern(wrongLanguage, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-compiled-language-version-unsupported/,
);

const invalidSnapshot = structuredClone(compiled);
invalidSnapshot.snapshotId = { forged: true };
assert.throws(
  () => evaluatePattern(invalidSnapshot, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-compiled-snapshot-id-invalid/,
);

const invalidOptions = structuredClone(compiled);
invalidOptions.compileOptions = [];
assert.throws(
  () => evaluatePattern(invalidOptions, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-compiled-options-invalid/,
);

const partialEnvelope = {
  patternId: 'pattern:forged',
  ast: source,
};
assert.throws(
  () => evaluatePattern(partialEnvelope, Uint8Array.from([1, 42])),
  /pattern-compiled-language-version-unsupported|pattern-compiled-invalid/,
);

const mutableExternal = structuredClone(compiled);
evaluatePattern(mutableExternal, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' });
mutableExternal.ast.fields[1].when = { op: 'unsupported' };
assert.throws(
  () => evaluatePattern(mutableExternal, Uint8Array.from([1, 42]), { snapshotId: 'snapshot-6236' }),
  /pattern-expression-op-unsupported/,
  'caller-owned compiled envelopes must be revalidated after mutation',
);

console.log('[phase12] compiled pattern envelope authority regressions passed');
