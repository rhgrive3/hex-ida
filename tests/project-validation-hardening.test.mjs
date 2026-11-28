import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATCH_ENTRIES,
  MAX_PROJECT_BYTES,
  MAX_TYPE_LENGTH,
  MAX_VAR_KEY_LENGTH,
} from '../js/project/limits.js';
import { formatProjectError } from '../js/project/errors.js';
import {
  MAX_COMMENT_LENGTH as RE_MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH as RE_MAX_NAME_LENGTH,
  MAX_PATCH_ENTRIES as RE_MAX_PATCH_ENTRIES,
  MAX_PROJECT_BYTES as RE_MAX_PROJECT_BYTES,
  MAX_TYPE_LENGTH as RE_MAX_TYPE_LENGTH,
  MAX_VAR_KEY_LENGTH as RE_MAX_VAR_KEY_LENGTH,
  ProjectFormatError,
  createHexProject,
  parseHexProject,
  projectAnnotationCommitList,
  serializeHexProject,
  validatePatchEntries,
} from '../js/project/index.js';

function rawDoc(userOverrides = {}) {
  return JSON.stringify({
    format: 'hexproj',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    binary: { hash: 'bin_sha256_' + 'a'.repeat(64), metadata: null, embedded: false },
    user: {
      names: [],
      comments: [],
      types: [],
      vars: [],
      structs: [],
      bookmarks: [],
      patches: [],
      ...userOverrides,
    },
  });
}

test('limits.js constants are defined and re-exported consistently from index.js', () => {
  assert.equal(MAX_PROJECT_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_NAME_LENGTH, 256);
  assert.equal(MAX_COMMENT_LENGTH, 2000);
  assert.equal(MAX_TYPE_LENGTH, 128);
  assert.equal(MAX_VAR_KEY_LENGTH, 256);
  assert.equal(MAX_PATCH_ENTRIES, 100_000);

  assert.equal(RE_MAX_PROJECT_BYTES, MAX_PROJECT_BYTES);
  assert.equal(RE_MAX_NAME_LENGTH, MAX_NAME_LENGTH);
  assert.equal(RE_MAX_COMMENT_LENGTH, MAX_COMMENT_LENGTH);
  assert.equal(RE_MAX_TYPE_LENGTH, MAX_TYPE_LENGTH);
  assert.equal(RE_MAX_VAR_KEY_LENGTH, MAX_VAR_KEY_LENGTH);
  assert.equal(RE_MAX_PATCH_ENTRIES, MAX_PATCH_ENTRIES);
});

test('name, comment, var, and type length limits reject oversized values on parse, create, and commitList', () => {
  // Exact boundary passes
  const atLimit = parseHexProject(rawDoc({
    names: [{ address: '0x1000', value: 'n'.repeat(MAX_NAME_LENGTH) }],
    comments: [{ address: '0x1000', value: 'c'.repeat(MAX_COMMENT_LENGTH) }],
    vars: [{ key: 'k'.repeat(MAX_VAR_KEY_LENGTH), value: 'v'.repeat(MAX_NAME_LENGTH) }],
    types: [{ key: 't'.repeat(MAX_VAR_KEY_LENGTH), value: 'y'.repeat(MAX_TYPE_LENGTH) }],
  }));
  assert.equal(atLimit.user.names[0].value.length, MAX_NAME_LENGTH);
  assert.equal(atLimit.user.comments[0].value.length, MAX_COMMENT_LENGTH);

  // Over limit rejected (including 1,000,000-char hostile name)
  assert.throws(
    () => parseHexProject(rawDoc({ names: [{ address: '0x1000', value: 'a'.repeat(1_000_000) }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_NAME_TOO_LONG',
  );
  assert.throws(
    () => createHexProject({ userNames: [{ address: 0x1000n, value: 'a'.repeat(MAX_NAME_LENGTH + 1) }] }),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_NAME_TOO_LONG',
  );
  assert.throws(
    () => projectAnnotationCommitList([{ address: 0x1000n, value: 'a'.repeat(MAX_NAME_LENGTH + 1) }], 'user.names'),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_NAME_TOO_LONG',
  );

  assert.throws(
    () => parseHexProject(rawDoc({ comments: [{ address: '0x1000', value: 'c'.repeat(MAX_COMMENT_LENGTH + 1) }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_COMMENT_TOO_LONG',
  );
  assert.throws(
    () => projectAnnotationCommitList([{ address: 0x1000n, value: 'c'.repeat(MAX_COMMENT_LENGTH + 1) }], 'user.comments'),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_COMMENT_TOO_LONG',
  );

  assert.throws(
    () => parseHexProject(rawDoc({ vars: [{ key: '0x1000:v0', value: 'v'.repeat(MAX_NAME_LENGTH + 1) }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_VAR_TOO_LONG',
  );
  assert.throws(
    () => parseHexProject(rawDoc({ vars: [{ key: 'k'.repeat(MAX_VAR_KEY_LENGTH + 1), value: 'v' }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_VAR_TOO_LONG',
  );

  assert.throws(
    () => parseHexProject(rawDoc({ types: [{ key: '0x1000:ret', value: 't'.repeat(MAX_TYPE_LENGTH + 1) }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_TYPE_TOO_LONG',
  );
  assert.throws(
    () => parseHexProject(rawDoc({ types: [{ key: 'k'.repeat(MAX_VAR_KEY_LENGTH + 1), value: 'int' }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_TYPE_TOO_LONG',
  );
});

test('malformed annotation and key-value entries are rejected instead of silently dropped', () => {
  assert.throws(
    () => parseHexProject(rawDoc({ names: [null] })),
    (err) => err instanceof ProjectFormatError,
  );
  assert.throws(
    () => parseHexProject(rawDoc({ names: [{ address: '0x1000' }] })),
    (err) => err instanceof ProjectFormatError,
  );
  assert.throws(
    () => parseHexProject(rawDoc({ names: [{ value: 'missing-addr' }] })),
    (err) => err instanceof ProjectFormatError,
  );
  assert.throws(
    () => parseHexProject(rawDoc({ vars: [{ key: '', value: 'x' }] })),
    (err) => err instanceof ProjectFormatError,
  );
  assert.throws(
    () => parseHexProject(rawDoc({ types: [{ key: '0x1000:r', value: 123 }] })),
    (err) => err instanceof ProjectFormatError,
  );
});

test('validatePatchEntries accepts valid BigInt and safe-integer patches and rejects malformed or overlapping patches', () => {
  const valid = validatePatchEntries([
    { offset: 0, before: [0x1f, 0x20, 0x03, 0xd5], after: [0x00, 0x00, 0x80, 0x52] },
    { offset: 4n, before: new Uint8Array([1, 2]), after: new Uint8Array([3, 4]) },
  ]);
  assert.equal(valid.length, 2);

  const invalidCases = [
    'not-an-array',
    [null],
    [{}],
    [{ before: [1], after: [2] }], // missing offset
    [{ offset: -1, before: [1], after: [2] }],
    [{ offset: -1n, before: [1], after: [2] }],
    [{ offset: 1.5, before: [1], after: [2] }],
    [{ offset: '0', before: [1], after: [2] }],
    [{ offset: 0, before: [], after: [] }],
    [{ offset: 0, before: [1, 2], after: [1] }],
    [{ offset: 0, before: [256], after: [0] }],
    [{ offset: 0, before: [-1], after: [0] }],
    [{ offset: 0, before: ['1'], after: [0] }],
    [
      { offset: 10, before: [1, 2, 3, 4], after: [5, 6, 7, 8] },
      { offset: 12n, before: [3, 4], after: [9, 10] },
    ], // overlap
  ];

  for (const bad of invalidCases) {
    assert.throws(
      () => validatePatchEntries(bad),
      (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
      `expected invalid patch to throw HEX_PROJECT_INVALID_PATCH: ${JSON.stringify(bad, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`,
    );
  }

  // parseHexProject & createHexProject enforce patch validation
  assert.throws(
    () => parseHexProject(rawDoc({ patches: [{ before: [1], after: [2] }] })),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
  );
  assert.throws(
    () => createHexProject({ patches: [{ offset: 0, before: [1, 2], after: [3] }] }),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
  );
});

test('serializeHexProject supports compact mode without indentation and round-trips cleanly', () => {
  const project = createHexProject({
    binaryHash: 'bin_sha256_' + 'b'.repeat(64),
    userNames: [{ address: 0x1000n, value: 'main' }],
    patches: [{ offset: 0x10n, before: [0x1f, 0x20, 0x03, 0xd5], after: [0x00, 0x00, 0x80, 0x52] }],
  });
  const pretty = serializeHexProject(project);
  const compact = serializeHexProject(project, { compact: true });
  assert.ok(pretty.includes('\n  '), 'default serialization remains pretty-printed');
  assert.equal(compact.includes('\n'), false, 'compact serialization omits newlines/indentation');
  assert.ok(compact.length < pretty.length);

  const parsed = parseHexProject(compact);
  assert.equal(parsed.user.names[0].value, 'main');
  assert.equal(parsed.user.patches[0].offset, 0x10n);
});

test('formatProjectError translates all known codes in ja/en and hides raw internal codes on fallback', () => {
  const codes = [
    'HEX_PROJECT_TOO_LARGE',
    'TOO_LARGE',
    'HEX_PROJECT_BINARY_MISMATCH',
    'HEX_PROJECT_INVALID_PATCH',
    'HEX_PROJECT_PATCH_OUT_OF_RANGE',
    'HEX_PROJECT_NAME_TOO_LONG',
    'HEX_PROJECT_COMMENT_TOO_LONG',
    'HEX_PROJECT_TYPE_TOO_LONG',
    'HEX_PROJECT_VAR_TOO_LONG',
    'HEX_PROJECT_INVALID_UTF8',
    'HEX_PROJECT_FUTURE_VERSION',
    'HEX_PROJECT_TOO_DEEP',
    'HEX_PROJECT_BIGINT_ENCODING_INVALID',
    'HEX_PROJECT_BIGINT_ENCODING_UNSUPPORTED',
    'HEX_PROJECT_BIGINT_ENCODING_COLLISION',
    'HEX_PROJECT_INVALID',
    'resource-limit',
    'QUOTA_EXCEEDED',
    'QuotaExceededError',
    'STORAGE_ERROR',
    'IDB_ERROR',
    'DELTA_SCAN_INCOMPLETE',
    'INVALID_SNAPSHOT',
    'SNAPSHOT_READ_ERROR',
    'HEX_WORKSPACE_STALE',
    'project-unbound',
    'notes-unavailable',
  ];

  for (const code of codes) {
    const ja = formatProjectError({ code }, 'ja');
    const en = formatProjectError(new ProjectFormatError('raw internal msg', code), 'en');
    assert.ok(typeof ja === 'string' && ja.length > 0, `ja message missing for ${code}`);
    assert.ok(typeof en === 'string' && en.length > 0, `en message missing for ${code}`);
    assert.equal(ja.includes(code), false, `ja message must not expose raw code ${code}: ${ja}`);
    assert.equal(en.includes(code), false, `en message must not expose raw code ${code}: ${en}`);
  }

  // String & Error.name inputs
  assert.match(formatProjectError('TOO_LARGE', 'ja'), /16 MiB/);
  const quotaErr = new Error('QuotaExceededError: storage full');
  quotaErr.name = 'QuotaExceededError';
  assert.match(formatProjectError(quotaErr, 'ja'), /容量/);

  // Unknown code fallback never leaks raw internal code
  const unknownJa = formatProjectError({ code: 'INTERNAL_WEIRD_CODE_999', message: 'raw stack' }, 'ja');
  const unknownEn = formatProjectError({ code: 'INTERNAL_WEIRD_CODE_999', message: 'raw stack' }, 'en');
  assert.equal(unknownJa.includes('INTERNAL_WEIRD_CODE_999'), false);
  assert.equal(unknownEn.includes('INTERNAL_WEIRD_CODE_999'), false);
  assert.ok(unknownJa.length > 0 && unknownEn.length > 0);
});

test('string addresses in annotations and navigation.currentFunction enforce hex (128) and decimal (160) digit limits', () => {
  const maxHex = '0x' + 'f'.repeat(128);
  const overHex = '0x' + 'f'.repeat(129);
  const maxDec = '9'.repeat(160);
  const overDec = '9'.repeat(161);

  // Exact boundaries pass
  const atLimit = parseHexProject(JSON.stringify({
    format: 'hexproj',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    binary: { hash: 'bin_sha256_' + 'a'.repeat(64), metadata: null, embedded: false },
    navigation: { currentFunction: maxHex, history: [], bookmarks: [] },
    user: {
      names: [{ address: maxHex, value: 'hex_ok' }, { address: maxDec, value: 'dec_ok' }],
      comments: [],
      types: [],
      vars: [],
      structs: [],
      bookmarks: [],
      patches: [],
    },
  }));
  assert.equal(atLimit.user.names.length, 2);
  assert.equal(atLimit.navigation.currentFunction, BigInt(maxHex));

  const atDecFn = parseHexProject(JSON.stringify({
    format: 'hexproj',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    binary: { hash: 'bin_sha256_' + 'a'.repeat(64), metadata: null, embedded: false },
    navigation: { currentFunction: maxDec, history: [], bookmarks: [] },
    user: { names: [], comments: [], types: [], vars: [], structs: [], bookmarks: [], patches: [] },
  }));
  assert.equal(atDecFn.navigation.currentFunction, BigInt(maxDec));

  // Over-limit annotation addresses throw resource-limit before BigInt()
  for (const addr of [overHex, overDec, '0x' + 'a'.repeat(5000), '1' + '0'.repeat(5000)]) {
    assert.throws(
      () => parseHexProject(rawDoc({ names: [{ address: addr, value: 'x' }] })),
      (err) => err instanceof ProjectFormatError && err.code === 'resource-limit',
      `expected resource-limit for annotation address length ${addr.length}`,
    );
    assert.throws(
      () => projectAnnotationCommitList([{ address: addr, value: 'x' }], 'user.names'),
      (err) => err instanceof ProjectFormatError && err.code === 'resource-limit',
    );
  }

  // Over-limit navigation.currentFunction throws resource-limit before BigInt()
  for (const fnAddr of [overHex, overDec, '0x' + 'b'.repeat(5000), '2' + '0'.repeat(5000)]) {
    assert.throws(
      () => parseHexProject(JSON.stringify({
        format: 'hexproj',
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        binary: { hash: 'bin_sha256_' + 'a'.repeat(64), metadata: null, embedded: false },
        navigation: { currentFunction: fnAddr, history: [], bookmarks: [] },
        user: { names: [], comments: [], types: [], vars: [], structs: [], bookmarks: [], patches: [] },
      })),
      (err) => err instanceof ProjectFormatError && err.code === 'resource-limit',
      `expected resource-limit for currentFunction length ${fnAddr.length}`,
    );
  }
});

test('validatePatchEntries detects overlaps involving legacy { addr, bytes } entries and enforces address digit limits', () => {
  // Non-overlapping legacy entries pass
  const ok = validatePatchEntries([
    { addr: '0x10', bytes: [1, 2, 3, 4] },
    { addr: 0x14, bytes: [5, 6] },
    { offset: 0x20, before: [7, 8], after: [9, 10] },
  ]);
  assert.equal(ok.length, 3);

  // Legacy vs legacy overlap
  assert.throws(
    () => validatePatchEntries([
      { addr: '0x10', bytes: [1, 2, 3, 4] },
      { addr: '0x12', bytes: [5, 6] },
    ]),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
  );

  // Legacy vs legacy exact duplicate
  assert.throws(
    () => validatePatchEntries([
      { addr: 16, bytes: [1, 2] },
      { addr: '0x10', bytes: [3, 4] },
    ]),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
  );

  // Legacy vs canonical overlap
  assert.throws(
    () => validatePatchEntries([
      { addr: '0x10', bytes: [1, 2, 3, 4] },
      { offset: 0x13n, before: [4, 5], after: [6, 7] },
    ]),
    (err) => err instanceof ProjectFormatError && err.code === 'HEX_PROJECT_INVALID_PATCH',
  );

  // Legacy oversized address string throws resource-limit
  assert.throws(
    () => validatePatchEntries([{ addr: '0x' + 'f'.repeat(129), bytes: [1] }]),
    (err) => err instanceof ProjectFormatError && err.code === 'resource-limit',
  );
});
