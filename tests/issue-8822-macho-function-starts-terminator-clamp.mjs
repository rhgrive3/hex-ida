// Issue #8822 regression: the legacy/classic Mach-O function-start path in
// `js/macho.js::parseFunctionStarts()` treated a ULEB128 stream that reached
// `buf.length` without the required zero terminator as `complete=true`, and
// `js/worker-legacy.js::analyzeSlice()` silently clamped `datasize > 8 MiB`
// to a prefix while still publishing `functionStartsExact=true`,
// `discoveryComplete=true`, `functionDiscovery.complete=true`. The canonical
// `js/binary/macho-core.js` already requires the terminator and records
// `partialReason='missing-terminator'` (#5275). Both legacy sites now fail
// closed: an unterminated or clamped stream yields `complete=false`,
// `partialReason` is exposed on the returned array, and `analyzeSlice()`
// reports `capped=true` + a `'function-starts:<reason>'` discovery reason so
// a prefix never becomes exact evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const machoSrc = fs.readFileSync(path.join(root, 'js/macho.js'), 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseFunctionStarts } = globalThis.MachO;

const ARM64_REGION = [{ exec: true, size: 0x100n, vmAddr: 0x1000n }];
const OPTS = { regions: ARM64_REGION, architecture: 'arm64' };

// (a) The issue's exact minimal counterexample: a single nonzero ULEB with
// no zero terminator. Pre-fix, this published `starts=[0x1004], complete=true`.
{
  const list = parseFunctionStarts(Uint8Array.from([0x04]), 0x1000n, OPTS);
  assert.deepEqual(Array.from(list), [0x1004n], 'the delta itself is still emitted');
  assert.equal(list.complete, false, 'unterminated stream must not be complete');
  assert.equal(list.malformed, true, 'missing terminator is malformed');
  assert.equal(list.partialReason, 'missing-terminator');
}

// (b) Adding the trailing zero terminator restores `complete=true`.
{
  const list = parseFunctionStarts(Uint8Array.from([0x04, 0x00]), 0x1000n, OPTS);
  assert.deepEqual(Array.from(list), [0x1004n]);
  assert.equal(list.complete, true, 'terminated stream stays complete');
  assert.equal(list.malformed, false);
  assert.equal(list.partialReason, null);
}

// (c) The existing multi-start terminated form (already covered by
// `tests/issues-63-340-341-463-474.mjs`) stays unchanged — a guard against
// over-tightening the parser.
{
  const list = parseFunctionStarts(Uint8Array.from([4, 4, 0]), 0x1000n, OPTS);
  assert.deepEqual(Array.from(list), [0x1004n, 0x1008n]);
  assert.equal(list.complete, true);
  assert.equal(list.rejected, 0);
  assert.equal(list.partialReason, null);
}

// (d) Multi-start without terminator: every delta is still emitted, but the
// stream is not complete. Pre-fix, `[0x04,0x04]` incorrectly reported
// `starts=[0x1004,0x1008], complete=true`.
{
  const list = parseFunctionStarts(Uint8Array.from([0x04, 0x04]), 0x1000n, OPTS);
  assert.deepEqual(Array.from(list), [0x1004n, 0x1008n]);
  assert.equal(list.complete, false);
  assert.equal(list.partialReason, 'missing-terminator');
}

// (e) A rejection inside a terminated stream still fails the completeness
// gate for its own reason (rejected > 0), not the terminator rule.
{
  const bad = parseFunctionStarts(Uint8Array.from([0x02, 0x00]), 0x1000n,
    { regions: ARM64_REGION, architecture: 'arm64e' });
  assert.equal(bad.length, 0);
  assert.equal(bad.rejected, 1);
  assert.equal(bad.complete, false);
  assert.equal(bad.malformed, false, 'terminator was seen, so no malformed flag');
  assert.equal(bad.partialReason, null);
}

// (f) Empty payload — never a complete exact stream.
{
  const empty = parseFunctionStarts(new Uint8Array(0), 0x1000n, OPTS);
  assert.equal(empty.length, 0);
  assert.equal(empty.complete, false);
  assert.equal(empty.malformed, true);
  assert.equal(empty.partialReason, 'missing-terminator');
}

// (g) Worker-side propagation: `analyzeSlice()` must (i) detect the clamp and
// mark `capped=true` before the parse, (ii) force `functionStartsExact=false`
// for the clamped case, and (iii) plumb a `function-starts:<reason>` discovery
// reason. These source-level assertions mirror the pattern in
// `tests/issue-8789-8816-unwind-caller-bounds.mjs`.
{
  const worker = fs.readFileSync(path.join(root, 'js/worker-legacy.js'), 'utf8');
  // The clamp is detected and the parse result's completeness is guarded by it.
  assert.match(worker, /const clamped = declared > clampLimit;/,
    'analyzeSlice must compute the 8 MiB clamp as a first-class truncation signal');
  assert.match(worker, /functionStartsExact = !clamped &&[^;]*list\.complete === true;/,
    'clamped prefix must never publish functionStartsExact=true');
  assert.match(worker, /if \(clamped\) \{[\s\S]*?capped = true;[\s\S]*?functionStartsPartialReason = 'clamp-truncated';/,
    'clamp must set capped=true and record the reason');
  assert.match(worker, /'function-starts:' \+ functionStartsPartialReason/,
    'functionDiscovery.reasons must expose the exact partial reason');
  assert.match(worker, /capped:functionStartsPartialReason==='clamp-truncated'/,
    'functionDiscovery.capped must be true specifically when the clamp fired');
}

console.log('issue #8822 legacy Mach-O function-start terminator + clamp: PASS');
