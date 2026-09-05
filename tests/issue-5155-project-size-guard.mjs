import assert from 'node:assert/strict';
import {
  MAX_PROJECT_BYTES,
  createHexProject,
  parseHexProject,
  serializeHexProject,
  tryParseHexProject,
} from '../js/project/index.js';

// Issue #5155: the string path of parseHexProject() (and the oversized
// serializeHexProject() rejection) ran the 16 MiB size guard through
// `new TextEncoder().encode(text)`, allocating a second full-size Uint8Array
// before rejecting. On memory-constrained targets that spike can kill the
// tab before HEX_PROJECT_TOO_LARGE is ever returned.

assert.equal(MAX_PROJECT_BYTES, 16 * 1024 * 1024, 'the test pins the documented 16 MiB bound');

const withEncodeSpy = async (fn) => {
  const original = TextEncoder.prototype.encode;
  const calls = [];
  TextEncoder.prototype.encode = function (text, ...rest) {
    calls.push(String(text)?.length || 0);
    return original.call(this, text, ...rest);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    TextEncoder.prototype.encode = original;
  }
};

// A hugely oversized ASCII string must be rejected without a full UTF-8 copy.
{
  const huge = 'A'.repeat(MAX_PROJECT_BYTES + 1);
  const { result, calls } = await withEncodeSpy(() => tryParseHexProject(huge));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HEX_PROJECT_TOO_LARGE');
  assert.equal(calls.length, 0, 'the size guard must not full-encode an obviously oversized string');
}

// Non-ASCII input whose UTF-16 length fits but whose UTF-8 bytes exceed the
// limit must still be rejected (chunked counting, not length confusion).
{
  const wide = '\u0800'.repeat(6_000_000);
  assert.ok(wide.length < MAX_PROJECT_BYTES, 'fixture must take the chunked path');
  const { result, calls } = await withEncodeSpy(() => tryParseHexProject(wide));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HEX_PROJECT_TOO_LARGE');
  assert.ok(!calls.some((length) => length >= wide.length), 'chunked counting must not full-encode the input');
}

// Byte-exact multibyte accounting must not overcount: this document is
// well under the limit and must parse.
{
  const project = createHexProject({});
  project.user.comments = [`pad-\u0800\u00e9-${'x'.repeat(1000)}`];
  const text = JSON.stringify({ ...JSON.parse(serializeHexProject(project)), user: project.user });
  const parsed = parseHexProject(serializeHexProject(project));
  assert.equal(parsed.user.comments.length, 1);
  assert.ok(text.length > 1000);
}

// An exactly-at-limit ASCII payload passes the size guard (JSON shape may
// still fail for its own reasons, but never with TOO_LARGE).
{
  const text = 'A'.repeat(MAX_PROJECT_BYTES);
  const { result } = await withEncodeSpy(() => tryParseHexProject(text));
  assert.equal(result.ok, false);
  assert.notEqual(result.code, 'HEX_PROJECT_TOO_LARGE', 'exactly 16 MiB must pass the size guard');
}

// Oversized export rejection must not add a second full-size copy either.
{
  const project = createHexProject({ comments: ['A'.repeat(MAX_PROJECT_BYTES + 1)] });
  const { result, calls } = await withEncodeSpy(() => {
    try {
      serializeHexProject(project);
      return { thrown: null };
    } catch (error) {
      return { thrown: error };
    }
  });
  assert.equal(result.thrown?.code, 'HEX_PROJECT_TOO_LARGE');
  assert.equal(calls.length, 0, 'oversized export rejection must not full-encode the payload');
}

console.log('issue #5155 bounded project size guard: PASS');
