import fs from 'node:fs';
import path from 'node:path';
import { parseIdaFunctions } from './ida-parser.mjs';
import { structuralReadabilityMetrics } from './metrics.mjs';

const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
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
      idaName:i?.name ?? null,
      hexName:h?.name ?? null,
      idaPresent:!!i,
      hexPresent:!!h,
      hexState:h?.state ?? null,
      idaMetrics:i ? structuralReadabilityMetrics(i.pseudocode) : null,
      hexMetrics:h?.pseudocode ? structuralReadabilityMetrics(h.pseudocode) : null,
    };
  });
  const matched = rows.filter(r => r.idaPresent && r.hexPresent).length;
  const hexPseudocode = rows.filter(r => r.hexMetrics != null).length;
  return {
    caseId:caseEntry.id,
    denominator:rows.length,
    idaFunctions:ida.length,
    hexFunctions:hexFunctions.length,
    matchedByAddress:matched,
    hexPseudocode,
    idaCoverage:rows.length ? ida.length / rows.length : 0,
    hexCoverage:rows.length ? hexPseudocode / rows.length : 0,
    semantic:'UNMEASURED', recompilability:'UNMEASURED', competitorLatency:'UNMEASURED',
    rows,
  };
}

export function aggregateComparisons(cases) {
  const totals = cases.reduce((a,c) => {
    a.denominator += c.denominator; a.ida += c.idaFunctions; a.hex += c.hexFunctions;
    a.matched += c.matchedByAddress; a.hexPseudo += c.hexPseudocode; return a;
  }, {denominator:0,ida:0,hex:0,matched:0,hexPseudo:0});
  return {
    ...totals,
    idaCoverage:totals.denominator ? totals.ida / totals.denominator : 0,
    hexCoverage:totals.denominator ? totals.hexPseudo / totals.denominator : 0,
    semantic:'UNMEASURED', recompilability:'UNMEASURED', competitorLatency:'UNMEASURED',
  };
}
