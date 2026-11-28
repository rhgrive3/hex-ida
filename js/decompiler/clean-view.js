/**
 * Clean View Decompiler Presentation Module.
 *
 * Pure, deterministic post-decompile presentation pass that:
 *  1. Hides fixed-width primitive / `id` typedef preludes while keeping recovered `typedef struct ...` definitions.
 *  2. Conservatively and soundly elides dead stack spill assignments (`var_XX = <pure>;`) and unused local declarations.
 *  3. Conservatively folds ARM64 callee-saved register prologue/epilogue stack spill save/restore pairs.
 *  4. Delegates ObjC / Swift / ARC / 4-ABI symbol demangling to `refineAppleSwiftDecompile`.
 *
 * INV-005 compliant: ZERO imports from `js/targets/architecture/`.
 */

import { refineAppleSwiftDecompile } from './apple-arc-swift-pass.js';

const PRELUDE_TYPEDEF_ALIASES = new Set([
  'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
  'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t',
  'uintptr_t', 'intptr_t', 'size_t', 'ssize_t', 'ptrdiff_t',
  'uint128', 'int128', 'vector128',
  'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64', 'i8', 'i16', 'i32', 'i64',
  'BYTE', 'WORD', 'DWORD', 'QWORD', 'BOOL', '_BOOL', 'bool',
  'id', 'SEL', 'Class', 'IMP',
]);

const PRIMITIVE_TYPEDEF_RHS_RE = /^(?:(?:signed|unsigned)\s+)?(?:char|short(?:\s+int)?|int|long(?:\s+int)?|long\s+long(?:\s+int)?|__int128|float|double|long\s+double|__[A-Za-z0-9_]+__)$|^void\s*\*$/;

const VAR_NAME_RE = /^var_[0-9A-Za-z_]+$/;
const VAR_TOKEN_RE = /\b(var_[0-9A-Za-z_]+)\b/g;
const ADDR_OF_VAR_RE = /&\s*(var_[0-9A-Za-z_]+)\b/g;

const LOCAL_DECL_RE = /^\s*(?!return\b|goto\b|break\b|continue\b|case\b|else\b|typedef\b|delete\b|struct\b|union\b|enum\b)(?:(?:const|register|static|unsigned|signed|long|short)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+)(var_[0-9A-Za-z_]+)\s*;\s*$/;
const ANY_LOCAL_DECL_RE = /^\s*(?!return\b|goto\b|break\b|continue\b|case\b|else\b|typedef\b|delete\b|struct\b|union\b|enum\b)(?:(?:const|register|static|unsigned|signed|long|short)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+)[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]*\])?\s*;\s*$/;
const SPILL_ASSIGN_RE = /^\s*(var_[0-9A-Za-z_]+)\s*=(?!=)\s*([^;]+);\s*$/;

const CALL_IN_RHS_RE = /[A-Za-z_][\w:.$]*\s*\(/;
const INC_DEC_RE = /(\+\+|--)/;
const VOLATILE_RE = /\bvolatile\b/;

const CALLEE_SAVED_REGS = new Set([
  'x19', 'x20', 'x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'x30',
  'fp', 'lr',
  'd8', 'd9', 'd10', 'd11', 'd12', 'd13', 'd14', 'd15',
]);

const PROLOGUE_ONLY_CALLEE_SAVED_REGS = new Set([
  'x19', 'x20', 'x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'x30',
  'fp', 'lr',
]);

const STACK_PTR_TYPE_SRC = '(?:uint64(?:_t)?|int64(?:_t)?|uintptr_t|double)\\s*\\*';
const KNOWN_SCALAR_TYPE_SRC = '(?:(?:const|volatile)\\s+)*(?:(?:unsigned|signed)\\s+(?:long\\s+long|long|short|int|char)|long\\s+long|long\\s+double|void|bool|_Bool|char|short|int|long|float|double|u?int(?:8|16|32|64|128)(?:_t)?|u?intptr_t|s?size_t|id)';
const ANY_STACK_PTR_TYPE_SRC = `${KNOWN_SCALAR_TYPE_SRC}\\s*\\*+`;
const STACK_ADDR_SRC = '(?:\\(\\s*uintptr_t\\s*\\)\\s*)?(?:\\(\\s*sp\\s*\\)|\\bsp\\b)(?:\\s*([+-])\\s*(0x[0-9a-fA-F]+|\\d+))?';

const CALLEE_SAVE_RE = new RegExp(
  `^\\s*\\*\\s*\\(\\s*${STACK_PTR_TYPE_SRC}\\s*\\)\\s*\\(\\s*${STACK_ADDR_SRC}\\s*\\)\\s*=(?!=)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*;\\s*$`
);
const CALLEE_RESTORE_RE = new RegExp(
  `^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=(?!=)\\s*\\*\\s*\\(\\s*${STACK_PTR_TYPE_SRC}\\s*\\)\\s*\\(\\s*${STACK_ADDR_SRC}\\s*\\)\\s*;\\s*$`
);
const STACK_SLOT_REF_RE = new RegExp(
  `\\*\\s*\\(\\s*${ANY_STACK_PTR_TYPE_SRC}\\s*\\)\\s*\\(\\s*${STACK_ADDR_SRC}\\s*\\)`,
  'g'
);

const SP_TOKEN_RE = /\bsp\b/;
const SP_SELF_ADJUST_RE = /^\s*sp\s*(?:=\s*sp\s*[+-]|[+-]=)\s*([^;]+);\s*$/;
const SP_DECL_INIT_RE = /^\s*(?:(?:const|register|static|unsigned|signed|long|short)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+)sp(?:\s*=(?!=)\s*([^;]+))?\s*;\s*$/;
const TYPE_BLOCK_HEAD_RE = /^\s*(?:typedef|struct|union|enum)\b/;
const BRACELESS_CTRL_RE = /^\s*(?:(?:\}\s*)?else(?:\s+if\s*\(.+\))?|(?:if|while|for|switch)\s*\(.+\)|do)\s*$/;
const RETURN_STMT_RE = /^\s*return(?:\s+[^;]+)?;\s*$/;
const SSA_CALLEE_SAVE_RE = /^\s*(local_[mp][0-9A-Fa-f]+)\s*=(?!=)\s*(local_(?:x(?:19|2[0-9]|30)|fp|lr|d(?:[89]|1[0-5])))\s*;\s*$/;
const SSA_CALLEE_RESTORE_RE = /^\s*(local_(?:x(?:19|2[0-9]|30)|fp|lr|d(?:[89]|1[0-5])))\s*=(?!=)\s*(local_[mp][0-9A-Fa-f]+)\s*;\s*$/;
const SIMPLE_LOCAL_DECL_NAME_RE = /^\s*(?!return\b|goto\b|break\b|continue\b|case\b|else\b|typedef\b|delete\b|struct\b|union\b|enum\b)(?:(?:const|register|static|unsigned|signed|long|short)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+)([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/;

const REG_ALIAS_CACHE = new Map();
const REG_WRITE_RE_CACHE = new Map();
const REG_READ_MATCHER_CACHE = new Map();

function getLineText(item) {
  return typeof item === 'string' ? item : String(item?.text ?? '');
}

function setLineText(item, newText) {
  if (typeof item === 'string') return newText;
  return { ...item, text: newText };
}

function stripCommentsPreservingStrings(line) {
  let out = '';
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < line.length) {
        out += line[++i];
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      break;
    }
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' ';
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Strips single-line comments, multi-line block comments, and string/char literal
 * contents across all lines so brace-depth and identifier scans ignore comments/strings.
 */
function sanitizeLinesForAnalysis(lines) {
  const sanitized = new Array(lines.length);
  let inBlockComment = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = getLineText(lines[idx]);
    let out = '';
    let inQuote = null;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBlockComment) {
        if (ch === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          out += ' ';
          i++;
        }
        continue;
      }
      if (inQuote) {
        if (ch === '\\' && i + 1 < line.length) {
          i++;
        } else if (ch === inQuote) {
          out += ch;
          inQuote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        out += ch;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        break;
      }
      if (ch === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        out += ' ';
        i++;
        continue;
      }
      out += ch;
    }

    sanitized[idx] = out;
  }

  return sanitized;
}

function isPureSpillRhs(rhs) {
  if (!rhs || !rhs.trim()) return false;
  if (CALL_IN_RHS_RE.test(rhs)) return false;
  if (INC_DEC_RE.test(rhs)) return false;
  if (VOLATILE_RE.test(rhs)) return false;
  if (rhs.includes('=')) return false;
  return true;
}

function parseStackOffset(sign, rawNum) {
  if (!rawNum) return 0;
  const parsed = rawNum.toLowerCase().startsWith('0x')
    ? parseInt(rawNum, 16)
    : parseInt(rawNum, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  const val = sign === '-' ? -parsed : parsed;
  return val === 0 ? 0 : val;
}

function getRegAliases(reg) {
  let aliases = REG_ALIAS_CACHE.get(reg);
  if (aliases) return aliases;

  if (reg === 'x29' || reg === 'w29' || reg === 'fp') {
    aliases = ['x29', 'w29', 'fp'];
  } else if (reg === 'x30' || reg === 'w30' || reg === 'lr') {
    aliases = ['x30', 'w30', 'lr'];
  } else if (/^[xw](19|2[0-8])$/.test(reg)) {
    const num = reg.slice(1);
    aliases = [`x${num}`, `w${num}`];
  } else if (/^[dsvqhb](8|9|1[0-5])$/.test(reg)) {
    const num = reg.slice(1);
    aliases = [`d${num}`, `s${num}`, `v${num}`, `q${num}`, `h${num}`, `b${num}`];
  } else {
    aliases = [reg];
  }

  REG_ALIAS_CACHE.set(reg, aliases);
  return aliases;
}

function lineWritesReg(cleanCode, reg) {
  let writeRe = REG_WRITE_RE_CACHE.get(reg);
  if (!writeRe) {
    const alt = getRegAliases(reg).join('|');
    writeRe = new RegExp(
      `(?:\\b(?:${alt})\\s*(?:[+\\-*/%&|^]|<<|>>)?=(?!=)|(?:\\+\\+|--)\\s*\\b(?:${alt})\\b|\\b(?:${alt})\\b\\s*(?:\\+\\+|--)|&\\s*\\b(?:${alt})\\b)`
    );
    REG_WRITE_RE_CACHE.set(reg, writeRe);
  }
  return writeRe.test(cleanCode);
}

function lineReadsReg(cleanCode, reg) {
  let matchers = REG_READ_MATCHER_CACHE.get(reg);
  if (!matchers) {
    const alt = getRegAliases(reg).join('|');
    matchers = {
      tokenRe: new RegExp(`\\b(?:${alt})\\b`),
      plainAssignRe: new RegExp(`^\\s*(?:${alt})\\s*=(?!=)\\s*([\\s\\S]*)$`),
    };
    REG_READ_MATCHER_CACHE.set(reg, matchers);
  }
  const assignMatch = matchers.plainAssignRe.exec(cleanCode);
  if (assignMatch) {
    return matchers.tokenRe.test(assignMatch[1]);
  }
  return matchers.tokenRe.test(cleanCode);
}

function isRecognizedSpAdjustmentOrDecl(cleanCode) {
  const selfAdj = SP_SELF_ADJUST_RE.exec(cleanCode);
  if (selfAdj) {
    return !SP_TOKEN_RE.test(selfAdj[1]);
  }
  const declInit = SP_DECL_INIT_RE.exec(cleanCode);
  if (declInit) {
    return !declInit[1] || !SP_TOKEN_RE.test(declInit[1]);
  }
  return false;
}

function isEarlyReturnRestore(sanitizedLines, restoreIdx) {
  let seenReturn = false;
  for (let k = restoreIdx + 1; k < sanitizedLines.length; k++) {
    const trimmed = sanitizedLines[k].trim();
    if (!trimmed) continue;
    if (trimmed === '}') {
      return seenReturn;
    }
    if (seenReturn) {
      return false;
    }
    if (RETURN_STMT_RE.test(trimmed)) {
      seenReturn = true;
      continue;
    }
    const restoreMatch = CALLEE_RESTORE_RE.exec(trimmed);
    if (restoreMatch && CALLEE_SAVED_REGS.has(restoreMatch[1])) {
      continue;
    }
    if (SSA_CALLEE_RESTORE_RE.test(trimmed)) {
      continue;
    }
    return false;
  }
  return seenReturn;
}

/**
 * Returns true for fixed-width primitive/id prelude typedefs such as
 * `typedef unsigned char uint8;`, `typedef long long int64;`, `typedef void * id;`, etc.
 * Does NOT hide `typedef struct ...` (or union/enum/function-pointer) definitions.
 */
export function isTypedefPreludeLine(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('typedef ')) return false;
  if (/\b(?:struct|union|enum)\b/.test(trimmed) || trimmed.includes('{') || trimmed.includes('(')) {
    return false;
  }
  if (/^typedef\s+void\s*\*\s*id\s*;$/.test(trimmed)) {
    return true;
  }
  const match = /^typedef\s+(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(trimmed);
  if (!match) return false;
  const underlying = match[1].replace(/\s+/g, ' ').trim();
  const alias = match[2];
  return PRELUDE_TYPEDEF_ALIASES.has(alias) && PRIMITIVE_TYPEDEF_RHS_RE.test(underlying);
}

/**
 * Conservatively and soundly elides dead local stack spill assignments (`var_XX = <pure>;`)
 * and now-unused local declarations (`<type> var_XX;`).
 *
 * @param {Array<string|{ kind?: string, indent?: number, text: string }>} lines
 * @returns {{ lines: Array, stats: { deadSpillsElided: number, deadDeclsElided: number } }}
 */
export function elideDeadStackSpills(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      lines: Array.isArray(lines) ? [] : [],
      stats: { deadSpillsElided: 0, deadDeclsElided: 0 },
    };
  }

  const declIndices = new Map();
  const assignEntries = new Map();
  const readOrAddrTaken = new Set();

  const markReads = (code) => {
    VAR_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = VAR_TOKEN_RE.exec(code)) !== null) {
      readOrAddrTaken.add(m[1]);
    }
    ADDR_OF_VAR_RE.lastIndex = 0;
    while ((m = ADDR_OF_VAR_RE.exec(code)) !== null) {
      readOrAddrTaken.add(m[1]);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = getLineText(lines[i]);
    const clean = stripCommentsPreservingStrings(raw);

    const declMatch = LOCAL_DECL_RE.exec(clean);
    if (declMatch) {
      const varName = declMatch[1];
      if (VAR_NAME_RE.test(varName)) {
        if (!declIndices.has(varName)) declIndices.set(varName, []);
        declIndices.get(varName).push(i);
        continue;
      }
    }

    const assignMatch = SPILL_ASSIGN_RE.exec(clean);
    if (assignMatch) {
      const varName = assignMatch[1];
      const rhs = assignMatch[2];
      if (VAR_NAME_RE.test(varName)) {
        if (!assignEntries.has(varName)) assignEntries.set(varName, []);
        assignEntries.get(varName).push({ index: i, rhs });
        markReads(rhs);
        continue;
      }
    }

    markReads(clean);
  }

  const candidates = new Set([...declIndices.keys(), ...assignEntries.keys()]);
  const elideIndices = new Set();
  let deadSpillsElided = 0;
  let deadDeclsElided = 0;

  for (const varName of candidates) {
    if (readOrAddrTaken.has(varName)) continue;

    const assigns = assignEntries.get(varName) || [];
    const decls = declIndices.get(varName) || [];

    const allAssignsPure = assigns.every((entry) => isPureSpillRhs(entry.rhs));
    if (!allAssignsPure) continue;

    for (const entry of assigns) {
      elideIndices.add(entry.index);
      deadSpillsElided++;
    }
    for (const idx of decls) {
      elideIndices.add(idx);
      deadDeclsElided++;
    }
  }

  const outLines = lines.filter((_, idx) => !elideIndices.has(idx));
  return {
    lines: outLines,
    stats: { deadSpillsElided, deadDeclsElided },
  };
}

/**
 * Conservatively folds ARM64 callee-saved register prologue/epilogue stack spill
 * save/restore operations (`*(uint64 *)((uintptr_t)(sp) + 0xHEX) = xN;` and matching restores).
 *
 * Safety invariant:
 * - Only folds `(reg, offset)` when `reg` is callee-saved (`x19..x30`, `fp`, `lr`, `d8..d15`),
 *   never for `a1..a8`, `x0..x18`, `sp`, or `result`.
 * - Bails out completely if `sp` escapes (any occurrence outside constant-offset dereferences
 *   or recognized `sp` self-adjustments/declarations).
 * - Rejects overlapping byte-range stack slots (`[off - 15, off + 7]` for external accesses,
 *   `[off - 7, off + 7]` for other 8-byte slots).
 * - Requires top-level single save (`braceDepth === 1`), no prior write to `reg` or its ARM64
 *   aliases, no intervening `sp` mutation, and sound restore scope with no read after restore.
 *
 * @param {Array<string|{ kind?: string, indent?: number, text: string }>} lines
 * @returns {{ lines: Array, stats: { calleeSavedSpillsFolded: number } }}
 */
export function foldCalleeSavedStackSpills(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      lines: Array.isArray(lines) ? [] : [],
      stats: { calleeSavedSpillsFolded: 0, deadDeclsElided: 0 },
    };
  }

  const usesLineObjects = lines.some((item) => item !== null && typeof item === 'object');
  const sanitizedLines = sanitizeLinesForAnalysis(lines);

  const lineDepth = new Array(sanitizedLines.length).fill(0);
  const lineFuncOpenBrace = new Array(sanitizedLines.length).fill(-1);
  const lineAfterBracelessCtrl = new Array(sanitizedLines.length).fill(false);

  let depth = 0;
  let inTypeBlock = false;
  let currentFuncOpenBraceIdx = -1;
  let prevNonEmptyBracelessCtrl = false;

  for (let i = 0; i < sanitizedLines.length; i++) {
    const s = sanitizedLines[i];
    lineDepth[i] = depth;
    lineFuncOpenBrace[i] = currentFuncOpenBraceIdx;
    lineAfterBracelessCtrl[i] = prevNonEmptyBracelessCtrl;

    if (depth === 0 && TYPE_BLOCK_HEAD_RE.test(s)) {
      inTypeBlock = true;
    }

    for (let c = 0; c < s.length; c++) {
      if (s[c] === '{') {
        if (depth === 0 && !inTypeBlock) {
          currentFuncOpenBraceIdx = i;
        }
        depth++;
      } else if (s[c] === '}') {
        if (depth > 0) depth--;
        if (depth === 0) {
          inTypeBlock = false;
        }
      }
    }

    if (depth === 0 && inTypeBlock && s.includes(';')) {
      inTypeBlock = false;
    }

    const trimmed = s.trim();
    if (trimmed) {
      prevNonEmptyBracelessCtrl = BRACELESS_CTRL_RE.test(trimmed);
    }
  }

  const slotOps = new Map(); // numeric byte offset -> Array<{ index, kind: 'save'|'restore', reg }>
  const externalAccessOffsets = new Set(); // numeric byte offsets
  const spWriteIndices = [];
  let spEscaped = false;

  const recordSlotOp = (offset, op) => {
    if (!slotOps.has(offset)) slotOps.set(offset, []);
    slotOps.get(offset).push(op);
  };

  for (let i = 0; i < sanitizedLines.length; i++) {
    const clean = sanitizedLines[i];
    if (!clean.trim()) continue;

    if (lineWritesReg(clean, 'sp')) {
      spWriteIndices.push(i);
    }

    const saveMatch = CALLEE_SAVE_RE.exec(clean);
    if (saveMatch) {
      const offset = parseStackOffset(saveMatch[1], saveMatch[2]);
      const reg = saveMatch[3];
      if (offset !== null) {
        if (reg === 'sp') {
          spEscaped = true;
        } else if (CALLEE_SAVED_REGS.has(reg)) {
          recordSlotOp(offset, { index: i, kind: 'save', reg });
        } else {
          externalAccessOffsets.add(offset);
        }
        continue;
      }
    }

    const restoreMatch = CALLEE_RESTORE_RE.exec(clean);
    if (restoreMatch) {
      const reg = restoreMatch[1];
      const offset = parseStackOffset(restoreMatch[2], restoreMatch[3]);
      if (offset !== null) {
        if (reg === 'sp') {
          spEscaped = true;
        } else if (CALLEE_SAVED_REGS.has(reg)) {
          recordSlotOp(offset, { index: i, kind: 'restore', reg });
        } else {
          externalAccessOffsets.add(offset);
        }
        continue;
      }
    }

    if (!SP_TOKEN_RE.test(clean)) {
      continue;
    }

    if (isRecognizedSpAdjustmentOrDecl(clean)) {
      continue;
    }

    STACK_SLOT_REF_RE.lastIndex = 0;
    let m;
    let stripped = '';
    let lastPos = 0;
    while ((m = STACK_SLOT_REF_RE.exec(clean)) !== null) {
      const prefix = clean.slice(0, m.index);
      if (/&\s*(?:\(\s*)*$/.test(prefix)) {
        spEscaped = true;
      }
      const offset = parseStackOffset(m[1], m[2]);
      if (offset !== null) {
        externalAccessOffsets.add(offset);
      } else {
        spEscaped = true;
      }
      stripped += clean.slice(lastPos, m.index) + ' ';
      lastPos = m.index + m[0].length;
    }
    stripped += clean.slice(lastPos);

    if (SP_TOKEN_RE.test(stripped)) {
      spEscaped = true;
    }
  }

  const foldIndices = new Set();
  const elideDeclIndices = new Set();

  if (!spEscaped && slotOps.size > 0) {
    const allSlotOffsets = Array.from(slotOps.keys());
    const allExternalOffsets = Array.from(externalAccessOffsets);

    const hasOverlappingAccess = (off) => {
      for (const extOff of allExternalOffsets) {
        if (extOff >= off - 15 && extOff <= off + 7) {
          return true;
        }
      }
      for (const otherOff of allSlotOffsets) {
        if (otherOff !== off && otherOff >= off - 7 && otherOff <= off + 7) {
          return true;
        }
      }
      return false;
    };

    for (const [offset, ops] of slotOps.entries()) {
    if (hasOverlappingAccess(offset)) continue;

    const regs = new Set(ops.map((op) => op.reg));
    if (regs.size !== 1) continue;
    const reg = ops[0].reg;
    if (!CALLEE_SAVED_REGS.has(reg)) continue;

    const saves = ops.filter((op) => op.kind === 'save');
    const restores = ops.filter((op) => op.kind === 'restore');
    if (saves.length !== 1) continue;

    const saveIdx = saves[0].index;
    if (
      lineDepth[saveIdx] !== 1 ||
      lineFuncOpenBrace[saveIdx] === -1 ||
      lineAfterBracelessCtrl[saveIdx]
    ) {
      continue;
    }

    let writtenBeforeSave = false;
    for (let j = 0; j < saveIdx; j++) {
      if (lineWritesReg(sanitizedLines[j], reg)) {
        writtenBeforeSave = true;
        break;
      }
    }
    if (writtenBeforeSave) continue;

    if (restores.length > 0) {
      const firstRestoreIdx = restores[0].index;
      const lastRestoreIdx = restores[restores.length - 1].index;
      if (saveIdx >= firstRestoreIdx) continue;
      if (spWriteIndices.some((spIdx) => spIdx > saveIdx && spIdx < lastRestoreIdx)) {
        continue;
      }

      let allRestoresSound = true;
      for (const r of restores) {
        const rIdx = r.index;
        const isTopLevel =
          lineDepth[rIdx] === 1 &&
          lineFuncOpenBrace[rIdx] === lineFuncOpenBrace[saveIdx] &&
          !lineAfterBracelessCtrl[rIdx];

        const isEarlyReturn =
          !isTopLevel &&
          lineDepth[rIdx] >= 2 &&
          lineFuncOpenBrace[rIdx] === lineFuncOpenBrace[saveIdx] &&
          !lineAfterBracelessCtrl[rIdx] &&
          isEarlyReturnRestore(sanitizedLines, rIdx);
        if (!isTopLevel && !isEarlyReturn) {
          allRestoresSound = false;
          break;
        }

        for (let k = rIdx + 1; k < sanitizedLines.length; k++) {
          if (lineReadsReg(sanitizedLines[k], reg)) {
            allRestoresSound = false;
            break;
          }
        }
        if (!allRestoresSound) break;
      }

      if (!allRestoresSound) continue;

      for (const op of ops) {
        foldIndices.add(op.index);
      }
    } else if (PROLOGUE_ONLY_CALLEE_SAVED_REGS.has(reg)) {
      if (spWriteIndices.some((spIdx) => spIdx > saveIdx)) {
        continue;
      }
      foldIndices.add(saveIdx);
    }
    }
  }

  // Independent SSA callee-saved spill folding (`local_[mp]<hex> = local_<reg>;`)
  const funcOpenBraces = [];
  const seenOpenBraces = new Set();
  for (let i = 0; i < lineFuncOpenBrace.length; i++) {
    const ob = lineFuncOpenBrace[i];
    if (ob !== -1 && !seenOpenBraces.has(ob)) {
      seenOpenBraces.add(ob);
      funcOpenBraces.push(ob);
    }
  }

  const ssaSaveCandidates = [];
  for (const funcOpenBrace of funcOpenBraces) {
    for (let i = funcOpenBrace + 1; i < sanitizedLines.length; i++) {
      if (lineFuncOpenBrace[i] !== funcOpenBrace || lineDepth[i] === 0) break;
      if (lineDepth[i] !== 1 || lineAfterBracelessCtrl[i]) break;
      const clean = sanitizedLines[i];
      const trimmed = clean.trim();
      if (!trimmed) continue;
      if (isRecognizedSpAdjustmentOrDecl(clean)) continue;
      if (CALLEE_SAVE_RE.test(clean)) continue;

      const ssaSaveMatch = SSA_CALLEE_SAVE_RE.exec(clean);
      if (ssaSaveMatch) {
        ssaSaveCandidates.push({
          saveIdx: i,
          slotVar: ssaSaveMatch[1],
          regVar: ssaSaveMatch[2],
          funcOpenBrace,
        });
        continue;
      }

      const item = lines[i];
      const isDeclObj = usesLineObjects && item !== null && typeof item === 'object' && item.kind === 'decl';
      if (isDeclObj || ANY_LOCAL_DECL_RE.test(clean)) continue;
      break;
    }
  }

  for (const { saveIdx, slotVar, regVar, funcOpenBrace } of ssaSaveCandidates) {
    const matchedRestores = new Set();
    for (let rIdx = saveIdx + 1; rIdx < sanitizedLines.length; rIdx++) {
      if (lineFuncOpenBrace[rIdx] !== funcOpenBrace) continue;
      if (lineAfterBracelessCtrl[rIdx]) continue;
      const rm = SSA_CALLEE_RESTORE_RE.exec(sanitizedLines[rIdx]);
      if (!rm || rm[1] !== regVar || rm[2] !== slotVar) continue;
      const isTopLevel = lineDepth[rIdx] === 1;
      const isEarlyReturn =
        !isTopLevel &&
        lineDepth[rIdx] >= 2 &&
        isEarlyReturnRestore(sanitizedLines, rIdx);
      if (isTopLevel || isEarlyReturn) {
        matchedRestores.add(rIdx);
      }
    }

    const verifySsaVarSound = (varName) => {
      const tokenRe = new RegExp(`\\b${varName}\\b`);
      const addrRe = new RegExp(`&\\s*${varName}\\b`);
      let declIdx = -1;
      let declCount = 0;

      for (let k = 0; k < sanitizedLines.length; k++) {
        const clean = sanitizedLines[k];
        if (!tokenRe.test(clean)) continue;
        if (addrRe.test(clean)) return { ok: false, declIdx: -1 };
        if (k === saveIdx || matchedRestores.has(k)) continue;

        const dm = SIMPLE_LOCAL_DECL_NAME_RE.exec(clean);
        if (
          dm &&
          dm[1] === varName &&
          lineDepth[k] === 1 &&
          lineFuncOpenBrace[k] === funcOpenBrace &&
          !lineAfterBracelessCtrl[k]
        ) {
          declCount++;
          declIdx = k;
          if (declCount > 1) return { ok: false, declIdx: -1 };
          continue;
        }
        return { ok: false, declIdx: -1 };
      }

      return { ok: true, declIdx };
    };

    const slotCheck = verifySsaVarSound(slotVar);
    if (!slotCheck.ok) continue;
    const regCheck = verifySsaVarSound(regVar);
    if (!regCheck.ok) continue;

    foldIndices.add(saveIdx);
    for (const rIdx of matchedRestores) {
      foldIndices.add(rIdx);
    }
    if (slotCheck.declIdx !== -1) {
      elideDeclIndices.add(slotCheck.declIdx);
    }
    if (regCheck.declIdx !== -1) {
      elideDeclIndices.add(regCheck.declIdx);
    }
  }

  const count = foldIndices.size;
  if (count === 0) {
    return {
      lines: lines.slice(),
      stats: { calleeSavedSpillsFolded: 0, deadDeclsElided: 0 },
    };
  }

  const firstFoldedIdx = Math.min(...foldIndices);
  const firstFoldedItem = lines[firstFoldedIdx];
  const origOpenBraceIdx = lineFuncOpenBrace[firstFoldedIdx];
  const outLines = [];
  let openBraceIdxInOut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (foldIndices.has(i) || elideDeclIndices.has(i)) continue;
    if (i === origOpenBraceIdx) {
      openBraceIdxInOut = outLines.length;
    }
    outLines.push(lines[i]);
  }

  const summaryText = `/* [Clean View: folded ${count} callee-saved prologue/epilogue spill ops] */`;
  let summaryLine;
  if (usesLineObjects) {
    const indent = typeof firstFoldedItem?.indent === 'number' ? firstFoldedItem.indent : 1;
    summaryLine = {
      kind: 'comment',
      indent,
      text: summaryText,
      row: null,
      addr: null,
      note: null,
      _origIdx: -1,
    };
  } else {
    const leadingWsMatch = /^(\s*)/.exec(getLineText(firstFoldedItem));
    const indentStr = leadingWsMatch && leadingWsMatch[1] ? leadingWsMatch[1] : '  ';
    summaryLine = `${indentStr}${summaryText}`;
  }

  // Insert right after the function's opening `{` (depth 0 -> 1) and any local declarations
  let insertIdx = 0;
  if (openBraceIdxInOut !== -1) {
    let idx = openBraceIdxInOut + 1;
    while (idx < outLines.length) {
      const item = outLines[idx];
      const text = getLineText(item);
      const trimmed = text.trim();
      const isDeclObj = usesLineObjects && item && typeof item === 'object' && item.kind === 'decl';
      if (trimmed === '' || isDeclObj || ANY_LOCAL_DECL_RE.test(stripCommentsPreservingStrings(text))) {
        idx++;
        continue;
      }
      break;
    }
    insertIdx = idx;
  }

  outLines.splice(insertIdx, 0, summaryLine);

  return {
    lines: outLines,
    stats: { calleeSavedSpillsFolded: count, deadDeclsElided: elideDeclIndices.size },
  };
}

function createEmptyStats() {
  return {
    typedefsHidden: 0,
    deadSpillsElided: 0,
    deadDeclsElided: 0,
    calleeSavedSpillsFolded: 0,
    objcStubsRewritten: 0,
    objcDirectRewritten: 0,
    arcOpsFolded: 0,
    arcLinesRemoved: 0,
    symbolsDemangled: 0,
    duplicateAsmCollapsed: 0,
  };
}

/**
 * Formats an array of decompiler line objects (or strings) using the Clean View pipeline.
 * Preserves line metadata (`indent`, `kind`, `row`, `addr`, `note`, `_origIdx`, etc.).
 */
const SEMANTIC_V2_ASM_RE = /^__asm\("semantic-v2[^"]*"\);$/;

export function formatCleanViewLines(lines, options = {}) {
  const {
    hideTypedefPrelude = true,
    elideDeadSpills = true,
    foldCalleeSavedSpills = true,
    refineAppleSwift = true,
    collapseDuplicateAsm = true,
  } = options;

  const stats = createEmptyStats();
  if (!Array.isArray(lines) || lines.length === 0) {
    return { lines: [], stats };
  }

  const usesLineObjects = lines.some((item) => item !== null && typeof item === 'object');
  let current = lines.slice();

  // 1. Hide fixed-width / id typedef prelude lines and collapse blank lines left at the top
  if (hideTypedefPrelude) {
    const filtered = [];
    for (const item of current) {
      if (isTypedefPreludeLine(getLineText(item))) {
        stats.typedefsHidden++;
        continue;
      }
      filtered.push(item);
    }

    if (stats.typedefsHidden > 0) {
      while (filtered.length > 0 && getLineText(filtered[0]).trim() === '') {
        filtered.shift();
      }
      // Collapse any consecutive blank lines remaining in the top prelude before the first block `{`
      const collapsed = [];
      let seenBodyBrace = false;
      for (const item of filtered) {
        const trimmed = getLineText(item).trim();
        if (trimmed.includes('{')) seenBodyBrace = true;
        if (!seenBodyBrace && trimmed === '' && collapsed.length > 0 && getLineText(collapsed[collapsed.length - 1]).trim() === '') {
          continue;
        }
        collapsed.push(item);
      }
      current = collapsed;
    } else {
      current = filtered;
    }
  }

  // 2. Conservative dead stack spill & unused local declaration elision
  if (elideDeadSpills) {
    const spillResult = elideDeadStackSpills(current);
    current = spillResult.lines;
    stats.deadSpillsElided = spillResult.stats.deadSpillsElided;
    stats.deadDeclsElided = spillResult.stats.deadDeclsElided;
  }

  // 3. Conservative ARM64 callee-saved prologue/epilogue stack spill folding
  if (foldCalleeSavedSpills) {
    const calleeResult = foldCalleeSavedStackSpills(current);
    current = calleeResult.lines;
    stats.calleeSavedSpillsFolded = calleeResult.stats.calleeSavedSpillsFolded;
    stats.deadDeclsElided += calleeResult.stats.deadDeclsElided ?? 0;
  }

  // 4. Apple ObjC / Swift / ARC / 4-ABI demangle pass (preserving line metadata)
  if (refineAppleSwift) {
    const refined = [];
    for (const item of current) {
      const text = getLineText(item);
      if (text.trim() === '') {
        refined.push(item);
        continue;
      }
      const res = refineAppleSwiftDecompile(text);
      stats.objcStubsRewritten += res.stats.objcStubsRewritten;
      stats.objcDirectRewritten += res.stats.objcDirectRewritten;
      stats.arcOpsFolded += res.stats.arcOpsFolded;
      stats.arcLinesRemoved += res.stats.arcLinesRemoved;
      stats.symbolsDemangled += res.stats.symbolsDemangled;

      if (res.stats.arcLinesRemoved > 0) {
        continue;
      }
      refined.push(setLineText(item, res.code));
    }

    if (stats.arcLinesRemoved > 0) {
      const summaryText = `/* [ARC/Swift: folded ${stats.arcOpsFolded} retain/release ops (${stats.arcLinesRemoved} lines elided)] */`;
      const summaryLine = usesLineObjects
        ? { kind: 'comment', indent: 1, text: summaryText, row: null, addr: null, note: null, _origIdx: -1 }
        : `  ${summaryText}`;
      const lastBrace = refined.findLastIndex((item) => getLineText(item).trim() === '}');
      if (lastBrace > 0) {
        refined.splice(lastBrace, 0, summaryLine);
      } else {
        refined.push(summaryLine);
      }
    }
    current = refined;
  }

  // 5. Collapse consecutive identical __asm("semantic-v2 ...") placeholder lines
  if (collapseDuplicateAsm && current.length > 1) {
    const deduped = [];
    let i = 0;
    while (i < current.length) {
      const item = current[i];
      const rawText = getLineText(item);
      const trimmed = rawText.trim();
      if (SEMANTIC_V2_ASM_RE.test(trimmed)) {
        let j = i + 1;
        while (j < current.length && getLineText(current[j]).trim() === trimmed) {
          j++;
        }
        const count = j - i;
        if (count > 1) {
          stats.duplicateAsmCollapsed += count - 1;
          deduped.push(setLineText(item, `${rawText} /* ×${count} */`));
          i = j;
          continue;
        }
      }
      deduped.push(item);
      i++;
    }
    current = deduped;
  }

  return { lines: current, stats };
}

/**
 * Formats a raw pseudo-C string using the Clean View pipeline.
 */
export function formatCleanViewText(pseudoC, options = {}) {
  const input = String(pseudoC ?? '');
  if (!input) {
    return { code: '', stats: createEmptyStats() };
  }
  const { lines, stats } = formatCleanViewLines(input.split('\n'), options);
  return {
    code: lines.join('\n'),
    stats,
  };
}
