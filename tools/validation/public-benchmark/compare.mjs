import fs from 'node:fs';
import path from 'node:path';
import { parseIdaFunctions } from './ida-parser.mjs';
import { structuralReadabilityMetrics } from './metrics.mjs';

const key = value => '0x' + BigInt(value).toString(16);
function safeRef(root, rel) {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, rel);
  const base = rootPath + path.sep;
  if (!resolved.startsWith(base)) throw new Error('reference-path-escapes-root');
  const realBase = fs.realpathSync(rootPath);
  const realPath = fs.realpathSync(resolved);
  if (!realPath.startsWith(realBase + path.sep)) throw new Error('reference-path-escapes-root');
  return realPath;
}

function isPartialOrFallbackRow(row) {
  if (!row.hexMetrics) return false;
  if (row.hexState && row.hexState !== 'PASS') return true;
  if (row.hexCompleteness === 'partial' || row.hexCompleteness === 'fallback' || row.hexCompleteness === 'incomplete') return true;
  if (row.hexMetrics.hasStateMachine || row.hexMetrics.hasPseudoStack) return true;
  return false;
}

export function compareCase({ caseEntry, hexResult, suiteRoot }) {
  const referencePath = safeRef(suiteRoot, caseEntry.reference.path);
  const ida = parseIdaFunctions(fs.readFileSync(referencePath, 'utf8'));
  const idaByAddress = new Map(ida.map(f => [key(f.address), f]));
  const hexFunctions = Array.isArray(hexResult?.functions) ? hexResult.functions : [];
  const hexByAddress = new Map(hexFunctions.map(f => [key(f.address), f]));
  const denominator = [...new Set([...idaByAddress.keys(), ...hexByAddress.keys()])].sort();
  const rows = denominator.map(address => {
    const i = idaByAddress.get(address) ?? null;
    const h = hexByAddress.get(address) ?? null;
    return {
      address,
      idaName: i?.name ?? null,
      hexName: h?.name ?? null,
      idaPresent: !!i,
      hexPresent: !!h,
      hexState: h?.state ?? null,
      hexCompleteness: h?.completeness ?? null,
      idaMetrics: i ? structuralReadabilityMetrics(i.pseudocode) : null,
      hexMetrics: h?.pseudocode ? structuralReadabilityMetrics(h.pseudocode) : null,
    };
  });
  const matched = rows.filter(r => r.idaPresent && r.hexPresent).length;
  const hexRows = rows.filter(r => r.hexMetrics != null);
  const hexPseudocode = hexRows.length;

  let completeStructuredCount = 0;
  let partialOrFallbackCount = 0;
  let pseudoStackCount = 0;
  let stateMachineCount = 0;
  let bodyLines = 0;
  let registerLeakLines = 0;
  let castCount = 0;

  for (const r of hexRows) {
    const m = r.hexMetrics;
    if (m.hasPseudoStack) pseudoStackCount++;
    if (m.hasStateMachine) stateMachineCount++;
    if (isPartialOrFallbackRow(r)) partialOrFallbackCount++;
    else completeStructuredCount++;
    bodyLines += m.bodyLines ?? m.nonEmptyLines ?? 0;
    registerLeakLines += m.registerLeakLines ?? 0;
    castCount += m.castCount ?? 0;
  }

  return {
    caseId: caseEntry.id,
    denominator: rows.length,
    idaFunctions: ida.length,
    hexFunctions: hexFunctions.length,
    matchedByAddress: matched,
    hexPseudocode,
    idaCoverage: rows.length ? ida.length / rows.length : 0,
    hexCoverage: rows.length ? hexPseudocode / rows.length : 0,
    completeness: {
      completeStructuredCount,
      partialOrFallbackCount,
    },
    pseudoStackCount,
    stateMachineCount,
    registerLeakRate: bodyLines > 0 ? registerLeakLines / bodyLines : 0,
    castDensity: bodyLines > 0 ? castCount / bodyLines : 0,
    qualityTotals: { bodyLines, registerLeakLines, castCount },
    semantic: 'UNMEASURED',
    recompilability: 'UNMEASURED',
    competitorLatency: 'UNMEASURED',
    rows,
  };
}

export function aggregateComparisons(cases) {
  const totals = cases.reduce((a, c) => {
    a.denominator += c.denominator;
    a.ida += c.idaFunctions;
    a.hex += c.hexFunctions;
    a.matched += c.matchedByAddress;
    a.hexPseudo += c.hexPseudocode;
    a.completeStructuredCount += c.completeness?.completeStructuredCount ?? 0;
    a.partialOrFallbackCount += c.completeness?.partialOrFallbackCount ?? 0;
    a.pseudoStackCount += c.pseudoStackCount ?? 0;
    a.stateMachineCount += c.stateMachineCount ?? 0;
    a.bodyLines += c.qualityTotals?.bodyLines ?? 0;
    a.registerLeakLines += c.qualityTotals?.registerLeakLines ?? 0;
    a.castCount += c.qualityTotals?.castCount ?? 0;
    return a;
  }, {
    denominator: 0,
    ida: 0,
    hex: 0,
    matched: 0,
    hexPseudo: 0,
    completeStructuredCount: 0,
    partialOrFallbackCount: 0,
    pseudoStackCount: 0,
    stateMachineCount: 0,
    bodyLines: 0,
    registerLeakLines: 0,
    castCount: 0,
  });

  return {
    denominator: totals.denominator,
    ida: totals.ida,
    hex: totals.hex,
    matched: totals.matched,
    hexPseudo: totals.hexPseudo,
    idaCoverage: totals.denominator ? totals.ida / totals.denominator : 0,
    hexCoverage: totals.denominator ? totals.hexPseudo / totals.denominator : 0,
    completeness: {
      completeStructuredCount: totals.completeStructuredCount,
      partialOrFallbackCount: totals.partialOrFallbackCount,
    },
    pseudoStackCount: totals.pseudoStackCount,
    stateMachineCount: totals.stateMachineCount,
    registerLeakRate: totals.bodyLines > 0 ? totals.registerLeakLines / totals.bodyLines : 0,
    castDensity: totals.bodyLines > 0 ? totals.castCount / totals.bodyLines : 0,
    semantic: 'UNMEASURED',
    recompilability: 'UNMEASURED',
    competitorLatency: 'UNMEASURED',
  };
}
