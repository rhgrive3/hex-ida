/**
 * #5912 — `.hexproj` BigInt-tag escaping needs explicit provenance.
 *
 * Unmarked v1/v2 documents preserve literal `$$hexBigInt`-style keys. The
 * current serializer emits a marker, and only that marker authorizes taking
 * one `$` back. Historical escape-aware files that omitted the marker are
 * inherently ambiguous with legacy literal files and are intentionally not
 * guessed at load time.
 */
import assert from 'node:assert/strict';
import {
  ProjectFormatError,
  createHexProject,
  parseHexProject,
  serializeHexProject,
} from '../../../js/project/index.js';

const OMIT = Symbol('omit');

function documentText({ version, custom, bigIntEncoding = OMIT }) {
  const document = {
    format: 'hexproj',
    version,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    binary: {
      hash: null,
      metadata: { custom },
      embedded: false,
    },
    user: {},
    findings: {},
    analysis: {},
    navigation: {},
  };
  if (bigIntEncoding !== OMIT) document.bigIntEncoding = bigIntEncoding;
  return JSON.stringify(document);
}

function parseCustom(options) {
  return parseHexProject(documentText(options)).binary.metadata.custom;
}

// The issue's v1 legacy literals survive at every supported container depth.
{
  const custom = {
    '$$hexBigInt': 'legacy-v1',
    nested: { '$$$hexBigInt': 'legacy-v1-nested' },
    list: [{ '$$$$hexBigInt': 'legacy-v1-array' }],
  };
  assert.deepEqual(parseCustom({ version: 1, custom }), custom);
}

// The reported v2 shape is also an unmarked literal document and must remain
// untouched; the root version alone is not provenance.
{
  const custom = {
    '$$hexBigInt': 'legacy-v2',
    nested: [{ '$$$hexBigInt': 'legacy-v2-array' }],
  };
  assert.deepEqual(parseCustom({ version: 2, custom }), custom);
}

// A marked document authorizes exactly one level of unescape, including nested
// objects and arrays.
{
  const parsed = parseCustom({
    version: 2,
    bigIntEncoding: 1,
    custom: {
      '$$hexBigInt': 'encoded-from-$',
      '$$$hexBigInt': 'encoded-from-$$',
      nested: [{ '$$$$hexBigInt': 'encoded-from-$$$' }],
    },
  });
  assert.deepEqual(parsed, {
    '$hexBigInt': 'encoded-from-$',
    '$$hexBigInt': 'encoded-from-$$',
    nested: [{ '$$$hexBigInt': 'encoded-from-$$$' }],
  });
}

// Old real BigInt wrappers remain authoritative without any provenance
// marker, for both legacy and current project versions.
for (const version of [1, 2]) {
  const parsed = parseCustom({
    version,
    custom: { actual: { '$hexBigInt': '10' } },
  });
  assert.equal(parsed.actual, 16n);
}

// Rebuilding the object avoids key-order-dependent deletion: the old in-place
// walk lost the first value when $$$ was visited before $$.
{
  const parsed = parseCustom({
    version: 2,
    bigIntEncoding: 1,
    custom: {
      '$$$hexBigInt': 'outer',
      '$$hexBigInt': 'inner',
    },
  });
  assert.deepEqual(parsed, {
    '$$hexBigInt': 'outer',
    '$hexBigInt': 'inner',
  });
}

// Two source keys mapping to the same decoded key are malformed provenance,
// rather than a reason to overwrite one user's value with another's.
assert.throws(
  () => parseCustom({
    version: 2,
    bigIntEncoding: 1,
    custom: {
      '$hexBigInt': 'literal-sibling',
      '$$hexBigInt': 'encoded-sibling',
    },
  }),
  (error) => error instanceof ProjectFormatError && error.code === 'HEX_PROJECT_BIGINT_ENCODING_COLLISION',
);

// The current serializer emits the marker and keeps both literal user data
// and actual BigInts round-trippable.
{
  const text = serializeHexProject(createHexProject({
    binaryMetadata: {
      custom: {
        '$hexBigInt': 'literal-user-data',
        nested: [{ '$$hexBigInt': 'literal-nested' }],
        actual: 0x100n,
      },
    },
  }));
  assert.equal(JSON.parse(text).bigIntEncoding, 1);
  const parsed = parseHexProject(text).binary.metadata.custom;
  assert.equal(parsed['$hexBigInt'], 'literal-user-data');
  assert.deepEqual(parsed.nested, [{ '$$hexBigInt': 'literal-nested' }]);
  assert.equal(parsed.actual, 0x100n);
}

for (const marker of [null, true, '1', 0, 1.5, {}, []]) {
  assert.throws(
    () => parseCustom({ version: 2, bigIntEncoding: marker, custom: {} }),
    (error) => error instanceof ProjectFormatError && error.code === 'HEX_PROJECT_BIGINT_ENCODING_INVALID',
    `marker ${JSON.stringify(marker)} must be rejected as malformed provenance`,
  );
}
for (const marker of [2, Number.MAX_SAFE_INTEGER]) {
  assert.throws(
    () => parseCustom({ version: 2, bigIntEncoding: marker, custom: {} }),
    (error) => error instanceof ProjectFormatError && error.code === 'HEX_PROJECT_BIGINT_ENCODING_UNSUPPORTED',
    `marker ${marker} must be rejected as unsupported provenance`,
  );
}

console.log('issue-5912 legacy hexproj tag keys regression: PASS');
