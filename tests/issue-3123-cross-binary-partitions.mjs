import assert from 'node:assert/strict';
import fs from 'node:fs';
import { partitionFiles, partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

const workflow=fs.readFileSync('.github/workflows/cross-binary-accuracy.yml','utf8');
const partitions=JSON.parse(fs.readFileSync('tests/accuracy-partitions.json','utf8'));
const section=(name,next)=>{const start=workflow.indexOf(`  ${name}:`);assert.notEqual(start,-1,`missing ${name} job`);const end=next?workflow.indexOf(`  ${next}:`,start+1):workflow.length;return workflow.slice(start,end<0?workflow.length:end);};
const prepare=section('prepare','measure'), measure=section('measure','accuracy'), aggregate=section('accuracy');
const targets=['BattleCats','YWP','TsumTsum'];
const rawPartitions=['core','pinpoint','pseudoc-0','pseudoc-1','pseudoc-2','pseudoc-3'];

for(const target of targets){assert.ok(prepare.includes(`name: ${target}`));assert.ok(measure.includes(`name: ${target}`));}
assert.match(prepare,/max-parallel:\s*3/);
assert.match(prepare,/Publish prepared target inputs/);
assert.match(measure,/needs:\s*prepare/);
assert.match(measure,/max-parallel:\s*12/);
assert.match(measure,/partition:\s*\[core, pinpoint, pseudoc-0, pseudoc-1, pseudoc-2, pseudoc-3\]/);
assert.match(measure,/accuracy-result-v8-/);
assert.doesNotMatch(measure,/restore-keys:/);
assert.match(measure,/--max-old-space-size=4096 tests\/accuracy\.mjs/);
assert.match(measure,/accuracy-pseudoc-parallel\.mjs/);
assert.match(measure,/--workers=2 --shard-index="\$shard" --shard-count=4/);

assert.deepEqual(partitions.core,['sections','funcs','funcs-guess','disasm','kinds','calls','refs','imports','objc','selstub','strings','xrefs','funcname','selffield','role','apimeaning','summary','expr','formula']);
assert.deepEqual(partitions.pinpoint,['pinpoint','pinpoint-partial']);
for(let i=0;i<4;i++) assert.deepEqual(partitions[`pseudoc-${i}`],['pseudoc']);

const root=process.cwd();
for(const partition of rawPartitions){
  const files=partitionFiles(root,partition);
  assert.ok(files.includes('tests/accuracy-partitions.json'));
  assert.ok(files.includes('scripts/accuracy-partition-cache-key.mjs'));
  assert.ok(!files.includes('.github/workflows/cross-binary-accuracy.yml'),'topology-only workflow edits must not invalidate result caches');
  if(partition==='pinpoint') assert.ok(!files.some((f)=>f.startsWith('js/decompiler/')),'pinpoint cache must not depend on pseudocode-only implementation');
  else assert.ok(files.some((f)=>f.startsWith('js/decompiler/')),'core/pseudoc dependencies stay conservative');
}
for(let i=0;i<4;i++) assert.ok(partitionFiles(root,`pseudoc-${i}`).includes('tests/accuracy-pseudoc-parallel.mjs'));
const coreFiles=partitionFiles(root,'core');
const pinpointFiles=partitionFiles(root,'pinpoint');
const pseudocFiles=partitionFiles(root,'pseudoc-0');
assert.ok(!coreFiles.includes('js/pinpoint.js') && !pseudocFiles.includes('js/pinpoint.js'),
  'pinpoint-only implementation changes must not invalidate core/pseudoc exact caches');
assert.ok(pinpointFiles.includes('js/pinpoint.js'), 'pinpoint exact cache must include its implementation');
assert.ok(!pinpointFiles.some((f)=>f.startsWith('js/decompiler/')),
  'pseudocode-only implementation changes must not invalidate pinpoint exact cache');

const digests=rawPartitions.map((partition)=>partitionDigest(root,partition));
assert.equal(new Set(digests).size,rawPartitions.length,'feature/shard/worker contracts require distinct exact keys');

assert.match(aggregate,/needs:\s*\[prepare, measure\]/);
assert.match(aggregate,/18-job measurement matrices/);
assert.match(aggregate,/Validate all 18 raw partition results/);
assert.equal(targets.length * rawPartitions.length, 18);
assert.match(aggregate,/for target in BattleCats YWP TsumTsum/);
assert.match(aggregate,/accuracy-part-\$\{target\}-core\.json/);
assert.match(aggregate,/accuracy-part-\$\{target\}-pinpoint\.json/);
assert.match(aggregate,/for shard in 0 1 2 3/);
assert.match(aggregate,/accuracy-part-\$\{target\}-pseudoc-\$\{shard\}\.json/);
assert.match(aggregate,/accuracy-pseudoc-shard-merge\.mjs/);
assert.match(aggregate,/accuracy-merge\.mjs/);
assert.match(aggregate,/node tests\/accuracy-gate\.mjs/);
assert.match(aggregate,/name:\s*Matcher scaling regression[\s\S]*issue-500-matcher-budget\.mjs/);
assert.match(aggregate,/name:\s*Core tests for standalone manual validation[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*npm test/,
  'manual release validation must retain the broad core test suite');
assert.match(aggregate,/name:\s*Syntax lint[\s\S]*npm run lint/);
assert.doesNotMatch(workflow,/^  pull_request:/m,'cross-binary accuracy stays manual/push-only under CI development-mode policy');
assert.match(workflow,/cancel-in-progress:\s*true/);

console.log('issue #3123 cross-binary 18-partition topology/cache regression: PASS');
