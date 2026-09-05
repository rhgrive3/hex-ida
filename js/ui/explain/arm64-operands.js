// Presentation compatibility adapter: parses Capstone-style operand text for
// beginner UI only. This module is NOT the canonical machine-semantic decoder.
import { isJa, pick } from "../../i18n.js";

const REG_RE = /^(?:([wx])(\d{1,2})|(wzr|xzr)|(wsp|sp)|(lr|fp)|([bhsdq])(\d{1,2})|(v(\d{1,2})(?:\.(\d*[bhsdq]))?))$/i;
const SHIFT_RE = /^(lsl|lsr|asr|ror|msl)(?:\s+#(-?(?:0x[0-9a-f]+|\d+)))?$/i;
const EXT_RE = /^(uxtb|uxth|uxtw|uxtx|sxtb|sxth|sxtw|sxtx)(?:\s+#(-?(?:0x[0-9a-f]+|\d+)))?$/i;
const IMM_RE = /^#(-?)(0x[0-9a-f]+|\d+(?:\.\d+)?)$/i;
const COND_RE = /^(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/i;
const VEC_ELEM_RE = /^v(\d{1,2})\.([bhsd])\[(\d+)\]$/i;

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function bigOf(text) {
  try {
    if (/^0x/i.test(text)) return BigInt(text);
    if (/\./.test(text)) return null;              // 浮動小数点リテラル
    return BigInt(text);
  } catch { return null; }
}

function parseImm(text) {
  const m = IMM_RE.exec(text);
  if (!m) return null;
  const neg = m[1] === "-";
  if (/\./.test(m[2])) {
    const f = parseFloat(m[2]);
    return { k: "imm", text, value: null, float: neg ? -f : f };
  }
  const v = bigOf(m[2]);
  if (v == null) return null;
  return { k: "imm", text, value: neg ? -v : v };
}

function parseReg(text) {
  const m = REG_RE.exec(text);
  if (!m) return null;
  const t = text.toLowerCase();
  if (m[1]) {
    const n = parseInt(m[2], 10);
    // AArch64 general-purpose names are X0..X30 / W0..W30: encoding 31 is
    // SP or ZR, which have their own spellings handled below (#5340).
    if (n > 30) return null;
    return { k: "reg", text: t, cls: "gp", bits: m[1].toLowerCase() === "x" ? 64 : 32, num: n };
  }
  if (m[3]) return { k: "reg", text: t, cls: "zr", bits: t[0] === "x" ? 64 : 32, num: 31 };
  if (m[4]) return { k: "reg", text: t, cls: "sp", bits: t === "sp" ? 64 : 32, num: 31 };
  if (m[5]) return { k: "reg", text: t, cls: "gp", bits: 64, num: t === "lr" ? 30 : 29 };
  if (m[6]) {
    const bits = { b: 8, h: 16, s: 32, d: 64, q: 128 }[m[6].toLowerCase()];
    const n = parseInt(m[7], 10);
    if (n > 31) return null;
    return { k: "reg", text: t, cls: "fp", bits, num: n };
  }
  if (m[8]) {
    const n = parseInt(m[9], 10);
    if (n > 31) return null;
    // AdvSIMD arrangements are a closed set; an arbitrary lane count such as
    // .0b / .99b / .2q names no architected vector shape (#5449).
    const arr = m[10] || null;
    if (arr && !/^(8b|16b|4h|8h|2s|4s|1d|2d)$/i.test(arr)) return null;
    return { k: "reg", text: t, cls: "vec", bits: 128, num: n, arr };
  }
  return null;
}

/** "[x1, #0x10]!" などを 1 つのメモリオペランドにする。 */
function parseMem(text) {
  // A missing closing bracket must not be silently completed (#5348).
  const bang = text.endsWith("!");
  const core = bang ? text.slice(0, -1) : text;
  if (!core.startsWith("[") || !core.endsWith("]")) return null;
  const inner = core.slice(1, -1);
  const parts = splitTop(inner);
  if (!parts.length) return null;
  const base = parseReg(parts[0]);
  if (!base) return null;
  // An A64 address base is a 64-bit general-purpose register or SP: SIMD/FP
  // registers can be transferred data but never form an address (#5342).
  if (!((base.cls === "gp" && base.bits === 64) || base.cls === "sp")) return null;
  const mem = { k: "mem", text, base, index: null, disp: null, addressDisp: null, writebackDisp: null, shift: null, mode: bang ? "pre" : "offset" };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const imm = parseImm(p);
    // A second immediate / index register names no valid addressing form:
    // keep the operand rejected instead of rewriting it to another address (#5351).
    if (imm) { if (mem.disp) return null; mem.disp = imm; mem.addressDisp = imm; continue; }
    const reg = parseReg(p);
    if (reg) { if (mem.index) return null; mem.index = reg; continue; }
    const sh = SHIFT_RE.exec(p) || EXT_RE.exec(p);
    if (sh) mem.shift = { op: sh[1].toLowerCase(), amount: sh[2] != null ? Number(bigOf(sh[2])) : null };
  }
  if (mem.mode === "pre" && mem.disp) mem.writebackDisp = mem.disp;
  return mem;
}

function isPostIndexRegister(op) {
  return op?.k === "reg" && op.cls === "gp" && op.bits === 64 &&
    Number.isInteger(op.num) && op.num >= 0 && op.num <= 30;
}

/**
 * Capstone の operand 文字列を配列にする。
 * 直前のオペランドに掛かる shift/extend は、そのオペランドの .shift に畳み込む。
 */
export function parseOperands(str) {
  const out = [];
  if (!str) return out;
  for (const raw of splitTop(str)) {
    if (!raw) continue;
    if (raw[0] === "[") {
      const mem = parseMem(raw);
      out.push(mem || { k: "other", text: raw });
      continue;
    }
    if (raw[0] === "{") {
      const regs = splitTop(raw.replace(/^\{/, "").replace(/\}$/, "")).map((r) => parseReg(r) || { k: "other", text: r });
      out.push({ k: "list", text: raw, regs });
      continue;
    }
    const sh = SHIFT_RE.exec(raw) || EXT_RE.exec(raw);
    if (sh && out.length) {
      out[out.length - 1].shift = { op: sh[1].toLowerCase(), amount: sh[2] != null ? Number(bigOf(sh[2])) : null };
      continue;
    }
    const imm = parseImm(raw);
    if (imm) { out.push(imm); continue; }
    const ve = VEC_ELEM_RE.exec(raw);
    if (ve) {
      const num = parseInt(ve[1], 10);
      const size = ve[2].toLowerCase();
      const index = parseInt(ve[3], 10);
      const laneCount = { b: 16, h: 8, s: 4, d: 2 }[size];
      if (num <= 31 && index < laneCount) { out.push({ k: "elem", text: raw, num, size: ve[2], index }); continue; }
    }
    const reg = parseReg(raw);
    if (reg) { out.push(reg); continue; }
    if (COND_RE.test(raw)) { out.push({ k: "cond", text: raw.toLowerCase() }); continue; }
    out.push({ k: "other", text: raw });
  }
  // 後置インデックス: "[x1], #8" は 2 つに割れているので戻す。
  for (let i = 0; i < out.length - 1; i++) {
    const mem = out[i];
    const next = out[i + 1];
    if (mem.k !== "mem" || mem.mode !== "offset" || mem.disp != null ||
        mem.index != null || mem.text.endsWith("!")) continue;
    if (next.k === "imm") {
      // 直後が即値で、かつ元の文字列で "]" のあとにコンマが来ていた場合のみ。
      mem.writebackDisp = next;
      mem.addressDisp = null;
      mem.disp = null;
      mem.mode = "post";
      out.splice(i + 1, 1);
      continue;
    }
    // parseOperands() has no mnemonic. Restrict register post-index folding to
    // the AdvSIMD structure-list shape so unrelated "mem, reg" forms are not
    // silently reinterpreted as writeback (#4105).
    if (i > 0 && out[i - 1].k === "list" && isPostIndexRegister(next)) {
      mem.writebackReg = next;
      mem.addressDisp = null;
      mem.disp = null;
      mem.mode = "post";
      out.splice(i + 1, 1);
    }
  }
  return out;
}

export function absHex(v) {
  return (v < 0n ? "-" : "") + (v < 0n ? -v : v).toString(16).toUpperCase();
}

/** 10 進を必ず添える。0x20 → "0x20（10進で 32）" */
export function immText(op) {
  if (!op) return "";
  if (op.float != null) return String(op.float);
  const v = op.value;
  if (v == null) return op.text;
  const dec = v.toString(10);
  if (v > -10n && v < 10n) return dec;
  if (/^#-?0x/i.test(op.text)) {
    const hex = (v < 0n ? "-0x" : "0x") + (v < 0n ? -v : v).toString(16).toUpperCase();
    return isJa() ? hex + "（10進で " + dec + "）" : hex + " (" + dec + ")";
  }
  return dec;
}

/** 擬似コードに埋める短い形。小さい数は 10 進、大きい数は 16 進。 */
export function immShort(op) {
  if (!op) return "";
  if (op.float != null) return String(op.float);
  const v = op.value;
  if (v == null) return op.text.replace(/^#/, "");
  const a = v < 0n ? -v : v;
  if (a >= 0x10000n) return (v < 0n ? "-0x" : "0x") + a.toString(16).toUpperCase();
  return v.toString(10);
}

function shiftExpr(sh) {
  if (!sh) return "";
  const n = sh.amount;
  switch (sh.op) {
    case "lsl": return " << " + n;
    case "lsr": return " >> " + n;
    case "asr": return " >>a " + n;
    case "ror": return " ror " + n;
    default: return n != null ? " << " + n : "";
  }
}

const EXTEND_OPS = new Set(["uxtb", "uxth", "uxtw", "uxtx", "sxtb", "sxth", "sxtw", "sxtx"]);

function modifiedValueExpr(text, sh) {
  if (!sh) return text;
  if (!EXTEND_OPS.has(sh.op)) return text + shiftExpr(sh);
  const extended = sh.op + "(" + text + ")";
  return sh.amount != null ? extended + " << " + sh.amount : extended;
}

export function memExpr(m) {
  let s = m.base.text;
  if (m.index) {
    const index = modifiedValueExpr(m.index.text, m.shift);
    const needsGrouping = m.shift && EXTEND_OPS.has(m.shift.op) && m.shift.amount != null;
    s += " + " + (needsGrouping ? "(" + index + ")" : index);
  } else if (m.disp && m.disp.value != null && m.disp.value !== 0n && m.mode !== "post") {
    s += (m.disp.value < 0n ? " - " : " + ") + immShort({ ...m.disp, value: m.disp.value < 0n ? -m.disp.value : m.disp.value });
  }
  return s;
}

/** 擬似コードの中で使う短い表記。 */
export function opShort(op) {
  if (!op) return "";
  switch (op.k) {
    case "reg": return modifiedValueExpr(op.text, op.shift);
    case "imm": return immShort(op) + (op.shift ? shiftExpr(op.shift) : "");
    case "mem": return "[" + memExpr(op) + "]";
    case "cond": return op.text;
    case "list": return op.text;
    default: return op.text;
  }
}

const CONDS = {
  eq: { ja: "等しいとき", en: "equal", expr: "==" },
  ne: { ja: "等しくないとき", en: "not equal", expr: "!=" },
  cs: { ja: "符号なしで「以上」のとき", en: "unsigned ≥", expr: ">=u" },
  hs: { ja: "符号なしで「以上」のとき", en: "unsigned ≥", expr: ">=u" },
  cc: { ja: "符号なしで「より小さい」とき", en: "unsigned <", expr: "<u" },
  lo: { ja: "符号なしで「より小さい」とき", en: "unsigned <", expr: "<u" },
  mi: { ja: "結果がマイナスのとき", en: "negative", expr: "< 0" },
  pl: { ja: "結果が 0 以上のとき", en: "zero or positive", expr: ">= 0" },
  vs: { ja: "桁があふれたとき", en: "overflow", expr: "overflow" },
  vc: { ja: "桁があふれなかったとき", en: "no overflow", expr: "no overflow" },
  hi: { ja: "符号なしで「より大きい」とき", en: "unsigned >", expr: ">u" },
  ls: { ja: "符号なしで「以下」のとき", en: "unsigned ≤", expr: "<=u" },
  ge: { ja: "符号ありで「以上」のとき", en: "signed ≥", expr: ">=" },
  lt: { ja: "符号ありで「より小さい」とき", en: "signed <", expr: "<" },
  gt: { ja: "符号ありで「より大きい」とき", en: "signed >", expr: ">" },
  le: { ja: "符号ありで「以下」のとき", en: "signed ≤", expr: "<=" },
  al: { ja: "いつでも", en: "always", expr: "always" },
  nv: { ja: "いつでも", en: "always", expr: "always" },
};

export function condInfo(name) {
  const c = CONDS[name];
  if (!c) return null;
  return { ja: c.ja, en: c.en, expr: c.expr, text: pick(c.ja, c.en) };
}