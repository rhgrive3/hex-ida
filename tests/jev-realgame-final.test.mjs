import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readJevEvidence} from '../scripts/read-jev-evidence.mjs';
import { requestBody, structuralMatch, funnel, verifyCases, sha256, CASE_HASH, evidenceJSON } from '../scripts/jev-realgame-final-contract.mjs';
import { RealGameJevClient, validateChoice } from '../scripts/jev-realgame-final-client.mjs';
import { rerankWithJev, jevShortlist } from '../js/pinpoint.js';
import { parsePtypeOutput } from '../scripts/extract-jev-realgame-layout.mjs';
import { isGoldMatch } from '../scripts/run-jev-realgame-eval.mjs';
import { resolveStructuralGold } from '../scripts/audit-jev-realgame-gold.mjs';
import { recoveryRequestBody,deterministicRecoveryPick } from '../scripts/jev-realgame-recovery-contract.mjs';
import { verifyRecoveryEvidence } from '../scripts/verify-jev-realgame-recovery.mjs';
import { summarize } from '../scripts/evaluate-jev-realgame-final.mjs';
import { verifyEvidence } from '../scripts/verify-jev-realgame-final.mjs';

const member = (key, offset = 306) => ({ key, source: 'cxx', binarySha256: 'binary-a', className: 'Vehicle',
  anonymous: true, syntheticName: `member_0x${offset.toString(16)}`, fieldName: null, offset, size: 2,
  recoveredType: { category: 'int16', proven: true }, readCount: 4, writeCount: 1, conflict: false,
  functionContexts: [{ address: '100', name: null, receiverProven: true, readCount: 4, writeCount: 1, rule: 'width-only' }], score: 1 });
const gold = { status: 'verified', semanticLabel: 'Vehicle.cur_speed', identities: [
  { binarySha256: 'binary-a', className: 'Vehicle', offset: 306, size: 2, type: 'uint16_t', allowedCategories: ['int16'] },
] };
const response = choice => ({ model: 'openjev', answers: { pick: { type: 'choice', choice, confidence: .8, probabilities: { [choice]: .8 } }, unique: { type: 'noul', noul: .5 } } });

test('retained real-game evidence replays all decisions and rejects corpus, build, gold, payload and result drift', () => {
  const report=new URL('../reports/investigations/jev-realgame-final/',import.meta.url);
  const read=name=>readJevEvidence(new URL(name,report));
  const original={casesBytes:fs.readFileSync(new URL('../reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json',import.meta.url)),
    gold:JSON.parse(read('structural-gold.json')),policyBytes:read('policy-freeze.json'),
    snapshots:['openttd','openmw'].map(k=>JSON.parse(read(`production-snapshots/${k}.json`))),
    rows:read('raw-results.jsonl').toString().trim().split('\n').map(JSON.parse),summary:JSON.parse(read('summary.json'))};
  assert.deepEqual(verifyEvidence(original),{cases:70,verified:49,calls:840,valid:true});
  const mutations=[
    v=>{v.casesBytes=Buffer.concat([v.casesBytes,Buffer.from(' ')]);},
    v=>{v.snapshots[0].binarySha256='another-build';},
    v=>{v.snapshots[0].policySha256='unfrozen-policy';},
    v=>{v.gold.cases[0].identities[0].offset++;},
    v=>{v.rows[0].arms.D.calls[0].criteria.c0='Vehicle.cur_speed';},
    v=>{v.rows[0].arms.D.repeatedKeys[0]='invented';},
    v=>{v.rows[0].funnel.recovered=true;},
    v=>{v.summary.summaries.D.top1++;},
  ];
  for(const mutate of mutations) {
    const v={...structuredClone(original),casesBytes:Buffer.from(original.casesBytes),policyBytes:Buffer.from(original.policyBytes)};
    mutate(v);assert.throws(()=>verifyEvidence(v));
  }
});

test('canonical BigInt addresses survive snapshot serialization without precision loss', () => {
  const address = 0xffffffffffffffffn;
  const decoded = JSON.parse(evidenceJSON({ classIdentity: { vtableAddress: address, offsetToTop: 0n }, offset: 306 }));
  assert.equal(decoded.classIdentity.vtableAddress,'18446744073709551615');
  assert.equal(BigInt(decoded.classIdentity.vtableAddress),address);
  assert.equal(decoded.offset,306);
});

test('independent DWARF extractor retains scalar, pointer and array declarations ending in semicolons', () => {
  const tree=parsePtypeOutput('/* offset | size */ type = struct Sample {\n/* 8 | 2 */ uint16_t speed;\n/* 16 | 8 */ void *data;\n/* 24 | 12 */ int values[3];\n}');
  assert.deepEqual(tree.children.map(c=>[c.name,c.offset,c.size]),[['speed',8,2],['data',16,8],['values[3]',24,12]]);
});

test('anonymous scoring uses exact build/class/offset/width and verified type, never semantic names', () => {
  const c = member('anon');
  assert.equal(structuralMatch(c, gold), true);
  for (const change of [{ binarySha256: 'another-build' }, { className: 'Train' }, { offset: 304 }, { size: 4 },
    { recoveredType: { category: 'float', proven: true } }, { conflict: true }]) assert.equal(structuralMatch({ ...c, ...change }, gold), false);
  assert.equal(structuralMatch({ ...c, fieldName: 'cur_speed', offset: 300 }, gold), false);
  assert.equal(structuralMatch(c, { ...gold, status: 'unverified' }), false);
  assert.equal(structuralMatch(member('other', 400), { ...gold, identities: [...gold.identities,
    { binarySha256: 'binary-a', className: 'Vehicle', offset: 400, size: 2 }] }), true);
  assert.equal(isGoldMatch({...c,fieldName:'cur_speed'},{class:'Vehicle',field:'cur_speed'}),false);
  assert.equal(isGoldMatch(c,gold),true);
});

test('unqualified class labels require verified qualification and cannot guess a namespace',()=>{
  const cls={status:'resolved',className:'ns::State',declaration:'class ns::State',members:[{path:'level',offset:4,size:4,type:'int'}]};
  const layout={classes:{State:{status:'unresolved'},'ns::State':cls}};
  assert.equal(resolveStructuralGold(layout,{class:'State',field:'level'},'binary').status,'unverified');
  assert.equal(resolveStructuralGold({...layout,qualifiedAliases:{State:{verified:true,className:'ns::State'}}},{class:'State',field:'level'},'binary').identity.className,'ns::State');
});

test('recovery/publication/shortlist failures are distinct', () => {
  const c = member('anon');
  const stages = [[[],[],[]], [[c],[],[]], [[c],[c],[]], [[c],[c],[c]]];
  const results = stages.map(([recovered,candidates,shortlist]) => funnel({ recovered,candidates,shortlist },gold));
  assert.equal(results[0].unreachableBecauseNotRecovered,true);
  assert.equal(results[1].recoveredButNotPublished,true);
  assert.equal(results[2].publishedButOutsideShortlist,true);
  assert.equal(results[3].shortlist,true);
  assert.equal(results[3].unreachableBecauseNotRecovered,false);
});

test('all representations ignore injected oracle/source fields and arbitrary descriptions', () => {
  const candidates = [member('a'),member('b',304)].map(c => ({ ...c, goldName: 'cur_speed', semanticLabel: 'Vehicle.cur_speed',
    sourceDescription: 'cur_speed health money', description: 'cur_speed', dwarf: { name: 'cur_speed' }, oracle: gold }));
  for (const arm of ['current','B','C','D']) {
    const body = requestBody('current vehicle speed',candidates,arm);
    const descriptions = JSON.stringify(body.questions.pick.criteria);
    assert.equal(/cur_speed|health|money/.test(descriptions),false);
    assert.equal(body.questions.pick.instructions.includes('not proof'),true);
  }
  assert.equal(requestBody('speed',candidates,'B').questions.pick.criteria.c0,'Vehicle.member_0x132');
});

test('frozen queries cannot change, and shortlist is <=255 with unique existing IDs', () => {
  const bytes = fs.readFileSync(new URL('../reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json',import.meta.url));
  assert.equal(sha256(bytes),CASE_HASH);
  assert.equal(verifyCases(bytes).length,70);
  assert.throws(() => verifyCases(Buffer.concat([bytes,Buffer.from(' ')])),/hash mismatch/);
  const shortlist = jevShortlist(Array.from({ length:400 },(_,i)=>member(`k${i}`,i)),{max:255});
  assert.equal(Object.keys(requestBody('speed',shortlist,'D').questions.pick.criteria).length,255);
  assert.throws(() => requestBody('speed',Array.from({length:256},(_,i)=>member(`k${i}`,i)),'B'),/shortlist/);
});

test('live client rejects invented, out-of-range, malformed and invalid probability responses', () => {
  assert.equal(validateChoice(response('c1'),2),null);
  assert.equal(validateChoice(response('c2'),2),'invalid-candidate');
  assert.equal(validateChoice(response('c999'),255),'invalid-candidate');
  assert.equal(validateChoice(response('invented'),2),'malformed-choice');
  assert.equal(validateChoice(response('c01'),2),'malformed-choice');
  assert.equal(validateChoice({ ...response('c1'),model:'wrong' },2),'model-mismatch');
  const bad = response('c1');bad.answers.pick.probabilities.c500=1;
  assert.equal(validateChoice(bad,2),'invalid-probability');
});

test('HTTP/timeout/malformed/invented failures keep actual Hex top1 and verdict', async () => {
  const candidates = [member('a'),member('b',304)];
  const hex = { top:candidates[0],candidates,verdict:'ambiguous' };
  const fixtures = [
    async()=>({ok:false,status:500}),
    async()=>{throw new DOMException('timeout','TimeoutError');},
    async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('bad JSON');}}),
    async()=>({ok:true,status:200,json:async()=>response('c999')}),
    async()=>({ok:true,status:200,json:async()=>response('invented')}),
  ];
  for (const fetchImpl of fixtures) {
    const client = new RealGameJevClient({apiKey:'test',arm:'D',fetchImpl,maxAttempts:1});
    const result = await rerankWithJev('speed',hex,{enabled:true,client});
    assert.equal(result.top1,hex.top);assert.equal(result.source,'hex');assert.equal(result.hexResult,hex);
    assert.equal(hex.verdict,'ambiguous');
  }
});

test('disabled and exact/strong paths never call external service; successful preference cannot mint strength', async () => {
  const candidates=[member('a'),member('b',304)];let calls=0;
  const client={call:async()=>{calls++;return {choiceIndex:1,selectedKey:'b'};}};
  for (const options of [{enabled:false},{enabled:true,mode:'exact'},{enabled:true,verdict:'likely'},{enabled:true,verdict:'confirmed'}]) {
    const hex={top:candidates[0],candidates,verdict:options.verdict??'ambiguous'};
    const result=await rerankWithJev('speed',hex,{...options,client});assert.equal(result.top1,hex.top);
  }
  assert.equal(calls,0);
  const hex={top:candidates[0],candidates,verdict:'ambiguous'};
  const result=await rerankWithJev('speed',hex,{enabled:true,client});
  assert.equal(result.top1,candidates[1]);assert.equal(hex.verdict,'ambiguous');
});


test('recovery representation ignores oracle-shaped descriptions and bounds machine context',()=>{
  const c={...member('existing'),description:'GOLD SECRET CUR_SPEED',semanticLabel:'GOLD SECRET',
    functionContexts:[{address:'100',name:'_ZNK6Widget8getCountEv',receiverProven:true,accessRoles:['return-input','GOLD SECRET']}]};
  const body=recoveryRequestBody('widget count',[member('other'),c],'E');
  const serialized=JSON.stringify(body);
  assert.ok(!serialized.includes('GOLD SECRET'));
  assert.ok(serialized.includes('return-input'));
  assert.ok(serialized.includes('Widget::getCount'));
  assert.equal(deterministicRecoveryPick('widget count',[member('other'),c]).key,'existing');
});


test('recovery replay rejects gold, build, candidate selection and oracle payload drift',()=>{
  const c={id:'check',binary:'openttd',query:'widget count',...gold};
  const collectionBytes=fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/recovery-policy-freeze.json',import.meta.url));
  const cases=[c],policy={repeats:1,promptSha256:sha256(fs.readFileSync(new URL('../scripts/jev-realgame-recovery-contract.mjs',import.meta.url))),collection:JSON.parse(collectionBytes).collection};
  const candidates=[member('one'),member('two',400)];
  const input={id:c.id,binary:c.binary,query:c.query,binarySha256:'binary-a',candidates,published:candidates,
    recovered:candidates,shortlist:candidates,topKey:'one',routed:true,recovery:{attempted:[],elapsedMs:2,status:'complete'}};
  const row={id:c.id,binary:c.binary,query:c.query,status:c.status,gold:c,funnel:funnel(input,c),
    topKey:'one',hexCorrect:true,verdict:'ambiguous',hexLatencyMs:1,recoveryLatencyMs:2,failureCauses:[],
    arms:{A:{key:'one',correct:true},DET:{key:'one',correct:true}}};
  for(const arm of ['B','E']) {
    const body=recoveryRequestBody(c.query,candidates,arm);
    row.arms[arm]={key:'one',correct:true,repeatedKeys:['one'],repeatedCorrect:[true],calls:[{
      arm,query:c.query,repeat:0,bodyHash:sha256(JSON.stringify(body)),criteria:body.questions.pick.criteria,
      attempts:[{number:1,status:200,error:null,latencyMs:1}],error:null,addedLatencyMs:1,
      choiceIndex:0,selectedKey:'one',response:response('c0')}]};
  }
  const caseBytes=Buffer.from(JSON.stringify(cases)),policyBytes=Buffer.from(JSON.stringify(policy));
  const snapshots=[{complete:true,productSha:'test-only',policySha256:sha256(collectionBytes),sourceHashes:{},
    binaryKey:'openttd',binarySha256:'binary-a',collection:{keyCollisions:0},rows:[input]}];
  const rows=[row],summaries=Object.fromEntries(['A','DET','B','E'].map(a=>[a,summarize(rows,a)]));
  const summary={productSha:'test-only',caseSha256:sha256(caseBytes),policySha256:sha256(policyBytes),sourceHashes:{},summaries,
    coldRecoveryLatency:{count:1,p50:2,p95:2,p99:2},perGame:Object.fromEntries(['openttd','openmw'].map(game=>
      [game,Object.fromEntries(['A','DET','B','E'].map(a=>[a,summarize(rows.filter(r=>r.binary===game),a)]))]))};
  const original={caseBytes,policyBytes,snapshots,rows,summary};
  assert.deepEqual(verifyRecoveryEvidence(original),{cases:1,verified:1,calls:2,valid:true});
  for(const mutate of [v=>{v.snapshots[0].binarySha256='other';},v=>{v.rows[0].gold.identities[0].offset++;},
    v=>{v.rows[0].arms.E.calls[0].criteria.c0='Vehicle.cur_speed';},
    v=>{v.rows[0].arms.E.calls[0].selectedKey='invented';},v=>{v.summary.summaries.E.top1++;},
    v=>{v.snapshots[0].sourceHashes['js/analysis/cxx/query-recovery.js']='drift';v.summary.sourceHashes['js/analysis/cxx/query-recovery.js']='drift';},
    v=>{v.snapshots[0].rows[0].recovery.elapsedMs=20000;},v=>{v.rows[0].failureCauses=['wrong gold'];}]) {
    const copy={...structuredClone(original),caseBytes:Buffer.from(caseBytes),policyBytes:Buffer.from(policyBytes)};
    mutate(copy);assert.throws(()=>verifyRecoveryEvidence(copy));
  }
});
