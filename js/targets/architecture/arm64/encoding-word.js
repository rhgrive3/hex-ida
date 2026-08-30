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

/** Read the A64 word at instruction index `index` of a fixed-width byte run. */
export function arm64EncodingWord(bytes, index) {
  if (!bytes || typeof bytes.length !== 'number') return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return fromBytes(bytes, index * ARM64_INSTRUCTION_SIZE_BYTES);
}

/**
 * Recover the A64 word from a decoded instruction record, whichever shape the
 * producer used. Returns `null` when the record carries no encoding, which is
 * the signal for a lifter to stay fail-closed rather than invent a field.
 */
export function arm64DecodedEncodingWord(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  const direct = decoded.word ?? decoded.encodingWord ?? null;
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct >= 0 && direct <= 0xffffffff) return direct >>> 0;
  if (typeof direct === 'bigint' && direct >= 0n && direct <= 0xffffffffn) return Number(direct) >>> 0;
  const bytes = decoded.rawBytes ?? decoded.bytes ?? null;
  if (bytes && typeof bytes.length === 'number' && bytes.length >= ARM64_INSTRUCTION_SIZE_BYTES) return fromBytes(bytes, 0);
  return null;
}
