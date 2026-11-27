/**
 * Post-Decompile Apple ObjC / Swift / ARC / 4-ABI Demangle Presentation Pass.
 * Cleans up modern iOS/macOS pseudo-C beyond stock Hex-Rays output:
 *  1. Rewrites Xcode 14+ `_objc_msgSend$<sel>(recv, args...)` stubs into `[recv sel:args...]`.
 *  2. Rewrites direct `objc_msgSend(recv, "sel", args...)` calls into `[recv sel:args...]`.
 *  3. Folds Objective-C & Swift ARC retain/release/autorelease/bridgeObject boilerplate.
 *  4. Demangles inline Swift ($s/_$s), Itanium C++ (_Z), Rust (_R), and MSVC C++ (?...) symbols
 *     via the unified 4-ABI WASM demangler (with JS fallback).
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

const ARC_DROP_STMT_RE = /^\s*(?:_?objc_release|_?objc_destroyWeak|_?swift_release|_?swift_bridgeObjectRelease|_?swift_unknownObjectRelease|_?swift_errorRelease)\s*\([^;]*\)\s*;\s*$/;
const ARC_STORE_NULL_RE = /^\s*_?objc_storeStrong\s*\(\s*&[^,]+,\s*(?:0|0LL|0ULL|NULL|nil)\s*\)\s*;\s*$/;

function splitTopLevelArgs(argStr) {
  const args = [];
  let cur = '';
  let depthParen = 0;
  let depthBracket = 0;
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
    else if (ch === ',' && depthParen === 0 && depthBracket === 0) {
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
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function rewriteObjcMsgSendStubsInLine(line, stats) {
  // Match _objc_msgSend$selectorName:(...) or objc_msgSend$selectorName(...)
  const re = /\b_?objc_msgSend\$([A-Za-z0-9_:]+)\s*\(/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(line, openIdx);
    if (closeIdx === -1) break;
    const sel = m[1];
    const inner = line.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length >= 1) {
      out += line.slice(last, m.index);
      out += formatObjcBracketCall(args[0], sel, args.slice(1));
      stats.objcStubsRewritten++;
      last = closeIdx + 1;
      re.lastIndex = last;
    }
  }
  return out + line.slice(last);
}

function rewriteDirectObjcMsgSendInLine(line, stats) {
  const re = /\b_?objc_msgSend(?:Super2)?\s*\(/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(line, openIdx);
    if (closeIdx === -1) break;
    const inner = line.slice(openIdx + 1, closeIdx);
    const args = splitTopLevelArgs(inner);
    if (args.length >= 2) {
      const selMatch = /^"(?:@)?([A-Za-z0-9_:]+)"$/.exec(args[1]);
      if (selMatch) {
        out += line.slice(last, m.index);
        out += formatObjcBracketCall(args[0], selMatch[1], args.slice(2));
        stats.objcDirectRewritten++;
        last = closeIdx + 1;
        re.lastIndex = last;
      }
    }
  }
  return out + line.slice(last);
}

function foldArcPassthroughInLine(line, stats) {
  let cur = line;
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard++;
    const re = /\b(_?(?:objc|swift)_[A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(cur)) !== null) {
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

function demangleSymbolsInLine(line, stats) {
  // Match Swift ($s/_$s/$S/_$S/_T0), Itanium C++ (_Z/__Z), Rust (_R/__R), or MSVC (?...) tokens
  const tokenRe = /(?:_?\$[sSe][A-Za-z0-9_]+|__?T0[A-Za-z0-9_]+|__?[ZR][A-Za-z0-9_$]+|\?[A-Za-z0-9_@$?]+)/g;
  return line.replace(tokenRe, (tok) => {
    const kind = detectMangleKind(tok);
    if (kind === DEMANGLE_KIND.NONE) return tok;
    const dem = demangleSymbol(tok);
    if (!dem || dem === tok) return tok;
    stats.symbolsDemangled++;
    return dem;
  });
}

/**
 * Runs the Apple ObjC / Swift / ARC / 4-ABI Demangle post-decompile pass on pseudo-C text.
 * Deterministic, pure, INV-005 compliant.
 */
export function refineAppleSwiftDecompile(pseudoC, {
  foldArcNoise = true,
  rewriteObjcStubs = true,
  demangleCalls = true,
} = {}) {
  const input = String(pseudoC ?? '');
  const stats = {
    objcStubsRewritten: 0,
    objcDirectRewritten: 0,
    arcOpsFolded: 0,
    arcLinesRemoved: 0,
    symbolsDemangled: 0,
  };
  if (!input) return { code: '', stats };

  const lines = input.split('\n');
  const outLines = [];

  for (let line of lines) {
    if (foldArcNoise && (ARC_DROP_STMT_RE.test(line) || ARC_STORE_NULL_RE.test(line))) {
      stats.arcLinesRemoved++;
      stats.arcOpsFolded++;
      continue;
    }
    if (foldArcNoise) {
      line = foldArcPassthroughInLine(line, stats);
    }
    if (rewriteObjcStubs) {
      line = rewriteObjcMsgSendStubsInLine(line, stats);
      line = rewriteDirectObjcMsgSendInLine(line, stats);
    }
    if (demangleCalls) {
      line = demangleSymbolsInLine(line, stats);
    }
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
  };
}
