// Hex decompiler output extraction for the CodeFuse lane.
//
// The read-only product artifact stores functions discovered by the product
// analyzer, each with its own function-scoped `pseudocode` string. Two variants
// are produced and MUST stay distinct:
//
//   raw-function-text        concatenated function-scoped text, byte-exact,
//                            no declarations added. This is the raw Hex lane.
//   product-translation-unit output of the product's own compile-oriented
//                            packager (`buildCTranslationUnit`), when that
//                            merged product layer is present.
//
// The packager is imported dynamically so this investigation lane never depends
// on an unmerged branch; if it is absent the variant is reported as unavailable
// rather than substituted with raw text.

import crypto from 'node:crypto';

import { SOURCE_VARIANTS } from './constants.mjs';

let buildCTranslationUnit = null;
let translationUnitImportError = null;
try {
  // Repo root is four levels up from this harness directory.
  ({ buildCTranslationUnit } = await import('../../../../js/analysis/query/translation-unit.js'));
} catch (error) {
  translationUnitImportError = String(error?.message || error);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function addressKey(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

// Split the artifact's functions into pseudocode-bearing sources and explicit
// non-sources. Functions without pseudocode are returned as `excluded` with the
// product's own state/reason, so a CRASH or UNSUPPORTED function is never
// silently dropped from the case accounting.
export function extractFunctionSources(artifact) {
  const functions = Array.isArray(artifact?.functions) ? artifact.functions : [];
  const sources = [];
  const excluded = [];
  for (const fn of functions) {
    const pseudocode = typeof fn?.pseudocode === 'string' ? fn.pseudocode : '';
    if (!pseudocode.trim()) {
      excluded.push({
        address: fn?.address == null ? null : String(fn.address),
        name: fn?.name ?? null,
        state: fn?.state ?? 'UNKNOWN',
        reason: fn?.reason ?? 'no-pseudocode',
      });
      continue;
    }
    sources.push({
      address: fn?.address == null ? null : String(fn.address),
      name: fn?.name ?? null,
      state: fn?.state ?? 'UNKNOWN',
      completeness: fn?.completeness ?? 'unknown',
      pseudocode,
    });
  }
  sources.sort((left, right) => {
    const a = addressKey(left.address);
    const b = addressKey(right.address);
    if (a != null && b != null && a !== b) return a < b ? -1 : 1;
    if (a != null && b == null) return -1;
    if (a == null && b != null) return 1;
    return String(left.address).localeCompare(String(right.address));
  });
  return { sources, excluded };
}

// Raw, function-scoped text. The header comment is metadata only; it declares
// nothing and is not a prototype.
export function assembleRawFunctionText(sources) {
  const parts = [];
  for (const fn of sources) {
    parts.push(
      `/* ${SOURCE_VARIANTS.rawFunctionText}: address=${fn.address ?? 'unknown'} `
      + `name=${fn.name ?? 'unknown'} state=${fn.state} completeness=${fn.completeness} */`,
    );
    parts.push(fn.pseudocode.replace(/\s*$/, ''));
    parts.push('');
  }
  return parts.join('\n');
}

export function buildTranslationUnitVariant(sources) {
  if (typeof buildCTranslationUnit !== 'function') {
    return {
      available: false,
      reason: translationUnitImportError ? `translation-unit-unavailable:${translationUnitImportError}` : 'translation-unit-unavailable',
      text: null,
      sha256: null,
    };
  }
  try {
    const result = buildCTranslationUnit(sources.map((fn) => ({
      address: fn.address,
      name: fn.name,
      pseudocode: fn.pseudocode,
    })));
    const text = typeof result === 'string' ? result : String(result?.source ?? result?.text ?? '');
    if (!text.trim()) return { available: false, reason: 'translation-unit-empty', text: null, sha256: null };
    return { available: true, reason: null, text, sha256: sha256(text) };
  } catch (error) {
    return { available: false, reason: `translation-unit-error:${String(error?.message || error)}`, text: null, sha256: null };
  }
}

export function extractHexVariants(artifact) {
  const { sources, excluded } = extractFunctionSources(artifact);
  const rawText = assembleRawFunctionText(sources);
  const tu = buildTranslationUnitVariant(sources);
  return {
    sources,
    excluded,
    functionCount: sources.length,
    excludedCount: excluded.length,
    raw: { variant: SOURCE_VARIANTS.rawFunctionText, text: rawText, sha256: sha256(rawText) },
    translationUnit: { variant: SOURCE_VARIANTS.translationUnit, ...tu },
  };
}
