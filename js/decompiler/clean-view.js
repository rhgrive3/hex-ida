/**
 * Clean View Decompiler Presentation Module.
 *
 * Pure, deterministic post-decompile presentation pass that:
 *  1. Hides fixed-width primitive / `id` typedef preludes while keeping recovered `typedef struct ...` definitions.
 *  2. Conservatively and soundly elides dead stack spill assignments (`var_XX = <pure>;`) and unused local declarations.
 *  3. Delegates ObjC / Swift / ARC / 4-ABI symbol demangling to `refineAppleSwiftDecompile`.
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

const LOCAL_DECL_RE = /^\s*(?!return\b|goto\b|break\b|continue\b|case\b|else\b|typedef\b|delete\b|struct\b|union\b|enum\b)(?:(?:const|register|static|unsigned|signed|long|short)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+\*?\s*)(var_[0-9A-Za-z_]+)\s*;\s*$/;
const SPILL_ASSIGN_RE = /^\s*(var_[0-9A-Za-z_]+)\s*=(?!=)\s*([^;]+);\s*$/;

const CALL_IN_RHS_RE = /[A-Za-z_][\w:.$]*\s*\(/;
const INC_DEC_RE = /(\+\+|--)/;
const VOLATILE_RE = /\bvolatile\b/;

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

function isPureSpillRhs(rhs) {
  if (!rhs || !rhs.trim()) return false;
  if (CALL_IN_RHS_RE.test(rhs)) return false;
  if (INC_DEC_RE.test(rhs)) return false;
  if (VOLATILE_RE.test(rhs)) return false;
  if (rhs.includes('=')) return false;
  return true;
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

function createEmptyStats() {
  return {
    typedefsHidden: 0,
    deadSpillsElided: 0,
    deadDeclsElided: 0,
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
 * Preserves line metadata (`indent`, `kind`, `row`, `addr`, `note`, etc.).
 */
const SEMANTIC_V2_ASM_RE = /^__asm\("semantic-v2[^"]*"\);$/;

export function formatCleanViewLines(lines, options = {}) {
  const {
    hideTypedefPrelude = true,
    elideDeadSpills = true,
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

  // 3. Apple ObjC / Swift / ARC / 4-ABI demangle pass (preserving line metadata)
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
        ? { kind: 'comment', indent: 1, text: summaryText, row: null, addr: null, note: null }
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

  // 4. Collapse consecutive identical __asm("semantic-v2 ...") placeholder lines
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
