/** Aggregate acceptance gate: no weights, no selected per-stage speedup average. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [baseFilesArg,workFilesArg,outputArg] = process.argv.slice(2);
if (!baseFilesArg || !workFilesArg || !outputArg) throw new Error('usage: node compare.mjs base1.json,base2.json,base3.json work1.json,work2.json,work3.json output.json');
const load = (list) => list.split(',').map(file=>({file:path.resolve(file),...JSON.parse(fs.readFileSync(file,'utf8'))}));
const base=load(baseFilesArg),work=load(workFilesArg),all=[...base,...work];
assert.equal(base.length,3,'three predeclared baseline runs required');assert.equal(work.length,3,'three predeclared candidate runs required');
const template=base[0];
for (const row of all) {
  for (const key of ['workloadSha256','harnessSha256','corpusSha256','payloadSha256','node','v8','platform','arch','cpu']) assert.equal(row[key],template[key],`${row.file}:${key}`);
  assert.deepEqual(row.stages.map(s=>s.name),template.stages.map(s=>s.name),'same stage sequence');
  assert.deepEqual(row.outcomes,{successful:180,failures:90},'same work outcomes');
  assert.deepEqual(row.observations,template.observations,'all function observations identical');
  assert.deepEqual(row.outputs,template.outputs,'hashes/searches/export identical');
  assert.equal(row.outputSha256,template.outputSha256,'independent complete output SHA');
  assert.ok(row.stages.every(s=>Number.isFinite(s.elapsedMs)&&s.elapsedMs>=0),'valid timings');
  assert.equal(row.workloadMs,row.stages.reduce((sum,s)=>sum+s.elapsedMs,0),'raw elapsed sums, no weights');
}
for(const rows of [base,work])for(const row of rows)assert.equal(row.sourceManifest.sha256,rows[0].sourceManifest.sha256,'source immutable within a measurement side');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const baseMedian=median(base.map(r=>r.workloadMs)),workMedian=median(work.map(r=>r.workloadMs));
const brief=row=>({file:path.basename(row.file),workloadMs:row.workloadMs,processElapsedMs:row.processElapsedMs,maxRssKiB:row.maxRssKiB});
const baselineRepresentative=base.find(r=>r.workloadMs===baseMedian),candidateRepresentative=work.find(r=>r.workloadMs===workMedian);
const result={schemaVersion:1,workloadSha256:template.workloadSha256,harnessSha256:template.harnessSha256,
  baselineSourceSha256:base[0].sourceManifest.sha256,candidateSourceSha256:work[0].sourceManifest.sha256,
  method:'median of three complete elapsed sums, 13 stages; equal frozen task counts; no stage weights',
  baseline:base.map(brief),candidate:work.map(brief),baselineMedianMs:baseMedian,candidateMedianMs:workMedian,
  savedMs:baseMedian-workMedian,reductionFraction:1-workMedian/baseMedian,requiredReductionFraction:0.30,
  passed:workMedian<=baseMedian*0.70,outputSha256:template.outputSha256,outcomes:template.outcomes,
  stageTableMethod:'stages from the median-total representative run on each side; these sum to the headline totals',
  stageTable:template.stages.map((stage,i)=>({name:stage.name,baselineMs:baselineRepresentative.stages[i].elapsedMs,candidateMs:candidateRepresentative.stages[i].elapsedMs})),
  meanTotalMs:{baseline:base.reduce((s,r)=>s+r.workloadMs,0)/base.length,candidate:work.reduce((s,r)=>s+r.workloadMs,0)/work.length},
  verification:{allSixOutputRecordsEqual:true,allSixTaskCountsEqual:true,allSixHarnessesEqual:true,allSixEnvironmentsEqual:true}};
fs.mkdirSync(path.dirname(path.resolve(outputArg)),{recursive:true});fs.writeFileSync(outputArg,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(!result.passed) process.exitCode=1;
