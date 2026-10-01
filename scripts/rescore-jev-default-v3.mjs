#!/usr/bin/env node
// Correct the missing baseline flag without rerunning/tuning remote inference.
// Original execution sources, raw calls and erroneous summary stay retained.
import fs from 'node:fs';
import path from 'node:path';
import {summarize} from './evaluate-jev-realgame-final.mjs';
import {DEFAULT_V3_ARMS} from './evaluate-jev-default-v3.mjs';
import {persistentWrite,sha256} from './jev-realgame-final-contract.mjs';

export function baselineSummaries(rows) {
  const withHex=rows.map(row=>({...row,hexCorrect:row.arms.A.correct}));
  const withLocal=rows.map(row=>({...row,hexCorrect:row.arms.R1.correct}));
  return {
    summaries:Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summarize(withHex,arm)])),
    vsR1:Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,summarize(withLocal,arm)])),
    perGame:Object.fromEntries(['openttd','openmw'].map(game=>[game,Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>
      [arm,summarize(withLocal.filter(row=>row.binary===game),arm)]))])),
    perGameVsHex:Object.fromEntries(['openttd','openmw'].map(game=>[game,Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>
      [arm,summarize(withHex.filter(row=>row.binary===game),arm)]))])),
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const dir=process.argv[2];if(!dir)throw new Error('usage: RESULT_DIRECTORY');
  const raw=fs.readFileSync(path.join(dir,'raw-results.jsonl')),rows=raw.toString().trim().split('\n').map(line=>JSON.parse(line));
  const originalFile=path.join(dir,'summary.original-missing-baseline.json'),summaryFile=path.join(dir,'summary.json');
  if(!fs.existsSync(originalFile))persistentWrite(originalFile,fs.readFileSync(summaryFile,'utf8'));
  const originalBytes=fs.readFileSync(originalFile),original=JSON.parse(originalBytes);
  if(rows.length!==50||!original.complete)throw new Error('full immutable V3 result required');
  const corrected={...original,...baselineSummaries(rows),scoringRepair:{
    reason:'canonical summarize requires row.hexCorrect; evaluator omitted it. Restore A/R1 baseline flags from unchanged per-arm structural correctness.',
    originalSummarySha256:sha256(originalBytes),unchangedRawResultsSha256:sha256(raw),
    repairSourceSha256:sha256(fs.readFileSync(new URL(import.meta.url))),
    remoteCallsRepeated:0,queriesChanged:0,promptChanged:false,criteriaChanged:false}};
  persistentWrite(summaryFile,corrected);console.log(JSON.stringify({rescues:corrected.summaries.V3.rescue,
    regressions:corrected.summaries.V3.regression,net:corrected.summaries.V3.net,vsR1:corrected.vsR1.V3.net}));
}
