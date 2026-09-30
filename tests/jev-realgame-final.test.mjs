import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestBody, structuralMatch, funnel, verifyCases, sha256, CASE_HASH } from '../scripts/jev-realgame-final-contract.mjs';
import { RealGameJevClient, validateChoice } from '../scripts/jev-realgame-final-client.mjs';
import { rerankWithJev, jevShortlist } from '../js/pinpoint.js';

const member = (key, offset = 306) => ({ key, source: 'cxx', binarySha256: 'binary-a', className: 'Vehicle',
  anonymous: true, syntheticName: `member_0x${offset.toString(16)}`, fieldName: null, offset, size: 2,
  recoveredType: { category: 'int16', proven: true }, readCount: 4, writeCount: 1, conflict: false,
  functionContexts: [{ address: '100', name: null, receiverProven: true, readCount: 4, writeCount: 1, rule: 'width-only' }], score: 1 });
const gold = { status: 'verified', semanticLabel: 'Vehicle.cur_speed', identities: [
  { binarySha256: 'binary-a', className: 'Vehicle', offset: 306, size: 2, type: 'uint16_t', allowedCategories: ['int16'] },
] };
const response = choice => ({ model: 'openjev', answers: { pick: { type: 'choice', choice, confidence: .8, probabilities: { [choice]: .8 } }, unique: { type: 'noul', noul: .5 } } });

test('anonymous scoring uses exact build/class/offset/width and verified type, never semantic names', () => {
  const c = member('anon');
  assert.equal(structuralMatch(c, gold), true);
  for (const change of [{ binarySha256: 'another-build' }, { className: 'Train' }, { offset: 304 }, { size: 4 },
    { recoveredType: { category: 'float', proven: true } }, { conflict: true }]) assert.equal(structuralMatch({ ...c, ...change }, gold), false);
  assert.equal(structuralMatch({ ...c, fieldName: 'cur_speed', offset: 300 }, gold), false);
  assert.equal(structuralMatch(c, { ...gold, status: 'unverified' }), false);
  assert.equal(structuralMatch(member('other', 400), { ...gold, identities: [...gold.identities,
    { binarySha256: 'binary-a', className: 'Vehicle', offset: 400, size: 2 }] }), true);
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
