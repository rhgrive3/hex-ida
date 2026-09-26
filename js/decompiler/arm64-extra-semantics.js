import { sourceOf } from './ast/nodes.js';
import { closeFunctionOutput } from './c-output-closure.js';
import { buildRenderProvenance } from './phase8/render-provenance.js';

/* Exact late lowering for ARM64 instructions that the legacy/semantic
 * decompilers still preserve as raw __asm. This is deliberately mnemonic-
 * scoped: unknown instructions stay raw assembly rather than being hidden. */

const A64_CONDITIONS = new Set([
  'eq', 'ne', 'cs', 'hs', 'cc', 'lo', 'mi', 'pl', 'vs', 'vc',
  'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv',
]);

function canonicalConditionToken(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  return A64_CONDITIONS.has(normalized) ? normalized : null;
}

function renderedText(lines) {
  return (lines || []).map((line) => `${'    '.repeat(Math.max(0, line.indent || 0))}${line.text || ''}`).join('\n');
}

function splitOperands(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseImm(text) {
  const raw = String(text || '').trim().replace(/^#/, '');
  if (!/^-?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) return null;
  const value = Number.parseInt(raw, 0);
  return Number.isSafeInteger(value) ? value : null;
}

function parseImm64(text) {
  const raw = String(text || '').trim().replace(/^#/, '');
  if (!/^-?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) return null;
  try { return BigInt(raw); } catch { return null; }
}

const A64_ELEMENT_BITS = Object.freeze({ b:8, h:16, s:32, d:64 });
// The legacy renderer names every general-purpose register `xN` and every
// SIMD/FP register `vN` regardless of the printed view (`wN`, `sN`, `dN`, …).
// A late lowering may therefore only publish a destination variable the rest of
// the function already reads: the printed full-width register, or the SIMD
// register base name. Every other view stays raw instead of aliasing a second
// C variable onto the same architectural register.
const GP_FULL_WIDTH_TEXT = /^x(\d{1,2})$/;
const SCALAR_FP_TEXT = /^[bhsdq](\d{1,2})$/i;
const VECTOR_TEXT = /^v(\d{1,2})(?:\.(\d{1,2})([bhsd]))?$/i;

// A64 wide/narrow arrangement pairs shared by the long (widening) forms.
const WIDE_LOW_SOURCE_ARRANGEMENT = Object.freeze({ '8h':'8b', '4s':'4h', '2d':'2s' });
const WIDE_HIGH_SOURCE_ARRANGEMENT = Object.freeze({ '8h':'16b', '4s':'8h', '2d':'4s' });
// ADDV has no 2D form; every arrangement reduces to one scalar element.
const ADDV_DESTINATION_ELEMENT_BITS = Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 });
const BITWISE_INSERT_ARRANGEMENTS = new Set(['8b','16b']);

function gpFullWidthRegister(text) {
  const match = GP_FULL_WIDTH_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 30) return null;
  return { number, name:`x${number}` };
}

function vectorRegister(text) {
  const match = VECTOR_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 31) return null;
  const base = `v${number}`;
  if (match[2] == null) return { number, name:base, arrangement:null, elementBits:null, widthBits:128 };
  const element = String(match[3]).toLowerCase();
  const laneCount = Number(match[2]);
  const elementBits = A64_ELEMENT_BITS[element];
  if (!Number.isInteger(laneCount) || laneCount < 1 || !elementBits) return null;
  const widthBits = laneCount * elementBits;
  if (widthBits !== 64 && widthBits !== 128) return null;
  return { number, name:base, arrangement:`${laneCount}${element}`, elementBits, widthBits };
}

function scalarFpRegister(text) {
  const match = SCALAR_FP_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 31) return null;
  const element = String(text).trim()[0].toLowerCase();
  return { number, name:`v${number}`, elementBits:A64_ELEMENT_BITS[element] };
}

// In A64 assembly syntax the MOVI <V>.2D immediate is the already-expanded
// 64-bit value whose every byte is 0x00 or 0xff — the encoding's 8-bit
// `abcdefgh` field has been unfolded by the disassembler (#5454). Treating the
// printed immediate as the encoding field turned `movi v0.2d, #0xff` into
// all-ones. Validate the byte-mask shape instead of re-expanding; anything
// else is not a canonical 2D immediate and stays raw.
function canonicalMovi2dImmediate(imm) {
  if (imm == null || imm < 0n || imm > 0xffffffffffffffffn) return null;
  for (let byte = 0; byte < 8; byte++) {
    const value = (imm >> BigInt(byte * 8)) & 0xffn;
    if (value !== 0n && value !== 0xffn) return null;
  }
  return imm;
}

function asmPayload(text) {
  const match = /^\s*__asm\s*\(\s*(["'])(.*?)\1\s*\)\s*;?\s*$/.exec(String(text || ''));
  return match ? match[2].trim() : null;
}

function lowerOne(payload) {
  const space = payload.indexOf(' ');
  const mnemonic = (space < 0 ? payload : payload.slice(0, space)).toLowerCase();
  const operands = splitOperands(space < 0 ? '' : payload.slice(space + 1));

  // REV <Wd|Xd>, <Wn|Xn>: architectural byte reversal of the complete
  // 32/64-bit general-purpose register value.
  if (mnemonic === 'rev' && operands.length === 2 && /^[wx]\d+$/i.test(operands[0]) && /^[wx]\d+$/i.test(operands[1])) {
    const bits = operands[0][0].toLowerCase() === 'w' ? 32 : 64;
    return `${operands[0]} = __builtin_bswap${bits}(${operands[1]});`;
  }

  // FCVTAS: floating point -> signed integer, FPCR-independent round to
  // nearest with halfway cases away from zero. Keep the rounding contract in
  // the pseudo intrinsic name instead of mis-rendering this as a C cast.
  if (mnemonic === 'fcvtas' && operands.length === 2 && /^[wx]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1])) {
    const bits = operands[0][0].toLowerCase() === 'w' ? 32 : 64;
    return `${operands[0]} = __a64_round_ties_away_s${bits}(${operands[1]});`;
  }

  // FCSEL <Sd|Dd>, <Sn|Dn>, <Sm|Dm>, <cond> chooses one FP source from the
  // current NZCV condition. The helper names the architectural predicate; it
  // is not an opaque assembly escape hatch. Unknown condition codes never
  // lower: the raw __asm fallback is the fail-closed boundary.
  if (mnemonic === 'fcsel' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1]) && /^[sd]\d+$/i.test(operands[2])) {
    const cond = canonicalConditionToken(operands[3]);
    if (cond !== null && cond !== 'al' && cond !== 'nv') {
      return `${operands[0]} = __a64_cond_${cond}() ? ${operands[1]} : ${operands[2]};`;
    }
  }

  // FCCMP conditionally performs an FP compare; when the predicate is false,
  // NZCV is replaced by the encoded immediate. Represent the flag effect
  // explicitly because dropping it would change subsequent FCSEL/branches.
  if (mnemonic === 'fccmp' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1])) {
    const cond = canonicalConditionToken(operands[3]);
    if (cond !== null && cond !== 'al' && cond !== 'nv') {
      const nzcv = parseImm(operands[2]);
      if (nzcv != null && nzcv >= 0 && nzcv <= 15) {
        return `__a64_fccmp(${operands[0]}, ${operands[1]}, ${nzcv}, "${cond}");`;
      }
    }
  }

  // MOVI vector immediate. The observed gap is the shifted halfword form, but
  // keep the lowering generic for valid vN.<lanes><b|h|s|d> arrangements.
  if (mnemonic === 'movi' && operands.length >= 2 && /^v\d+\.\d+[bhsd]$/i.test(operands[0])) {
    const arrangement = operands[0].split('.')[1].toLowerCase();
    if (arrangement === '2d') {
      // The printed immediate is the full 64-bit byte mask; parse it exactly
      // so masks wider than a safe integer still lower exactly (#5454).
      if (operands.length !== 2) return null;
      const value = canonicalMovi2dImmediate(parseImm64(operands[1]));
      if (value == null) return null;
      return `${operands[0].split('.')[0]} = __a64_movi_2d(0x${value.toString(16)});`;
    }
    const imm = parseImm(operands[1]);
    if (imm != null) {
      let shift = 0;
      if (operands.length === 3) {
        const match = /^lsl\s+#?(\d+)$/i.exec(operands[2]);
        if (!match) return null;
        shift = Number(match[1]);
      }
      if (shift >= 0 && shift <= 63) {
        const value = BigInt.asUintN(64, BigInt(imm) << BigInt(shift));
        return `${operands[0].split('.')[0]} = __a64_movi_${arrangement}(0x${value.toString(16)});`;
      }
    }
  }

  // SBFIZ/UBFIZ: bitfield insert. The destination is the full 64-bit view, so
  // the rendered variable is exactly the register the rest of the function
  // names. `#<lsb>` and `#<width>` place a sign/zero-extended `width`-bit field
  // of the source at bit `lsb`.
  if (mnemonic === 'sbfiz' || mnemonic === 'ubfiz') {
    if (operands.length !== 4) return null;
    const dst = gpFullWidthRegister(operands[0]);
    const src = gpFullWidthRegister(operands[1]);
    const lsb = parseImm(operands[2]);
    const fieldWidth = parseImm(operands[3]);
    if (!dst || !src) return null;
    if (lsb == null || fieldWidth == null) return null;
    if (lsb < 0 || fieldWidth < 1 || lsb + fieldWidth > 64) return null;
    return `${dst.name} = __a64_${mnemonic}_64(${src.name}, ${lsb}, ${fieldWidth});`;
  }

  // USHLL/USHLL2: widening shift left. `Vd.<wide>` receives the low (USHLL) or
  // high (USHLL2) half of `Vn` zero-extended to the destination lane width and
  // shifted left by the immediate. The arrangement pair and the shift range are
  // validated exactly; anything else stays raw.
  if (mnemonic === 'ushll' || mnemonic === 'ushll2') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const src = vectorRegister(operands[1]);
    const shift = parseImm(operands[2]);
    if (!dst?.arrangement || !src?.arrangement) return null;
    const table = mnemonic === 'ushll2' ? WIDE_HIGH_SOURCE_ARRANGEMENT : WIDE_LOW_SOURCE_ARRANGEMENT;
    if (table[dst.arrangement] !== src.arrangement) return null;
    if (shift == null || shift < 0 || shift >= dst.elementBits) return null;
    return `${dst.name} = __a64_${mnemonic}_${dst.arrangement}(${src.name}, ${shift});`;
  }

  // UADDW/UADDW2: widening add. `Vd.<wide>` and `Vn.<wide>` share the wide
  // arrangement; the second source is the low (UADDW) or high (UADDW2) half in
  // the matching narrow arrangement.
  if (mnemonic === 'uaddw' || mnemonic === 'uaddw2') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const wide = vectorRegister(operands[1]);
    const narrow = vectorRegister(operands[2]);
    if (!dst?.arrangement || !wide?.arrangement || !narrow?.arrangement) return null;
    if (wide.arrangement !== dst.arrangement) return null;
    const table = mnemonic === 'uaddw2' ? WIDE_HIGH_SOURCE_ARRANGEMENT : WIDE_LOW_SOURCE_ARRANGEMENT;
    if (table[dst.arrangement] !== narrow.arrangement) return null;
    return `${dst.name} = __a64_${mnemonic}_${dst.arrangement}(${wide.name}, ${narrow.name});`;
  }

  // BIT: bitwise insert if true over whole bytes. `Vd` is both source and
  // destination; only the 8B/16B arrangements exist.
  if (mnemonic === 'bit') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const source = vectorRegister(operands[1]);
    const mask = vectorRegister(operands[2]);
    if (!dst?.arrangement || !BITWISE_INSERT_ARRANGEMENTS.has(dst.arrangement)) return null;
    if (source?.arrangement !== dst.arrangement || mask?.arrangement !== dst.arrangement) return null;
    return `${dst.name} = __a64_bit_${dst.arrangement}(${dst.name}, ${source.name}, ${mask.name});`;
  }

  // ADDV: add across vector, reducing every lane into the low element of one
  // scalar SIMD register. The scalar view is the low bits of the same physical
  // register the renderer names `vN`.
  if (mnemonic === 'addv') {
    if (operands.length !== 2) return null;
    const dst = scalarFpRegister(operands[0]);
    const src = vectorRegister(operands[1]);
    if (!dst || !src?.arrangement) return null;
    if (ADDV_DESTINATION_ELEMENT_BITS[src.arrangement] !== dst.elementBits) return null;
    return `${dst.name} = __a64_addv_${src.arrangement}(${src.name});`;
  }

  return null;
}

export function lowerArm64RawAssembly(result) {
  if (!result?.lines?.length) return result;
  let lowered = 0;
  for (const line of result.lines) {
    if (!line || typeof line.text !== 'string') continue;
    if (!line.source && line.row != null && /^goto\s+loc_[0-9a-f]+;$/i.test(line.text.trim())) {
      line.source = sourceOf({
        address:line.addr ?? null,
        row:line.row,
        evidence:[{ reason:'residual compatibility control-flow edge' }],
      });
    }
    const payload = asmPayload(line.text);
    if (!payload) continue;
    const semantic = lowerOne(payload);
    if (!semantic) continue;
    line.text = semantic;
    line.note = line.note || 'Exact ARM64 instruction semantics lowered from the raw fallback.';
    lowered++;
  }
  if (!lowered) return result;
  result.pseudocode = renderedText(result.lines);
  result.ctx = { ...(result.ctx || {}), exactArm64FallbackLowerings: (result.ctx?.exactArm64FallbackLowerings || 0) + lowered };
  // Lowering can introduce new names (register destinations, intrinsic calls).
  // Close the C output again so the newly visible storage is declared too.
  return closeFunctionOutput(result, {
    render: renderedText,
    onLinesChanged: (closed) => {
      // The line array changed after the facade already published its
      // index-keyed map; refresh it (keeping the observed snapshot identity)
      // instead of leaving entity keys bound to the pre-closure indices.
      const previous = closed.renderProvenance ?? null;
      if (!previous) return;
      try {
        closed.renderProvenance = buildRenderProvenance({
          result: closed,
          snapshotId: previous.snapshotId ?? null,
          budget: previous.budget ?? null,
        });
      } catch {
        closed.renderProvenance = previous;
      }
    },
  });
}
