/* Binary patching and the small ARM64 patch assembler. */
import { parseOperands } from './arm64.js';

export function instructionPatchArchitectureSupported(value) {
  const architecture = String(value || '').toLowerCase();
  return architecture === 'arm64' || architecture === 'arm64e';
}

function integerBigInt(value, name) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value.trim()); } catch { /* handled below */ }
  }
  throw new TypeError(`${name} must be an integer`);
}
function canonicalAddress(value) { try { return integerBigInt(value, 'address').toString(); } catch { return null; } }

// Patch bytes are literal integers 0..255: TypedArray conversion would coerce
// schema-invalid values (256 -> 0, -1 -> 255, 1.5 -> 1, '1' -> 1) into a
// different valid byte, so the stored patch would no longer match the
// caller's request (#5311). Existing Uint8Array input is copied as-is.
function patchBytes(value, name) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of integers 0..255 or a Uint8Array`);
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const byte = value[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${name}[${i}] must be an integer 0..255`);
    }
    out[i] = byte;
  }
  return out;
}

export class PatchSet {
  constructor() { this.items = new Map(); }
  get size() { return this.items.size; }

  add(fileOffset, before, after, meta) {
    const offset = integerBigInt(fileOffset, 'fileOffset');
    if (offset < 0n) throw new RangeError('fileOffset must be non-negative');
    const beforeBytes = patchBytes(before, 'before');
    const afterBytes = patchBytes(after, 'after');
    if (!beforeBytes.length || beforeBytes.length !== afterBytes.length) throw new RangeError('patch before/after must have the same non-zero length');
    const end = offset + BigInt(afterBytes.length);
    for (const item of this.items.values()) {
      const itemEnd = item.offset + BigInt(item.after.length);
      if (offset < itemEnd && item.offset < end && item.offset !== offset) throw new Error(`patch overlaps existing patch at +${item.offset.toString(16)}`);
    }
    const key = offset.toString();
    // meta may only carry descriptive metadata: the validated structural fields
    // are always applied last so caller meta can never overwrite the guard that
    // apply() relies on (e.g. an emptied `before`) (#5791). The own-key
    // defineProperty copy also keeps a `__proto__` meta key from retargeting
    // the stored item.
    const item = {};
    for (const [metaKey, metaValue] of Object.entries(meta || {})) {
      Object.defineProperty(item, metaKey, { value: metaValue, enumerable: true, writable: true, configurable: true });
    }
    Object.assign(item, { offset, before: beforeBytes, after: afterBytes });
    this.items.set(key, item);
  }

  remove(fileOffset) { this.items.delete(integerBigInt(fileOffset, 'fileOffset').toString()); }
  clear() { this.items.clear(); }
  list() { return Array.from(this.items.values()).sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0)); }
  at(fileOffset) { return this.items.get(integerBigInt(fileOffset, 'fileOffset').toString()) || null; }
  byAddress(addr) { const wanted = canonicalAddress(addr); if (wanted == null) return null; for (const it of this.items.values()) if (it.addr != null && canonicalAddress(it.addr) === wanted) return it; return null; }

  async apply(file) {
    if (!file || typeof file.slice !== 'function' || !Number.isFinite(Number(file.size))) throw new TypeError('patch source must be a Blob/File');
    const patches = this.list();
    const parts = [];
    let cursor = 0;
    for (const it of patches) {
      const at = Number(it.offset);
      if (!Number.isSafeInteger(at) || at < 0 || at + it.after.length > file.size) throw new Error('書き換え位置がファイルの範囲外です: +' + it.offset.toString(16));
      const actual = new Uint8Array(await file.slice(at, at + it.before.length).arrayBuffer());
      if (actual.length !== it.before.length) throw new Error('元のバイトを検証できません: +' + it.offset.toString(16));
      for (let i = 0; i < it.before.length; i++) if (actual[i] !== it.before[i]) throw new Error('元のバイトが変わっています: +' + it.offset.toString(16));
      if (cursor < at) parts.push(file.slice(cursor, at));
      parts.push(it.after);
      cursor = at + it.after.length;
    }
    if (cursor < file.size) parts.push(file.slice(cursor));
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

const CONDS = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'];
const COND_ALIASES = Object.freeze({ hs: 'cs', lo: 'cc' });

export function assemble(text, at) {
  const raw = String(text || '');
  const parts = raw.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: '命令が空です。' };
  const base = BigInt(at ?? 0n);
  if (parts.length === 1) return assembleOne(parts[0], base);
  const out = new Uint8Array(parts.length * 4);
  for (let i = 0; i < parts.length; i++) {
    const built = assembleOne(parts[i], base + BigInt(i * 4));
    if (built.error) return { error: `${i + 1} 命令目 (${parts[i]}): ${built.error}` };
    out.set(built.bytes, i * 4);
  }
  return { bytes: out };
}

function assembleOne(text, at) {
  const src = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!src) return { error: '命令が空です。' };
  const sp = src.indexOf(' '); const mn = sp < 0 ? src : src.slice(0, sp); const rest = sp < 0 ? '' : src.slice(sp + 1); const ops = parseOperands(rest);
  // Surplus operands change the requested instruction (e.g. `ret x0` into the
  // x30 default) or are silently dropped by handlers that only read the leading
  // operands — validate the exact arity per supported mnemonic first (#5795).
  const arityError = checkOperandArity(mn, ops);
  if (arityError) return { error: arityError };
  if (mn === 'nop') return word(0xD503201F);
  if (mn === 'ret') {
    if (ops.length === 0) return word(0xD65F03C0);
    const reg = regInfo(ops[0]);
    if (!reg || reg.sp || reg.zr || reg.bits !== 64) return { error: 'ret の右側は 64bit 汎用レジスタ（x0〜x30）で指定してください。' };
    return word(0xD65F0000 | (reg.num << 5));
  }
  if (mn === 'brk') { const imm = immOf(ops[0]); if (imm == null || imm < 0n || imm > 0xFFFFn) return { error: 'brk の値は 0〜0xFFFF です。' }; return word(0xD4200000 | (Number(imm) << 5)); }
  if (mn === 'mov' || mn === 'movz' || mn === 'movn') {
    const dst = regInfo(ops[0]); const d = dst && dst.num; const imm = immOf(ops[1]);
    if (d == null) return { error: '書き込み先のレジスタが読めません。' };
    // MOVZ / MOVN have no register-source form. Falling through to the register
    // MOV encoding silently rewrote the mnemonic (#5798).
    if ((mn === 'movz' || mn === 'movn') && imm == null) return { error: `${mn} の右側は即値（#0〜#65535）で指定してください。` };
    const shiftError = checkMoveWideShift(mn, ops, dst.bits);
    if (shiftError) return { error: shiftError };
    const hw = ops[1].shift ? Number(ops[1].shift.amount) / 16 : 0;
    if (mn === 'movn') {
      if (imm < 0n || imm > 0xFFFFn) return { error: 'movn の即値は 0〜65535 で指定してください。' };
      if (dst.sp) return { error: 'SP へ即値を直接 movn することはできません。' };
      const sf = dst.bits === 64 ? 1 : 0;
      return word((sf << 31) | (0x25 << 23) | (hw << 21) | (Number(imm) << 5) | d);
    }
    if (imm != null) {
      if (dst.sp) return { error: 'SP へ即値を直接 mov することはできません。' };
      const sf = dst.bits === 64 ? 1 : 0;
      if (mn === 'mov' && imm < 0n && imm >= -0x10000n) {
        const inv = Number(-1n - imm);
        return word((sf << 31) | (0x25 << 23) | (inv << 5) | d);
      }
      if (imm < 0n || imm > 0xFFFFn) return { error: 'この簡易アセンブラでは -65536〜65535（movz は 0〜65535）の値だけ書けます。' };
      return word((sf << 31) | (0xA5 << 23) | (hw << 21) | (Number(imm) << 5) | d);
    }
    const srcReg = regInfo(ops[1]); const m = srcReg && srcReg.num;
    if (m == null) return { error: 'mov の右側が読めません。' };
    if (dst.bits !== srcReg.bits) return { error: 'mov の左右は同じ幅（w同士 / x同士）で指定してください。' };
    const sf = dst.bits === 64 ? 1 : 0;
    if (dst.sp || srcReg.sp) { if (dst.zr || srcReg.zr) return { error: 'SP と ZR の間は mov できません。' }; return word((sf << 31) | 0x11000000 | (m << 5) | d); }
    return word((sf << 31) | (0x150 << 21) | (m << 16) | (31 << 5) | d);
  }
  if (mn === 'b' || mn === 'bl') {
    const target = immOf(ops[0]); if (target == null) return { error: '飛び先のアドレスが読めません（0x… の形で書いてください）。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n; if (delta < -(1n << 25n) || delta >= (1n << 25n)) return { error: '飛び先が遠すぎます（±128 MB まで）。' };
    return word(((mn === 'bl' ? 1 : 0) << 31) | (0x05 << 26) | Number(BigInt.asUintN(26, delta)));
  }
  if (mn === 'cbz' || mn === 'cbnz') {
    const rt = regInfo(ops[0]);
    if (!rt || rt.sp) return { error: `${mn} の 1 つ目は汎用レジスタ（w0〜w30 / x0〜x30）で指定してください。` };
    const target = immOf(ops[1]); if (target == null) return { error: '飛び先のアドレスが読めません（0x… の形で書いてください）。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n; if (delta < -(1n << 18n) || delta >= (1n << 18n)) return { error: '条件分岐の飛び先が遠すぎます（±1 MB まで）。' };
    const sf = rt.bits === 64 ? 1 : 0;
    const op = mn === 'cbnz' ? 1 : 0;
    return word((sf << 31) | (0x34 << 24) | (op << 24) | (Number(BigInt.asUintN(19, delta)) << 5) | rt.num);
  }
  if (mn === 'tbz' || mn === 'tbnz') {
    const rt = regInfo(ops[0]);
    if (!rt || rt.sp) return { error: `${mn} の 1 つ目は汎用レジスタ（w0〜w30 / x0〜x30）で指定してください。` };
    const bit = immOf(ops[1]);
    const maxBit = rt.bits === 64 ? 63n : 31n;
    if (bit == null || bit < 0n || bit > maxBit) return { error: `${mn} のビット番号は 0〜${maxBit} で指定してください。` };
    const target = immOf(ops[2]); if (target == null) return { error: '飛び先のアドレスが読めません（0x… の形で書いてください）。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n; if (delta < -(1n << 13n) || delta >= (1n << 13n)) return { error: `${mn} の飛び先が遠すぎます（±32 KB まで）。` };
    const bitNum = Number(bit);
    const b5 = (bitNum >>> 5) & 1;
    const b40 = bitNum & 0x1F;
    const op = mn === 'tbnz' ? 1 : 0;
    return word((b5 << 31) | (0x36 << 24) | (op << 24) | (b40 << 19) | (Number(BigInt.asUintN(14, delta)) << 5) | rt.num);
  }
  const bc = /^b\.(\w+)$/.exec(mn);
  if (bc) {
    const condName = COND_ALIASES[bc[1]] || bc[1];
    const cond = CONDS.indexOf(condName); if (cond < 0) return { error: '知らない条件です: ' + bc[1] };
    const target = immOf(ops[0]); if (target == null) return { error: '飛び先のアドレスが読めません。' };
    if ((target - at) % 4n !== 0n) return { error: '飛び先は 4 バイト境界で指定してください。' };
    const delta = (target - at) / 4n; if (delta < -(1n << 18n) || delta >= (1n << 18n)) return { error: '条件分岐の飛び先が遠すぎます（±1 MB まで）。' };
    return word((0x54 << 24) | (Number(BigInt.asUintN(19, delta)) << 5) | cond);
  }
  return { error: 'この簡易アセンブラは ' + mn + ' に対応していません。16 進で直接指定してください。' };
}

/** Decode a 32-bit ARM64 instruction word produced by the patch assembler. */
export function decodeArm64PatchWord(wordVal, at = 0n) {
  const u = wordVal >>> 0;
  const pc = BigInt(at || 0n);
  if (u === 0xD503201F) return { mn: 'nop', ops: '' };
  if (((u & 0xFFFFFC1F) >>> 0) === 0xD65F0000) {
    const rn = (u >>> 5) & 0x1F;
    return { mn: 'ret', ops: rn === 30 ? '' : 'x' + rn };
  }
  if (((u & 0xFFE0001F) >>> 0) === 0xD4200000) {
    const imm = (u >>> 5) & 0xFFFF;
    return { mn: 'brk', ops: '#0x' + imm.toString(16) };
  }
  if ((u & 0x7F800000) === 0x52800000 || (u & 0x7F800000) === 0x12800000) {
    const isMovz = (u & 0x7F800000) === 0x52800000;
    const sf = (u >>> 31) & 1;
    const hw = (u >>> 21) & 3;
    if (!sf && hw >= 2) return null;
    const imm16 = (u >>> 5) & 0xFFFF;
    const rd = u & 0x1F;
    const p = sf ? 'x' : 'w';
    const reg = rd === 31 ? p + 'zr' : p + rd;
    const shift = hw ? ', lsl #' + (hw * 16) : '';
    return { mn: isMovz ? 'movz' : 'movn', ops: `${reg}, #0x${imm16.toString(16)}${shift}` };
  }
  if ((u & 0x7FE0FFE0) === 0x2A0003E0) {
    const sf = (u >>> 31) & 1;
    const rm = (u >>> 16) & 0x1F;
    const rd = u & 0x1F;
    const p = sf ? 'x' : 'w';
    return { mn: 'mov', ops: `${rd === 31 ? p + 'zr' : p + rd}, ${rm === 31 ? p + 'zr' : p + rm}` };
  }
  if ((u & 0x7FFFFC00) === 0x11000000) {
    const sf = (u >>> 31) & 1;
    const rn = (u >>> 5) & 0x1F;
    const rd = u & 0x1F;
    const p = sf ? 'x' : 'w';
    const spName = sf ? 'sp' : 'wsp';
    return { mn: 'mov', ops: `${rd === 31 ? spName : p + rd}, ${rn === 31 ? spName : p + rn}` };
  }
  if ((u & 0x7C000000) === 0x14000000) {
    const isBl = (u >>> 31) & 1;
    const imm26 = u & 0x03FFFFFF;
    const signed = imm26 & 0x02000000 ? imm26 - 0x04000000 : imm26;
    const target = pc + BigInt(signed) * 4n;
    return { mn: isBl ? 'bl' : 'b', ops: '#0x' + target.toString(16) };
  }
  if (((u & 0xFF000010) >>> 0) === 0x54000000) {
    const cond = CONDS[u & 0x0F];
    if (!cond) return null;
    const imm19 = (u >>> 5) & 0x7FFFF;
    const signed = imm19 & 0x40000 ? imm19 - 0x80000 : imm19;
    const target = pc + BigInt(signed) * 4n;
    return { mn: 'b.' + cond, ops: '#0x' + target.toString(16) };
  }
  if ((u & 0x7E000000) === 0x34000000) {
    const sf = (u >>> 31) & 1;
    const op = (u >>> 24) & 1;
    const imm19 = (u >>> 5) & 0x7FFFF;
    const rt = u & 0x1F;
    const signed = imm19 & 0x40000 ? imm19 - 0x80000 : imm19;
    const target = pc + BigInt(signed) * 4n;
    const p = sf ? 'x' : 'w';
    const reg = rt === 31 ? p + 'zr' : p + rt;
    return { mn: op ? 'cbnz' : 'cbz', ops: `${reg}, #0x${target.toString(16)}` };
  }
  if ((u & 0x7E000000) === 0x36000000) {
    const b5 = (u >>> 31) & 1;
    const op = (u >>> 24) & 1;
    const b40 = (u >>> 19) & 0x1F;
    const bit = (b5 << 5) | b40;
    const imm14 = (u >>> 5) & 0x3FFF;
    const rt = u & 0x1F;
    const signed = imm14 & 0x2000 ? imm14 - 0x4000 : imm14;
    const target = pc + BigInt(signed) * 4n;
    const p = b5 ? 'x' : 'w';
    const reg = rt === 31 ? p + 'zr' : p + rt;
    return { mn: op ? 'tbnz' : 'tbz', ops: `${reg}, #${bit}, #0x${target.toString(16)}` };
  }
  return null;
}

function word(v) { const out = new Uint8Array(4); out[0] = v & 0xff; out[1] = (v >>> 8) & 0xff; out[2] = (v >>> 16) & 0xff; out[3] = (v >>> 24) & 0xff; return { bytes: out }; }
function checkOperandArity(mn, ops) {
  if (mn === 'nop') return ops.length === 0 ? null : 'nop は operand を取りません。';
  if (mn === 'ret') return ops.length <= 1 ? null : 'ret は 0 または 1 個の operand（x0〜x30）で指定してください。';
  if (mn === 'brk') return ops.length === 1 ? null : 'brk は即値 1 個（#0〜#65535）で指定してください。';
  if (mn === 'mov' || mn === 'movz' || mn === 'movn') {
    if (ops.length === 2) return null;
    if (mn === 'movz') return 'movz はレジスタと即値（#0〜#65535）で指定してください。';
    if (mn === 'movn') return 'movn はレジスタと即値（#0〜#65535）で指定してください。';
    return 'mov はレジスタ 2 個か、レジスタと即値（#-65536〜#65535）で指定してください。';
  }
  if (mn === 'b' || mn === 'bl') return ops.length === 1 ? null : (mn === 'b' ? 'b は飛び先 1 個で指定してください。' : 'bl は飛び先 1 個で指定してください。');
  if (mn === 'cbz' || mn === 'cbnz') return ops.length === 2 ? null : `${mn} はレジスタと飛び先の 2 個で指定してください。`;
  if (mn === 'tbz' || mn === 'tbnz') return ops.length === 3 ? null : `${mn} はレジスタ・ビット番号・飛び先の 3 個で指定してください。`;
  if (/^b\.\w+$/.test(mn)) return ops.length === 1 ? null : '条件分岐は飛び先 1 個で指定してください。';
  return null;
}
function checkMoveWideShift(mn, ops, dstBits) {
  const movMsg = 'mov はレジスタ 2 個か、レジスタと即値（#-65536〜#65535）で指定してください。';
  const wideMsg = `${mn} はレジスタと即値（#0〜#65535）に LSL #0/#16/#32/#48（W 形式は #0/#16）を指定してください。`;
  const msg = mn === 'mov' ? movMsg : wideMsg;
  if (ops[0] && ops[0].shift) return msg;
  const sh = ops[1] && ops[1].shift;
  if (!sh) return null;
  if (mn === 'mov') return msg;
  if (sh.op !== 'lsl' || !Number.isInteger(sh.amount) || sh.amount < 0 || sh.amount > 48 || sh.amount % 16 !== 0) return msg;
  if (dstBits === 32 && sh.amount > 16) return msg;
  return null;
}
function regNum(op) { if (!op || op.k !== 'reg') return null; if (op.cls === 'zr' || op.cls === 'sp') return 31; if (op.cls !== 'gp') return null; return op.num; }
function regInfo(op) { const num = regNum(op); if (num == null) return null; return { num, bits: op.bits === 32 ? 32 : 64, sp: op.cls === 'sp', zr: op.cls === 'zr' }; }
function immOf(op) { if (!op) return null; if (op.k === 'imm') return op.value; if (op.k === 'other' && /^0x[0-9a-f]+$/.test(op.text)) return BigInt(op.text); return null; }

export function suggestPatches(mn, opsStr, addr, options = {}) {
  const base = (mn || '').toLowerCase(); const out = [];
  out.push({ id: 'nop', label: 'この命令を何もしない（nop）にする', why: '呼び出しやチェックを 1 つ飛ばして、どう変わるか試すときに使います。', text: 'nop' });
  const cond = /^b\.(\w+)$/.exec(base);
  if (cond) {
    const inv = { eq: 'ne', ne: 'eq', lt: 'ge', ge: 'lt', gt: 'le', le: 'gt', hi: 'ls', ls: 'hi', hs: 'lo', lo: 'hs', cs: 'cc', cc: 'cs', mi: 'pl', pl: 'mi', vs: 'vc', vc: 'vs' }[cond[1]];
    const target = targetOf(opsStr);
    if (inv && target != null) {
      out.push({ id: 'invert', label: '条件を反対にする（b.' + cond[1] + ' → b.' + inv + '）', why: '「合っていたら通す」を「間違っていたら通す」に入れ替えます。判定の効き目を確かめられます。', text: 'b.' + inv + ' 0x' + target.toString(16) });
      out.push({ id: 'always', label: 'いつも飛ぶようにする（b）', why: '条件を無視して、必ず飛び先へ進みます。', text: 'b 0x' + target.toString(16) });
    }
  }
  if (base === 'cbz' || base === 'cbnz') {
    const ops = parseOperands(String(opsStr || '').toLowerCase());
    const reg = ops[0] && ops[0].k === 'reg' ? ops[0].text : null;
    const target = immOf(ops[1]) ?? targetOf(opsStr);
    const inv = base === 'cbz' ? 'cbnz' : 'cbz';
    if (reg && target != null) {
      out.push({ id: 'invert', label: `条件を反対にする（${base} → ${inv}）`, why: '0 かどうかでの分岐条件を逆転させて、判定の効き目を確かめます。', text: `${inv} ${reg}, 0x${target.toString(16)}` });
      out.push({ id: 'always', label: 'いつも飛ぶようにする（b）', why: 'レジスタの値に関わらず、必ず飛び先へ進みます。', text: 'b 0x' + target.toString(16) });
    }
  }
  if (base === 'tbz' || base === 'tbnz') {
    const ops = parseOperands(String(opsStr || '').toLowerCase());
    const reg = ops[0] && ops[0].k === 'reg' ? ops[0].text : null;
    const bit = immOf(ops[1]);
    const target = immOf(ops[2]) ?? targetOf(ops[2]?.text);
    const inv = base === 'tbz' ? 'tbnz' : 'tbz';
    if (reg && bit != null && target != null) {
      out.push({ id: 'invert', label: `条件を反対にする（${base} → ${inv}）`, why: 'ビットが立っているかどうかの分岐条件を逆転させます。', text: `${inv} ${reg}, #${bit}, 0x${target.toString(16)}` });
      out.push({ id: 'always', label: 'いつも飛ぶようにする（b）', why: 'ビットの値に関わらず、必ず飛び先へ進みます。', text: 'b 0x' + target.toString(16) });
    }
  }
  if (base === 'bl' || base === 'blr') {
    out.push({ id: 'ret0', label: '呼び出しをやめて 0 を返す（mov w0, #0）', why: 'その関数を呼ばずに「失敗（0）」を返させます。チェック関数を無効にするときの定番です。', text: 'mov w0, #0' });
    out.push({ id: 'ret1', label: '呼び出しをやめて 1 を返す（mov w0, #1）', why: 'その関数を呼ばずに「成功（1）」を返させます。', text: 'mov w0, #1' });
    out.push({ id: 'retNeg1', label: '呼び出しをやめて -1 を返す（movn w0, #0）', why: 'その関数を呼ばずに「エラー（-1）」を返させます。', text: 'movn w0, #0' });
  }
  if (base === 'ret') out.push({ id: 'brk', label: 'ここで止める（brk #0）', why: '通ったかどうかを確かめるための印です。', text: 'brk #0' });
  const availableBytes = Number(options?.availableBytes || 0);
  if (availableBytes >= 8) {
    out.push({ id: 'always_true', label: '常に true (1) を返す（mov w0, #1; ret）', why: 'この位置から先を実行せず、戻り値 1（true）で即座に関数を終了します（2 命令 / 8 バイト）。', text: 'mov w0, #1; ret', bytes: 8 });
    out.push({ id: 'always_false', label: '常に false (0) を返す（mov w0, #0; ret）', why: 'この位置から先を実行せず、戻り値 0（false）で即座に関数を終了します（2 命令 / 8 バイト）。', text: 'mov w0, #0; ret', bytes: 8 });
    out.push({ id: 'always_neg1', label: '常に -1 を返す（movn w0, #0; ret）', why: 'この位置から先を実行せず、戻り値 -1 で即座に関数を終了します（2 命令 / 8 バイト）。', text: 'movn w0, #0; ret', bytes: 8 });
  }
  void addr; return out;
}

function targetOf(opsStr) { const m = /#?(0x[0-9a-f]+)/i.exec(opsStr || ''); return m ? BigInt(m[1]) : null; }
export function parseHexBytes(text) { const raw = String(text || '').trim(); if (!isHexBytes(raw)) return null; const clean = raw.replace(/0x/gi, '').replace(/[\s,]+/g, ''); if (!clean.length || clean.length % 2) return null; const out = new Uint8Array(clean.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16); return out; }
export function isHexBytes(text) { const raw = String(text || '').trim(); if (!raw) return false; if (/^(?:0x)?[0-9a-f]+$/i.test(raw)) { const s = raw.replace(/^0x/i, ''); return s.length > 0 && s.length % 2 === 0; } return /^(?:0x)?[0-9a-f]{2}(?:[\s,]+(?:0x)?[0-9a-f]{2})+$/i.test(raw); }

export function validatePatchRange(region, addr, length, fileSize, instruction = true) {
  if (!region) return { error: 'コードのセクションが見つかりません。' };
  let a;
  try { a = integerBigInt(addr, 'address'); } catch { return { error: 'アドレスが不正です。' }; }
  const n = length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return { error: '書き換える長さが不正です。' };
  if (instruction && ((a - region.vmAddr) % 4n !== 0n || n !== 4)) return { error: '命令の位置と長さは 4 バイト境界で指定してください。' };
  const rel = a - region.vmAddr; if (rel < 0n || rel + BigInt(n) > region.size) return { error: 'アドレスがコードのセクション範囲外です。' };
  const offset = region.fileOffset + rel;
  let totalSize = null;
  if (fileSize != null) {
    try { totalSize = integerBigInt(fileSize, 'fileSize'); } catch { return { error: 'ファイルサイズが不正です。' }; }
    if (totalSize < 0n) return { error: 'ファイルサイズが不正です。' };
  }
  if (offset < 0n || (totalSize != null && offset + BigInt(n) > totalSize)) return { error: '書き換え位置がファイル範囲外です。' };
  return { ok: true, fileOffset: offset };
}

export function validateMultiInstructionPatchRange(region, addr, length, fileSize) {
  if (!region) return { error: 'コードのセクションが見つかりません。' };
  let a;
  try { a = integerBigInt(addr, 'address'); } catch { return { error: 'アドレスが不正です。' }; }
  const n = length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 4 || n % 4 !== 0) {
    return { error: '命令の長さは 4 バイトの倍数で指定してください。' };
  }
  if ((a - region.vmAddr) % 4n !== 0n) return { error: '命令の位置は 4 バイト境界で指定してください。' };
  return validatePatchRange(region, a, n, fileSize, false);
}

export function hexOf(bytes) { return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '); }
