// Regression for #5155: the .hexproj 16 MiB guard must reject oversized input
// before paying for a second full UTF-8 allocation of the whole text, on both
// the parse and the serialize side, while keeping byte-exact accounting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_PROJECT_BYTES,
  importHexProject,
  parseHexProject,
  serializeHexProject,
  tryParseHexProject,
} from '../js/project/index.js';

const NATIVE_ENCODER = globalThis.TextEncoder;
const MAX_COPIED_SOURCE_UNITS = 1024 * 1024;
const MAX_COPIED_TARGET_BYTES = 4 * 1024 * 1024;

// The size guard may only ever look at a bounded window of the input. Any
// encode()/encodeInto() call that is handed (or reserves) a whole oversized
// buffer is the defect this issue reports, so the probe refuses it loudly.
function withBoundedByteCountProbe(run) {
  const calls = { encode: [], encodeInto: [] };
  class ProbeTextEncoder extends NATIVE_ENCODER {
    encode(source) {
      const units = typeof source === 'string' ? source.length : String(source).length;
      calls.encode.push(units);
      if (units > MAX_COPIED_SOURCE_UNITS) {
        const error = new Error(`full UTF-8 copy attempted for a ${units}-code-unit string`);
        error.code = 'HEX_TEST_FULL_UTF8_COPY';
        throw error;
      }
      return super.encode(source);
    }

    encodeInto(source, target) {
      const units = typeof source === 'string' ? source.length : String(source).length;
      calls.encodeInto.push([units, target.byteLength]);
      if (units > MAX_COPIED_SOURCE_UNITS || target.byteLength > MAX_COPIED_TARGET_BYTES) {
        const error = new Error(`unbounded UTF-8 copy attempted for a ${units}-code-unit chunk`);
        error.code = 'HEX_TEST_FULL_UTF8_COPY';
        throw error;
      }
      return super.encodeInto(source, target);
    }
  }
  globalThis.TextEncoder = ProbeTextEncoder;
  try {
    return { result: run(calls), calls };
  } finally {
    globalThis.TextEncoder = NATIVE_ENCODER;
  }
}

function assertBounded(calls) {
  assert.deepEqual(calls.encode, [], 'the size guard must not call TextEncoder.encode() on the input');
  assert.equal(
    calls.encodeInto.every(([, bytes]) => bytes <= MAX_COPIED_TARGET_BYTES),
    true,
    'the size guard must reuse a fixed small output buffer',
  );
}

// Independent UTF-8 byte oracle: chunked native encode that never splits a
// surrogate pair, so the assertions below do not depend on the module under
// test for their expected numbers.
function oracleBytes(text) {
  const encoder = new NATIVE_ENCODER();
  let total = 0;
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + 65536, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    total += encoder.encode(text.slice(offset, end)).byteLength;
    offset = end;
  }
  return total;
}

function projectText(filler) {
  return JSON.stringify({
    format: 'hexproj',
    version: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    binary: { hash: null, metadata: null, embedded: false },
    user: { names: [filler] },
  });
}

test('#5155 an oversized ASCII string is rejected without a full UTF-8 copy', () => {
  const huge = 'A'.repeat(MAX_PROJECT_BYTES + (1024 * 1024));
  const { result, calls } = withBoundedByteCountProbe(() => tryParseHexProject(huge));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HEX_PROJECT_TOO_LARGE');
  assert.match(result.error, /16 MiB/);
  assertBounded(calls);
});

test('#5155 multibyte text below the UTF-16 length but above the byte limit is rejected', () => {
  const text = projectText('あ'.repeat(Math.floor(MAX_PROJECT_BYTES / 3) + 1));
  assert.ok(text.length < MAX_PROJECT_BYTES, 'the hostile text must stay below the code-unit count');
  assert.ok(oracleBytes(text) > MAX_PROJECT_BYTES);
  const { result, calls } = withBoundedByteCountProbe(() => tryParseHexProject(text));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HEX_PROJECT_TOO_LARGE');
  assertBounded(calls);
});

test('#5155 ASCII text exactly at the byte limit is accepted and one byte more is not', () => {
  const room = MAX_PROJECT_BYTES - oracleBytes(projectText(''));
  const atLimit = projectText('x'.repeat(room));
  assert.equal(oracleBytes(atLimit), MAX_PROJECT_BYTES);
  const { result, calls } = withBoundedByteCountProbe(() => tryParseHexProject(atLimit));
  assert.equal(result.ok, true, `at-limit project must parse: ${result.error}`);
  assert.equal(result.project.user.names[0].length, room);
  assertBounded(calls);

  const over = projectText('x'.repeat(room + 1));
  assert.equal(oracleBytes(over), MAX_PROJECT_BYTES + 1);
  const rejected = withBoundedByteCountProbe(() => tryParseHexProject(over));
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.code, 'HEX_PROJECT_TOO_LARGE');
  assertBounded(rejected.calls);
});

test('#5155 astral text is counted byte-exactly across bounded chunks', () => {
  const room = MAX_PROJECT_BYTES - oracleBytes(projectText(''));
  // The leading single unit offsets every surrogate pair against even chunk
  // boundaries, so a chunker that cuts a pair in half miscounts here.
  const pairs = Math.floor((room - 1) / 4);
  const filler = `x${'\u{1f600}'.repeat(pairs)}${'x'.repeat(room - 1 - (pairs * 4))}`;
  const atLimit = projectText(filler);
  assert.equal(oracleBytes(atLimit), MAX_PROJECT_BYTES);
  assert.ok(atLimit.length < MAX_PROJECT_BYTES, 'byte-exact accounting must exceed the code-unit count');
  const { result, calls } = withBoundedByteCountProbe(() => tryParseHexProject(atLimit));
  assert.equal(result.ok, true, `at-limit astral project must parse: ${result.error}`);
  assert.equal(result.project.user.names[0], filler);
  assertBounded(calls);

  const over = projectText(`${filler}x`);
  assert.equal(oracleBytes(over), MAX_PROJECT_BYTES + 1);
  const rejected = withBoundedByteCountProbe(() => tryParseHexProject(over));
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.code, 'HEX_PROJECT_TOO_LARGE');
  assertBounded(rejected.calls);
});

test('#5155 a below-limit multibyte project still parses', () => {
  const text = projectText('\u{1f600}'.repeat(1000) + 'あ'.repeat(1000));
  const project = parseHexProject(text);
  assert.equal(project.format, 'hexproj');
  assert.equal(project.user.names.length, 1);
});

test('#5155 oversized serialize rejects without a second full copy', () => {
  const project = {
    format: 'hexproj',
    version: 2,
    binary: { hash: null, metadata: null, embedded: false },
    user: { names: ['x'.repeat(MAX_PROJECT_BYTES)] },
  };
  let error = null;
  const { calls } = withBoundedByteCountProbe(() => {
    try {
      serializeHexProject(project);
    } catch (thrown) {
      error = thrown;
    }
  });
  assert.equal(error?.code, 'HEX_PROJECT_TOO_LARGE');
  assertBounded(calls);
});

test('#5155 byte inputs keep the pre-decode preflight and the UTF-8 error codes', () => {
  const oversized = new Uint8Array(MAX_PROJECT_BYTES + 1);
  assert.throws(() => parseHexProject(oversized), (error) => error?.code === 'HEX_PROJECT_TOO_LARGE');
  assert.throws(
    () => parseHexProject(oversized.buffer),
    (error) => error?.code === 'HEX_PROJECT_TOO_LARGE',
  );
  assert.throws(
    () => parseHexProject(new Uint8Array([0xff, 0xff, 0xff])),
    (error) => error?.code === 'HEX_PROJECT_INVALID_UTF8',
  );
  const project = parseHexProject(new TextEncoder().encode(projectText('ok')));
  assert.equal(project.user.names[0], 'ok');
});

test('#5155 the size guard helper stays bounded against full-copy regressions', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../js/project/index.js', import.meta.url)), 'utf8');
  const helper = /function encodedByteLength\([\s\S]*?\n}\n/.exec(source);
  assert.ok(helper, 'the project byte guard must keep a single named bounded helper');
  assert.doesNotMatch(helper[0], /\.encode\(/, 'the guard must not materialize a full UTF-8 copy of the input');
  assert.match(helper[0], /encodeInto\(/, 'the guard must stream-count through a fixed small buffer');
});

test('#5155 oversized Blob input is rejected before its bytes are read', async () => {
  let read = false;
  class ProbeBlob extends Blob {
    async arrayBuffer() { read = true; return super.arrayBuffer(); }
  }
  await assert.rejects(
    importHexProject(new ProbeBlob(['x'.repeat(MAX_PROJECT_BYTES + 1)])),
    (error) => error?.code === 'HEX_PROJECT_TOO_LARGE',
  );
  assert.equal(read, false);
});
