import { readFileSync, writeFileSync } from 'node:fs';

const DWARF = 'js/analysis/debug/dwarf.js';
const TEST = 'tests/phase7/debug/issue-8733-dwarf-strp-alias-budget.test.mjs';

let s = readFileSync(DWARF, 'utf8');
const oldConst = "const DECODED_STRING_ENTRY_OVERHEAD_BYTES = 64;\n";
const newConst = oldConst + "// Preflight decoding uses bounded transient chunks; the full JS string is only\n// materialized after its exact UTF-16 footprint has been admitted (#8739).\nconst STRING_DECODE_PREFLIGHT_CHUNK_BYTES = 64 * 1024;\n";
if (s.split(oldConst).length - 1 !== 1) throw new Error('constant anchor mismatch');
s = s.replace(oldConst, newConst);

const oldFn = `function decodeSectionString(bytes, offset, byteBudget = null) {
  if (!bytes || offset < 0 || offset >= bytes.length) return null;
  let end = offset;
  while (end < bytes.length) {
    byteBudget?.charge(1);
    if (bytes[end] === 0) break;
    end += 1;
  }
  if (end === bytes.length) return null;
  return new TextDecoder('utf8').decode(bytes.subarray(offset, end));
}
`;
const newFn = `function decodedUtf16CodeUnits(bytes, start, end) {
  const decoder = new TextDecoder('utf8');
  let codeUnits = 0;
  for (let at = start; at < end; at += STRING_DECODE_PREFLIGHT_CHUNK_BYTES) {
    const next = Math.min(end, at + STRING_DECODE_PREFLIGHT_CHUNK_BYTES);
    // Streaming preserves UTF-8 sequences split at a chunk boundary while each
    // temporary decoded string remains bounded by the fixed chunk size.
    codeUnits += decoder.decode(bytes.subarray(at, next), { stream: next < end }).length;
  }
  return codeUnits;
}

function decodeSectionString(bytes, offset, byteBudget = null, decodedBudget = null) {
  if (!bytes || offset < 0 || offset >= bytes.length) return null;
  let end = offset;
  while (end < bytes.length) {
    byteBudget?.charge(1);
    if (bytes[end] === 0) break;
    end += 1;
  }
  if (end === bytes.length) return null;

  if (decodedBudget) {
    // Count the exact retained UTF-16 footprint with bounded transient chunks,
    // reserve it, and only then allow the one full TextDecoder allocation.
    const codeUnits = decodedUtf16CodeUnits(bytes, offset, end);
    decodedBudget.charge(codeUnits * DECODED_STRING_BYTES_PER_CHAR);
  }
  return new TextDecoder('utf8').decode(bytes.subarray(offset, end));
}
`;
if (s.split(oldFn).length - 1 !== 1) throw new Error('decode function anchor mismatch');
s = s.replace(oldFn, newFn);

const oldResolve = `      const value = decodeSectionString(bytes, offset, byteBudget);
      // Charge before caching so neither an unbounded decoded-string set nor an
      // unbounded negative-result set can grow past the budget.
      decodedBudget.charge(DECODED_STRING_ENTRY_OVERHEAD_BYTES
        + (value == null ? 0 : value.length * DECODED_STRING_BYTES_PER_CHAR));
      cache.byOffset.set(offset, value);
`;
const newResolve = `      // Reserve the retained cache entry before any potentially large decode.
      // decodeSectionString then reserves the exact UTF-16 payload before the
      // full TextDecoder allocation. Negative cached results retain only this
      // fixed entry charge.
      decodedBudget.charge(DECODED_STRING_ENTRY_OVERHEAD_BYTES);
      const value = decodeSectionString(bytes, offset, byteBudget, decodedBudget);
      cache.byOffset.set(offset, value);
`;
if (s.split(oldResolve).length - 1 !== 1) throw new Error('resolver anchor mismatch');
s = s.replace(oldResolve, newResolve);
writeFileSync(DWARF, s);

s = readFileSync(TEST, 'utf8');
const marker = '#8739 over-budget entry is rejected before a large TextDecoder allocation';
if (s.includes(marker)) throw new Error('review regression already exists');
s += `

test('#8739 over-budget entry is rejected before a large TextDecoder allocation', () => {
  const OriginalTextDecoder = globalThis.TextDecoder;
  let largestDecodeInput = 0;
  globalThis.TextDecoder = class BoundedDecoder extends OriginalTextDecoder {
    decode(input, options) {
      const size = input?.byteLength ?? 0;
      largestDecodeInput = Math.max(largestDecodeInput, size);
      if (size > 64 * 1024) throw new Error('oversized-decoder-allocation:' + size);
      return super.decode(input, options);
    }
  };

  try {
    const sections = strpAliasReproducer({ aliases: 1, stringLength: 256 * 1024 });
    const parsed = parseDebugInfo(sections, {
      maxBytesScanned: 1024 * 1024,
      maxRecords: 200_000,
      maxDepth: 8,
      maxDecodedStringBytes: 64 * 1024,
    });
    assert.equal(parsed.complete, false);
    assert.ok(parsed.diagnostics.includes('decoded string budget exhausted'), parsed.diagnostics.join('; '));
    assert.ok(largestDecodeInput <= 64 * 1024,
      'full over-budget string reached TextDecoder: ' + largestDecodeInput);
  } finally {
    globalThis.TextDecoder = OriginalTextDecoder;
  }
});
`;
writeFileSync(TEST, s);
