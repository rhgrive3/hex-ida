/**
 * Post-Decompile Apple ObjC / Swift / ARC / 4-ABI Demangle Presentation Pass.
 * Cleans up modern iOS/macOS pseudo-C beyond stock Hex-Rays output:
 *  1. Rewrites Xcode 14+ `_objc_msgSend$<sel>(recv, args...)` stubs into `[recv sel:args...]`.
 *  2. Rewrites direct `objc_msgSend(recv, "sel", args...)` calls into `[recv sel:args...]`.
 *  3. Folds Objective-C & Swift ARC retain/release/autorelease/bridgeObject boilerplate.
 *  4. Demangles inline Swift ($s/_$s), Itanium C++ (_Z/__Z and `_`-stripped Z...), Rust (_R),
 *     and MSVC C++ (?...) symbols via the unified 4-ABI WASM demangler (with JS fallback).
 *
 * INV-005 compliant: ZERO imports from js/targets/architecture/.
 */

import { demangleSymbol, detectMangleKind, DEMANGLE_KIND } from '../analysis/types/core/symbol-demangler.js';

const ARC_PASSTHROUGH_FNS = new Set([
  'objc_retain',
  '_objc_retain',
  'objc_retainAutoreleasedReturnValue',
  '_objc_retainAutoreleasedReturnValue',
  'objc_claimAutoreleasedReturnValue',
  '_objc_claimAutoreleasedReturnValue',
  'objc_autoreleaseReturnValue',
  '_objc_autoreleaseReturnValue',
  'objc_retainAutoreleaseReturnValue',
  '_objc_retainAutoreleaseReturnValue',
  'objc_retainAutorelease',
  '_objc_retainAutorelease',
  'objc_unsafeClaimAutoreleasedReturnValue',
  '_objc_unsafeClaimAutoreleasedReturnValue',
  'swift_retain',
  '_swift_retain',
  'swift_bridgeObjectRetain',
  '_swift_bridgeObjectRetain',
  'swift_unknownObjectRetain',
  '_swift_unknownObjectRetain',
]);

const ARC_DROP_STMT_RE = /^\s*(?:_?objc_release|_?objc_destroyWeak|_?swift_release|_?swift_bridgeObjectRelease|_?swift_unknownObjectRelease|_?swift_errorRelease)\s*\(([^;]*)\)\s*;\s*$/;
const ARC_STORE_NULL_RE = /^\s*_?objc_storeStrong\s*\(\s*&([^,]+),\s*(?:0|0LL|0ULL|NULL|nil)\s*\)\s*;\s*$/;
const ARC_SIDE_EFFECT_CALL_RE = /[A-Za-z_][\w:.$]*\s*\(/;
const ARC_SIDE_EFFECT_INCDEC_RE = /(\+\+|--)/;
const ARC_SIDE_EFFECT_ASSIGN_RE = /(?:(?<![=!<>])=(?!=)|(?:[+\-*/%&|^]|<<|>>)=)/;
const BRACELESS_CTRL_RE = /^\s*(?:(?:\}\s*)?else(?:\s+if\s*\(.+\))?|(?:if|while|for|switch)\s*\(.+\)|do)\s*$/;

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

// Sticky token matcher for Swift, Itanium C++ (_Z/__Z and `_`-stripped Z...), Rust, and MSVC symbols
const DEMANGLE_TOKEN_STICKY_RE = new RegExp(
  '(?:' +
    '_?\\$[sSe][A-Za-z0-9_]+' +
    '|__?T0[A-Za-z0-9_]+' +
    '|__?[ZR][A-Za-z0-9_$]+' +
    '|\\?[A-Za-z0-9_@$?]+' +
    '|ZN[rVKRO]*(?:[0-9]+|S[tabisod])[A-Za-z0-9_$]*E[A-Za-z0-9_$]*' +
    '|ZL[1-9][0-9]*[A-Za-z_][A-Za-z0-9_$]*' +
    '|ZT[VISTThv][A-Za-z0-9_$]+' +
    '|ZGV[A-Za-z0-9_$]+' +
    '|Z(?:nw|na|dl|da)[A-Za-z0-9_$]+' +
    '|Z[1-9][0-9]*[A-Za-z_][A-Za-z0-9_$]{2,}' +
  ')(?![A-Za-z0-9_$])',
  'y'
);

const STRIPPED_ITANIUM_SPECIFIC_RE = /^Z(?:N[rVKRO]*(?:[0-9]+|S[tabisod])[A-Za-z0-9_$]*E[A-Za-z0-9_$]*|L[1-9][0-9]*[A-Za-z_][A-Za-z0-9_$]*|T[VISTThv][A-Za-z0-9_$]+|GV[A-Za-z0-9_$]+|(?:nw|na|dl|da)[A-Za-z0-9_$]+)$/;
const STRIPPED_ITANIUM_GENERIC_RE = /^Z[1-9][0-9]*[A-Za-z_][A-Za-z0-9_$]{2,}$/;
const TRAILING_ITANIUM_QUAL_RE = /(?:\s+(?:const|volatile|restrict|noexcept(?:\([^)]*\))?)|\s*&&?)$/;
const SPECIAL_ITANIUM_PREFIX_RE = /^(?:vtable|typeinfo|guard variable|construction vtable|virtual thunk|non-virtual thunk)\b/;

function scanLineCodeState(str, initialInBlockComment = false) {
  const mask = new Uint8Array(str.length);
  let codeOnly = '';
  let inBlockComment = initialInBlockComment;
  let inQuote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inBlockComment) {
      if (ch === '*' && str[i + 1] === '/') {
        inBlockComment = false;
        codeOnly += ' ';
        i++;
      }
      continue;
    }
    if (inQuote) {
      codeOnly += ch;
      if (ch === '\\' && i + 1 < str.length) {
        codeOnly += str[++i];
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      codeOnly += ch;
      continue;
    }
    if (ch === '/' && str[i + 1] === '/') {
      break;
    }
    if (ch === '/' && str[i + 1] === '*') {
      inBlockComment = true;
      codeOnly += ' ';
      i++;
      continue;
    }
    mask[i] = 1;
    codeOnly += ch;
  }
  return { mask, codeOnly, nextInBlockComment: inBlockComment };
}

function hasArcArgSideEffects(argExpr) {
  const s = String(argExpr ?? '').trim();
  if (!s) return false;
  if (ARC_SIDE_EFFECT_CALL_RE.test(s)) return true;
  if (ARC_SIDE_EFFECT_INCDEC_RE.test(s)) return true;
  if (ARC_SIDE_EFFECT_ASSIGN_RE.test(s)) return true;
  return false;
}

function splitTopLevelArgs(argStr) {
  const args = [];
  let cur = '';
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inQuote = null;
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < argStr.length) {
        cur += argStr[++i];
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) args.push(cur.trim());
  return args;
}

function formatObjcBracketCall(receiver, selector, callArgs) {
  const parts = selector.split(':');
  if (!selector.includes(':') || parts.length <= 1) {
    if (callArgs.length === 0) return `[${receiver} ${selector}]`;
    return `[${receiver} ${selector} /* args: ${callArgs.join(', ')} */]`;
  }
  const segs = [];
  const namedCount = parts.length - 1;
  for (let i = 0; i < namedCount; i++) {
    const val = i < callArgs.length ? callArgs[i] : 'nil';
    segs.push(`${parts[i]}:${val}`);
  }
  if (callArgs.length > namedCount) {
    segs.push(`, ${callArgs.slice(namedCount).join(', ')}`);
  }
  return `[${receiver} ${segs.join(' ')}]`;
}

function findMatchingParen(str, openIdx) {
  let depth = 0;
  let inQuote = null;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < str.length) i++;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '/' && str[i + 1] === '/') {
      break;
    }
    if (ch === '/' && str[i + 1] === '*') {
      const end = str.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const MAX_OBJC_REWRITE_DEPTH = 8;

function rewriteNestedObjcArg(arg, stats, depth) {
  if (depth >= MAX_OBJC_REWRITE_DEPTH) return arg;
  let cur = rewriteObjcMsgSendStubsInLine(arg, stats, depth, false);
  cur = rewriteDirectObjcMsgSendInLine(cur, stats, depth, false);
  return cur;
}

function rewriteObjcMsgSendStubsInLine(line, stats, depth = 0, initialInBlockComment = false) {
  // Match _objc_msgSend$selectorName:(...) or objc_msgSend$selectorName(...)
  const { mask } = scanLineCodeState(line, initialInBlockComment);
  const re = /\b_?objc_msgSend\$([A-Za-z0-9_:]+)\s*\(/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (mask[m.index] !== 1) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(line, openIdx);
    if (closeIdx === -1) break;
    const sel = m[1];
    const inner = line.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length >= 1) {
      const rewrittenArgs = args.map((a) => rewriteNestedObjcArg(a, stats, depth + 1));
      out += line.slice(last, m.index);
      out += formatObjcBracketCall(rewrittenArgs[0], sel, rewrittenArgs.slice(1));
      stats.objcStubsRewritten++;
      last = closeIdx + 1;
      re.lastIndex = last;
    }
  }
  return out + line.slice(last);
}

function rewriteDirectObjcMsgSendInLine(line, stats, depth = 0, initialInBlockComment = false) {
  const { mask } = scanLineCodeState(line, initialInBlockComment);
  const re = /\b_?objc_msgSend(?:Super2)?\s*\(/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (mask[m.index] !== 1) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(line, openIdx);
    if (closeIdx === -1) break;
    const inner = line.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length >= 2) {
      const selMatch = /^"(?:@)?([A-Za-z0-9_:]+)"$/.exec(args[1]);
      if (selMatch) {
        const receiver = rewriteNestedObjcArg(args[0], stats, depth + 1);
        const callArgs = args.slice(2).map((a) => rewriteNestedObjcArg(a, stats, depth + 1));
        out += line.slice(last, m.index);
        out += formatObjcBracketCall(receiver, selMatch[1], callArgs);
        stats.objcDirectRewritten++;
        last = closeIdx + 1;
        re.lastIndex = last;
      }
    }
  }
  return out + line.slice(last);
}

function foldArcPassthroughInLine(line, stats, initialInBlockComment = false) {
  let cur = line;
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard++;
    const { mask } = scanLineCodeState(cur, initialInBlockComment);
    const re = /\b(_?(?:objc|swift)_[A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(cur)) !== null) {
      if (mask[m.index] !== 1) continue;
      const fnName = m[1];
      if (!ARC_PASSTHROUGH_FNS.has(fnName)) continue;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingParen(cur, openIdx);
      if (closeIdx === -1) continue;
      const inner = cur.slice(openIdx + 1, closeIdx).trim();
      const args = splitTopLevelArgs(inner);
      if (args.length === 1) {
        cur = cur.slice(0, m.index) + args[0] + cur.slice(closeIdx + 1);
        stats.arcOpsFolded++;
        changed = true;
        break;
      }
    }
  }
  return cur;
}

/**
 * Strips leading return-type prefix from a demangled Itanium C++ function-template name
 * (e.g. `void Foo::bar<int>` -> `Foo::bar<int>`) while preserving `operator ...` names.
 */
function stripItaniumReturnTypePrefix(name) {
  if (!name || SPECIAL_ITANIUM_PREFIX_RE.test(name)) return name;
  let angleDepth = 0;
  let parenDepth = 0;
  let lastSplit = -1;

  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
    } else if (ch === '<') {
      const before = name.slice(0, i);
      if (!/(?:^|::|\s)operator\s*<?$/.test(before)) {
        angleDepth++;
      }
    } else if (ch === '>') {
      const before = name.slice(0, i);
      if (!/(?:^|::|\s)operator\s*(?:-|>)?$/.test(before) && angleDepth > 0) {
        angleDepth--;
      }
    } else if (ch === ' ' && angleDepth === 0 && parenDepth === 0) {
      const before = name.slice(0, i).trimEnd();
      if (/(?:^|::|\s)operator$/.test(before)) {
        break;
      }
      lastSplit = i;
    }
  }

  if (lastSplit !== -1) {
    const candidate = name.slice(lastSplit + 1).trimStart();
    if (/^~?[A-Za-z_]/.test(candidate)) {
      return candidate;
    }
  }
  return name;
}

/**
 * Strips trailing cv/ref/noexcept qualifiers and balanced `(...)` parameter list from an
 * Itanium C++ demangled name when used at a call site or signature (followed by `(` in source),
 * preserving `operator()` and stripping leading function-template return types.
 */
function formatItaniumCallableName(demangled) {
  let s = demangled.trim();
  let strippedQual = s;
  while (TRAILING_ITANIUM_QUAL_RE.test(strippedQual)) {
    const next = strippedQual.replace(TRAILING_ITANIUM_QUAL_RE, '').trimEnd();
    if (next === strippedQual) break;
    strippedQual = next;
  }

  if (strippedQual.endsWith(')')) {
    let depth = 0;
    let openIdx = -1;
    for (let k = strippedQual.length - 1; k >= 0; k--) {
      const ch = strippedQual[k];
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) {
          openIdx = k;
          break;
        }
      }
    }
    if (openIdx > 0) {
      const before = strippedQual.slice(0, openIdx).trimEnd();
      if (!/(?:^|::|\s)operator$/.test(before)) {
        s = before;
      } else {
        s = strippedQual;
      }
    }
  }

  return stripItaniumReturnTypePrefix(s);
}

function nextNonWhitespaceChar(str, startIdx) {
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return ch;
  }
  return '';
}

function demangleSymbolsInLine(line, stats, initialInBlockComment = false) {
  let out = '';
  let i = 0;
  const len = line.length;
  if (initialInBlockComment) {
    const end = line.indexOf('*/');
    if (end === -1) return line;
    out += line.slice(0, end + 2);
    i = end + 2;
  }

  while (i < len) {
    const ch = line[i];

    // Skip string and char literals verbatim
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (line[j] === '\\' && j + 1 < len) {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += line.slice(i, j);
      i = j;
      continue;
    }

    // Skip line comments verbatim
    if (ch === '/' && line[i + 1] === '/') {
      out += line.slice(i);
      break;
    }

    // Skip block comments verbatim
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Enforce identifier boundary before any matched token
    if (i === 0 || !IDENT_CHAR_RE.test(line[i - 1])) {
      DEMANGLE_TOKEN_STICKY_RE.lastIndex = i;
      const m = DEMANGLE_TOKEN_STICKY_RE.exec(line);
      if (m) {
        const tok = m[0];
        const endIdx = i + tok.length;
        const isStrippedItanium =
          tok[0] === 'Z' &&
          (STRIPPED_ITANIUM_SPECIFIC_RE.test(tok) || STRIPPED_ITANIUM_GENERIC_RE.test(tok));
        const probe = isStrippedItanium ? `_${tok}` : tok;
        const kind = detectMangleKind(probe);

        if (kind !== DEMANGLE_KIND.NONE) {
          const dem = demangleSymbol(probe);
          const isValidDemangle = Boolean(dem && dem !== tok && dem !== probe);
          const passesGenericGuard =
            !isStrippedItanium ||
            STRIPPED_ITANIUM_SPECIFIC_RE.test(tok) ||
            (isValidDemangle && (dem.includes('(') || dem.includes('::')));

          if (isValidDemangle && passesGenericGuard) {
            let replacement = dem;
            if (
              kind === DEMANGLE_KIND.ITANIUM_CPP &&
              nextNonWhitespaceChar(line, endIdx) === '('
            ) {
              replacement = formatItaniumCallableName(dem);
            }
            out += replacement;
            stats.symbolsDemangled++;
            i = endIdx;
            continue;
          }
        }

        out += tok;
        i = endIdx;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Runs the Apple ObjC / Swift / ARC / 4-ABI Demangle post-decompile pass on pseudo-C text.
 * Deterministic, pure, INV-005 compliant.
 */
export function refineAppleSwiftDecompile(pseudoC, {
  foldArcNoise = true,
  rewriteObjcStubs = true,
  demangleCalls = true,
  state = null,
} = {}) {
  const input = String(pseudoC ?? '');
  let inBlockComment = Boolean(state?.inBlockComment);
  let prevLineBracelessCtrl = Boolean(state?.prevLineBracelessCtrl);
  const stats = {
    objcStubsRewritten: 0,
    objcDirectRewritten: 0,
    arcOpsFolded: 0,
    arcLinesRemoved: 0,
    symbolsDemangled: 0,
  };
  if (!input) {
    return {
      code: '',
      stats,
      state: { inBlockComment, prevLineBracelessCtrl },
    };
  }

  const lines = input.split('\n');
  const outLines = [];

  for (let line of lines) {
    const startInBlockComment = inBlockComment;
    const { codeOnly, nextInBlockComment } = scanLineCodeState(line, startInBlockComment);
    const trimmedCode = codeOnly.trim();

    if (trimmedCode === '') {
      inBlockComment = nextInBlockComment;
      outLines.push(line);
      continue;
    }

    if (foldArcNoise && !startInBlockComment && !nextInBlockComment && !prevLineBracelessCtrl) {
      const dropMatch = ARC_DROP_STMT_RE.exec(codeOnly);
      const storeNullMatch = dropMatch ? null : ARC_STORE_NULL_RE.exec(codeOnly);
      const argExpr = dropMatch ? dropMatch[1] : (storeNullMatch ? storeNullMatch[1] : null);
      if ((dropMatch || storeNullMatch) && !hasArcArgSideEffects(argExpr)) {
        stats.arcLinesRemoved++;
        stats.arcOpsFolded++;
        inBlockComment = nextInBlockComment;
        prevLineBracelessCtrl = false;
        continue;
      }
    }

    if (foldArcNoise) {
      line = foldArcPassthroughInLine(line, stats, startInBlockComment);
    }
    if (rewriteObjcStubs) {
      line = rewriteObjcMsgSendStubsInLine(line, stats, 0, startInBlockComment);
      line = rewriteDirectObjcMsgSendInLine(line, stats, 0, startInBlockComment);
    }
    if (demangleCalls) {
      line = demangleSymbolsInLine(line, stats, startInBlockComment);
    }
    inBlockComment = nextInBlockComment;
    prevLineBracelessCtrl = BRACELESS_CTRL_RE.test(trimmedCode);
    outLines.push(line);
  }

  if (foldArcNoise && stats.arcLinesRemoved > 0) {
    // Append a concise non-intrusive summary comment inside the function body (before final '}')
    const lastBrace = outLines.findLastIndex((l) => l.trim() === '}');
    const summary = `  /* [ARC/Swift: folded ${stats.arcOpsFolded} retain/release ops (${stats.arcLinesRemoved} lines elided)] */`;
    if (lastBrace > 0) {
      outLines.splice(lastBrace, 0, summary);
    } else {
      outLines.push(summary);
    }
  }

  return {
    code: outLines.join('\n'),
    stats,
    state: { inBlockComment, prevLineBracelessCtrl },
  };
}
