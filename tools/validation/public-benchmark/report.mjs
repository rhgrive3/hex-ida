#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function formatReport(report) {
  const aggregate = report.comparison?.aggregate ?? {};
  const git = report.provenance?.git;
  const manifest = report.provenance?.manifest;
  const workingTree = git?.dirty === true ? 'DIRTY' : git?.dirty === false ? 'CLEAN' : 'UNKNOWN';
  const dirtyEntries = Array.isArray(git?.dirtyEntries) && git.dirtyEntries.length
    ? `\nDirty entries: ${JSON.stringify(git.dirtyEntries)}`
    : '';
  const functionStates = JSON.stringify(report.functionStates ?? {});

  return `# ${report.suite}

Source commit: ${git?.sha ?? 'UNKNOWN'}
Working tree: ${workingTree}${dirtyEntries}
Manifest: ${manifest?.path ?? 'UNKNOWN'}
Manifest SHA-256: ${manifest?.sha256 ?? 'UNKNOWN'}
Scope: ${report.comparison?.scope ?? 'unknown'}

Cases: ${report.total}
States: ${JSON.stringify(report.states ?? {})}
Function states: ${functionStates}

Function-union denominator: ${aggregate.denominator ?? 0}
Matched by address: ${aggregate.matched ?? 0}
IDA artifact coverage: ${((aggregate.idaCoverage ?? 0) * 100).toFixed(2)}%
Hex pseudocode coverage: ${((aggregate.hexCoverage ?? 0) * 100).toFixed(2)}%

Semantic: UNMEASURED
Recompilability: UNMEASURED
Competitor latency: UNMEASURED

This is public-artifact evidence only. It does not set nativeCompetitorsRun and consumes 0 SCPA native cells.`;
}

const summaryPath = process.argv[2];
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!summaryPath) {
    console.error('report requires summary.json');
    process.exitCode = 2;
  } else {
    console.log(formatReport(JSON.parse(fs.readFileSync(summaryPath, 'utf8'))));
  }
}
