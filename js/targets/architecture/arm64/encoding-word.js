// A64 is fixed-width: every instruction is one little-endian 32-bit word. The
// deployed Capstone bridge hands the rest of the pipeline printed text, and that
// text is lossy for a few architecturally defined fields — PRFM's 14 unnamed
// prfop values print as an empty operand. Effect lifters that need such a field
// read it from the encoding word here instead of guessing from the text or
// failing closed on an instruction the decoder resolved exactly.
//
// This module never decodes. It only exposes the word the decoder was given, so
// a caller that has no bytes gets `null` and stays fail-closed.

export const ARM64_ENCODING_WORD_CONTRACT_VERSION = 'arm64-encoding-word/v1';
export const ARM64_INSTRUCTION_SIZE_BYTES = 4;

function isByte(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xff;
}

function fromBytes(bytes, offset) {
  if (offset < 0 || offset + ARM64_INSTRUCTION_SIZE_BYTES > bytes.length) return null;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (![b0, b1, b2, b3].every(isByte)) return null;
  return (
    (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
  );
}

function directWord(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
  if (typeof value === 'bigint' && value >= 0n && value <= 0xffffffffn) return Number(value) >>> 0;
  return null;
}

/** Read the A64 word at instruction index `index` of a fixed-width byte run. */
export function arm64EncodingWord(bytes, index) {
  if (!bytes || typeof bytes.length !== 'number') return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return fromBytes(bytes, index * ARM64_INSTRUCTION_SIZE_BYTES);
}

/**
 * Recover the A64 word from a decoded instruction record, whichever shape the
 * producer used. When a producer carries redundant encoding evidence, every
 * present representation must be valid and agree on the same word; otherwise
 * the record is contradictory and therefore not authoritative.
 */
export function arm64DecodedEncodingWord(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  const candidates = [];

  for (const value of [decoded.word, decoded.encodingWord]) {
    if (value == null) continue;
    const parsed = directWord(value);
    if (parsed == null) return null;
    candidates.push(parsed);
  }

  for (const bytes of [decoded.rawBytes, decoded.bytes]) {
    if (bytes == null) continue;
    if (typeof bytes.length !== 'number' || bytes.length < ARM64_INSTRUCTION_SIZE_BYTES) return null;
    const parsed = fromBytes(bytes, 0);
    if (parsed == null) return null;
    candidates.push(parsed);
  }

  if (candidates.length === 0) return null;
  const first = candidates[0];
  return candidates.every((candidate) => candidate === first) ? first : null;
}
