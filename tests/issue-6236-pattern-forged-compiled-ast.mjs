import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern, PATTERN_LANGUAGE_VERSION } from '../js/pattern/index.js';

// 1. Canonical compilePattern output evaluates cleanly
{
  const compiled = compilePattern({
    kind: 'struct',
    name: 'Valid',
    fields: [{ name: 'f1', type: { kind: 'primitive', name: 'u8' } }],
  });
  const res = evaluatePattern(compiled, new Uint8Array([42]));
  assert.equal(res.status, 'complete');
  assert.equal(res.value.fields.f1.value, 42);
}

// 2. Forged compiled object with invalid AST must NOT bypass type-check
{
  const forged = {
    languageVersion: PATTERN_LANGUAGE_VERSION,
    patternId: 'pattern:forged',
    sourceHash: 'any',
    ast: {
      kind: 'struct',
      name: 'Forged',
      fields: [{
        name: 'bad_array',
        type: { kind: 'array', count: false, element: { kind: 'primitive', name: 'u8' } },
      }],
    },
  };

  assert.throws(
    () => {
      evaluatePattern(forged, new Uint8Array([42]));
    },
    /pattern-array-count-invalid/,
    'forged compiled pattern must not skip AST type check',
  );
}

// 3. Forged patternId with valid AST but forged hash/id must be rejected
{
  const forgedId = {
    languageVersion: PATTERN_LANGUAGE_VERSION,
    patternId: 'pattern:forged_identity',
    sourceHash: 'wrong_hash',
    compileOptions: {},
    ast: {
      kind: 'struct',
      name: 'ValidAstWrongId',
      fields: [{ name: 'f1', type: { kind: 'primitive', name: 'u8' } }],
    },
  };

  assert.throws(
    () => {
      evaluatePattern(forgedId, new Uint8Array([42]));
    },
    /pattern-compiled-source-hash-mismatch/,
  );
}

// 4. Unsupported languageVersion must be rejected
{
  const unsupportedVersion = {
    languageVersion: 'unsupported-version',
    patternId: 'pattern:some_id',
    ast: {
      kind: 'struct',
      name: 'FutureVersion',
      fields: [{ name: 'f1', type: { kind: 'primitive', name: 'u8' } }],
    },
  };

  assert.throws(
    () => {
      evaluatePattern(unsupportedVersion, new Uint8Array([42]));
    },
    /pattern-compiled-language-version-unsupported/,
  );
}

console.log('issue #6236 pattern forged compiled AST regressions PASS');
