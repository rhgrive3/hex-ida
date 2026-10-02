import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CxxMemberIndex } from '../../../js/analysis/cxx/member-index.js';
import { createCppReceiverEvidence, createCppMemberEvidence } from '../../../js/analysis/cxx/object-evidence.js';
import { pinpoint, pinpointField, pinpointFunction, rerankWithJev } from '../../../js/pinpoint.js';
import { FieldIndex } from '../../../js/fields.js';
import { parseGoal } from '../../../js/goals.js';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';
import { cxxMemberIndexForApp, recoverCxxMembersForQuery, recoverCxxMemberWithJev } from '../../../js/analysis/query/app-adapter.js';
import { composePinpointFields } from '../../../js/pinpoint-fields.js';
import { __investigationInternalsForTests } from '../../../js/analysis/investigation-service.js';
import { proofText } from '../../../js/narrate.js';
import { autoAnalyze } from '../../../js/auto.js';
import { cxxSemanticViews, withCxxSemanticPreference } from '../../../js/analysis/query/cxx-semantic-preference.js';
import { requestJevAlternative } from '../../../js/analysis/query/jev-advisory.js';

test('single-function interactive extension preserves Hex on API failure and unknown or oversized extents',async()=>{
 let decompiles=0,currentCaptures=0,calls=0;
 const symbols={gen:1,names:['_ZNK6Widget8getCountEv','_ZNK6Widget7isReadyEv'],addrs:[1n,2n],funcs:[1n,2n],
  declaredFunctionEnd:a=>a+(a===1n?1024n:28n)};
 const backend={file:{},gen:1,binaryId:'extension-fixture',readAt:async()=>({found:false})};
 const app={symbols,backend,store:{get:key=>({architecture:'arm64',sliceIndex:0})[key]},executableRegionFor:()=>({start:1n,end:2048n}),
  analysisQueries:{snapshot:async()=>({snapshotId:'bound'}),decompile:async()=>{decompiles++;throw Error('unexpected analysis');}}};
 const baseline={verdict:'none',top:null,candidates:[]};
 const options={enabled:true,mode:'partial',captureBaseline:async()=>baseline,captureCurrent:async()=>{currentCaptures++;return baseline;},
  jevClient:{call:async()=>{calls++;return null;}}};
 assert.equal((await recoverCxxMemberWithJev(app,'widget count',options)).result,baseline);
 assert.equal(decompiles,0);assert.equal(currentCaptures,0);assert.equal(calls,1);
 const oversized={call:async input=>{
  const choice='c'+input.choices.findIndex(row=>row.address===1n),answer={type:'choice',choice,confidence:1,probabilities:{[choice]:1}};
  return {model:'openjev',answers:{object:answer,pick:answer}};
 }};
 assert.equal((await recoverCxxMemberWithJev(app,'widget count',{...options,jevClient:oversized})).result,baseline);
 assert.equal(decompiles,0);assert.equal(currentCaptures,0);
 symbols.declaredFunctionEnd=()=>null;symbols.gen++;
 assert.equal((await recoverCxxMemberWithJev(app,'widget count',{...options,jevClient:oversized})).result,baseline);
 assert.equal(decompiles,0);
 for(const change of [{enabled:false},{mode:'exact'},{captureBaseline:async()=>({...baseline,verdict:'likely'})}]){
  const before=calls;await recoverCxxMemberWithJev(app,'widget count',{...options,...change});assert.equal(calls,before);
 }
});

test('single-function interactive extension cancels stale epochs instead of returning the captured result',async()=>{
 const symbols={gen:1,names:['_ZNK6Widget8getCountEv','_ZNK6Widget7isReadyEv'],addrs:[1n,2n],funcs:[1n,2n],declaredFunctionEnd:a=>a+28n};
 const backend={file:{},gen:1,binaryId:'extension-stale',readAt:async()=>({found:false})};
 const app={symbols,backend,store:{get:key=>({architecture:'arm64',sliceIndex:0})[key]},executableRegionFor:()=>({start:1n,end:100n}),
  analysisQueries:{snapshot:async()=>({snapshotId:'bound'}),decompile:async()=>{throw Error('stale query cannot analyse');}}};
 const baseline={verdict:'none',top:null,candidates:[]};
 await assert.rejects(()=>recoverCxxMemberWithJev(app,'widget count',{enabled:true,mode:'partial',captureBaseline:async()=>baseline,
  captureCurrent:async()=>{throw Error('cannot capture stale state');},jevClient:{call:async()=>{backend.gen++;return null;}}}),/binding changed/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>recoverCxxMemberWithJev(app,'widget count',{enabled:true,mode:'partial',signal:controller.signal,
  captureBaseline:async()=>{throw Error('cancelled query cannot capture');},captureCurrent:async()=>baseline}),/abort/i);
});

test('symbol epoch changes retire cached C++ publication before another semantic query',async()=>{
 const symbols={gen:1,names:['_ZN6WidgetC1Ev'],addrs:[1n],funcs:[1n]};
 const file={},backend={file,gen:1,binaryId:'epoch-fixture',readAt:async()=>({found:false})};
 const app={symbols,backend,store:{get:key=>({architecture:'arm64',sliceIndex:0})[key]},
  executableRegionFor:()=>({start:1n,end:100n}),
  analysisQueries:{snapshot:async()=>({snapshotId:'bound'}),decompile:async()=>{throw Error('metadata-only query must not decompile');}}};
 await recoverCxxMembersForQuery(app,'widget',{enabled:true,planOnly:true});
 const before=cxxMemberIndexForApp(app);assert.ok(before);
 symbols.gen++;
 assert.equal(cxxMemberIndexForApp(app),null,'same object identity does not preserve stale symbol ownership');
 await recoverCxxMembersForQuery(app,'widget',{enabled:true,planOnly:true});
 assert.notEqual(cxxMemberIndexForApp(app),before);
 backend.gen++;assert.equal(cxxMemberIndexForApp(app),null);
});

test('optional production advisory sends only canonical facts and preserves local under choices and failures', async () => {
  const fields = new CxxMemberIndex(); fields.publish(projection('Thing', [{}, { offsetBytes: 12n }]));
  const local = await pinpointField({ goal: parseGoal('speed'), cxxFields: fields, limit: 400 });
  const symbols = { nameAt: () => '_ZN5Thing8getSpeedEv' };
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++; const body = JSON.parse(init.body);
    assert.equal(/oracle|secret-label/.test(JSON.stringify(body)), false);
    assert.equal(init.signal instanceof AbortSignal, true);
    return { ok: true, json: async () => ({ model: 'openjev', answers: {
      pick: { type: 'choice', choice: 'c1', confidence: .8, probabilities: { c1: .8 } }, unique: { type: 'noul', noul: .5 } } }) };
  };
  const options = { enabled: true, isCurrent: () => true, apiKey: 'test-key', symbols, fetchImpl };
  const result = await requestJevAlternative('speed', { ...local, candidates: local.candidates.map(c => ({ ...c, oracle: 'secret-label' })) }, options);
  assert.equal(result.top1, local.top); assert.equal(result.advisory.candidate.key, local.candidates[1].key);
  assert.equal(local.verdict, result.hexResult.verdict);
  for (const change of [{ enabled: false }, { mode: 'exact' }, { isCurrent: () => false }, { isCurrent: () => { throw new Error('stale'); } }]) {
    const before = calls; const r = await requestJevAlternative('speed', local, { ...options, ...change });
    assert.equal(r.top1, local.top); assert.equal(calls, before);
  }
  for (const fetchImpl of [async () => ({ ok: false, status: 500 }), async () => ({ ok: true, json: async () => ({ invented: 'c0' }) })]) {
    const r = await requestJevAlternative('speed', local, { ...options, fetchImpl });
    assert.equal(r.top1, local.top); assert.equal(r.advisory.candidate, null);
  }
});

function projection(className, members, address = 0x1000n) {
  const receiver = createCppReceiverEvidence({
    functionId: `fn_${address}`, functionAddress: address, canonicalValueId: 'arg0',
    receiverRole: 'this', classIdentity: { kind: 'named', className },
    nonStaticProof: { rule: 'vtable-slot', isStatic: false },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    snapshotId: 'test-binary:0', completeness: 'complete',
  });
  return { receiver, members: members.map((m) => createCppMemberEvidence({
    functionId: receiver.functionId, receiverDigest: receiver.digest,
    snapshotId: receiver.snapshotId, offsetBytes: 8n, sizeBytes: 4,
    category: 'int32', typeLabel: 'int32_t', rule: 'width-32',
    readCount: 1, writeCount: 0, ...m,
  })) };
}

test('binary method preference uses bound anonymous evidence without new analysis or stronger verdicts', async () => {
  const fields = new CxxMemberIndex();
  fields.publish(projection('Thing', [{}], 0x1000n));
  fields.publish(projection('Thing', [{ offsetBytes: 12n }], 0x2000n));
  let analyses = 0;
  const options = { goal: parseGoal('speed'), cxxFields: fields, limit: 400,
    analyze: async () => { analyses++; }, symbols: { nameAt: address => address === 0x1000n ? '_ZN5Thing8getSpeedEv' : '_ZN5Thing8getColorEv' } };
  const baseline = await pinpointField(options);
  const preferred = await pinpointField({ ...options, binaryContextPreference: true });
  assert.equal(baseline.top.offset, 12);
  assert.equal(preferred.top.offset, 8);
  assert.equal(preferred.verdict, baseline.verdict);
  assert.equal(preferred.top.field, baseline.candidates[1].field);
  assert.equal(preferred.semanticPreference.verdict, 'weak-preference');
  assert.equal(analyses, 0);
  assert.equal(withCxxSemanticPreference('speed', { ...baseline, verdict: 'confirmed' }, options.symbols).top, baseline.top);
  assert.equal(cxxSemanticViews([{ ...baseline.candidates[0], className: 'InventedOwner' }], options.symbols)[0], null);
  assert.equal(cxxSemanticViews([{ ...baseline.candidates[0], field: { ...baseline.top.field } }], options.symbols)[0], null);
  const mixed = { ...baseline, candidates: [...baseline.candidates, { source: 'objc' }] };
  assert.equal(withCxxSemanticPreference('speed', mixed, options.symbols), mixed);
});

test('canonical unnamed C++ members reach deterministic ranking without semantic names or new scans', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}, { offsetBytes: 12n }]));
  let analyses = 0;
  let scans = 0;
  const result = await pinpointField({ goal: parseGoal('health'), cxxFields,
    analyze: async () => { analyses++; throw new Error('unexpected analysis'); },
    scanAccess: async () => { scans++; throw new Error('unexpected scan'); }, limit: 400 });
  assert.equal(result.universe, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(analyses, 0);
  assert.equal(scans, 0);
  for (const c of result.candidates) {
    assert.equal(c.className, 'Thing');
    assert.match(c.field.name, /^(field|member)_/);
    assert.notEqual(c.field.name, 'health');
    assert.ok(c.classIdentity);
    assert.ok(c.provenance);
    assert.ok(Number.isFinite(c.fusion.logOdds));
    assert.ok(!c.evidence.some((e) => e.code === 'field-name-asked'));
    assert.equal(c.verified, false);
  }
  assert.ok(!['confirmed', 'likely'].includes(result.verdict));
  const seen = [];
  const reranked = await rerankWithJev('health', result, { enabled: true,
    client: { call: async ({ candidates }) => {
      seen.push(...candidates);
      return { selectedKey: candidates[1].key };
    } } });
  assert.equal(reranked.source, 'jev');
  assert.ok(result.candidates.includes(reranked.top1));
  assert.ok(seen.every((c) => result.candidates.includes(c)));
});

test('ObjC exact-name candidate retains its rank while unnamed C++ remains in the same lattice', async () => {
  const fields = new FieldIndex({ classes: [{ name: 'Thing', instanceSize: 32,
    ivars: [{ name: '_health', offset: 8, size: 4, type: { kind: 'int', bytes: 4 } }] }] });
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}]));
  const before = await pinpointField({ goal: parseGoal('health'), fields });
  const after = await pinpointField({ goal: parseGoal('health'), fields, cxxFields });
  assert.equal(after.top.key, before.top.key);
  assert.equal(after.top.probability, before.top.probability);
  assert.equal(after.candidates.length, 2);
  assert.equal(new Set(after.candidates.map((c) => c.key)).size, 2);
  assert.equal(after.candidates[1].source, 'cxx');
});

test('C++ keys remain disjoint from legacy ObjC keys even for separator-bearing binary names', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing#8#tail', [{ memberName: 'health' }]));
  const iv = [...cxxFields.classes.values()][0].ivars[0];
  // Construct the ObjC identity that collided with the previous C++ encoding.
  const oldKey = iv.key.replaceAll('\\u0023', '#');
  const [className, offset, name] = oldKey.split('#');
  const fields = new FieldIndex({ classes: [{ name: className, instanceSize: 32,
    ivars: [{ name, offset: Number(offset), size: 4, type: { kind: 'int', bytes: 4 } }] }] });
  assert.equal(`${className}#${offset}#${name}`, oldKey);
  assert.ok(!iv.key.includes('#'));
  assert.equal(JSON.parse(JSON.parse(iv.key.slice(4))[0])[2], 'Thing#8#tail');
  const result = await pinpointField({ goal: parseGoal(name), fields, cxxFields });
  assert.equal(result.candidates.length, 2);
  assert.equal(new Set(result.candidates.map((c) => c.key)).size, 2);
  assert.ok(result.candidates.some((c) => c.source === 'cxx'));
  assert.ok(result.candidates.some((c) => c.key === oldKey));
  cxxFields.publish(projection('Thing\\u00238\\u0023tail', [{ memberName: 'health' }]));
  assert.equal(new Set([...cxxFields.classes.values()].flatMap((cls) => cls.ivars.map((field) => field.key))).size, 2);
});

test('producer-supplied C++ names use existing deterministic evidence without creating another universe', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }, { offsetBytes: 12n }]));
  const result = await pinpointField({ goal: parseGoal('health'), cxxFields });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.top.memberName, 'health');
  assert.equal(result.top.anonymous, false);
  assert.ok(result.top.evidence.some((e) => e.code === 'access-verified' && e.detail.source === 'cxx'));
  assert.equal(result.top.provenance[0].member.memberName, 'health');
  assert.ok(result.candidates[1].anonymous);
});

test('the combined public Pinpoint entrypoint enumerates the same canonical C++ members', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }, { offsetBytes: 12n }]));
  const direct = await pinpointField({ goal: parseGoal('health'), cxxFields });
  const combined = await pinpoint({ goal: parseGoal('health'), cxxFields });
  assert.deepEqual(combined.field.candidates.map((c) => c.key), direct.candidates.map((c) => c.key));
  assert.equal(combined.field.top.field, direct.top.field);
});

test('automatic analysis can enumerate published C++ fields with no ObjC metadata or new analyzer', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }]));
  const report = await autoAnalyze({ cxxFields, deepLimit: 0 });
  assert.ok(report.stats.pinpointModes.field > 0);
  assert.ok(report.pinned.some((pin) => pin.top?.source === 'cxx' && pin.top.memberName === 'health'));
  assert.deepEqual(report.diagnostics, []);
});

test('an unrelated function touching the same offset cannot acquire a C++ class/member attribution', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }]));
  const goal = parseGoal('health');
  const ranked = [{ addr: 0x2000n, name: 'unrelated', reasons: [] }];
  let analyses = 0;
  const analyze = async () => {
    analyses++;
    return { basicBlocks: [], instructions: [{ row: 0, address: 0x2000n,
      mnemonic: 'str', ops: [], reads: [], writes: [],
      memory: { kind: 'store', base: 'x0', disp: 8n, size: 4 } }] };
  };
  const combined = await pinpoint({ goal, cxxFields, ranked, analyze });
  const direct = await pinpointFunction({ goal, ranked, analyze, field: combined.field.top });
  assert.ok(analyses > 0, 'existing function ranking still runs');
  assert.equal(combined.field.top.className, 'Player');
  for (const fn of [combined.function, direct]) {
    assert.equal(fn.candidates.length, 1);
    assert.ok(!fn.candidates[0].evidence.some((e) => e.detail?.className === 'Player'));
  }
});

test('synthetic labels cannot become recovered-name evidence or claim a semantic member name', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}, { offsetBytes: 12n }]));
  for (const query of ['member', 'member_0x8']) {
    const result = await pinpointField({ goal: parseGoal(query), cxxFields });
    assert.equal(result.candidates.length, 2);
    assert.ok(!['likely', 'confirmed'].includes(result.verdict));
    for (const c of result.candidates) {
      assert.equal(c.memberName, null);
      assert.equal(c.anonymous, true);
      assert.ok(!c.evidence.some((e) => /field-name|sibling-fields|access-verified/.test(e.code)));
    }
  }
});

test('a source flag cannot manufacture C++ candidates and C++ proof narration has no selector placeholder', async () => {
  const forged = { name: 'health', source: 'cxx', offset: 8, size: 4, type: { kind: 'int', bytes: 4 } };
  const fields = { classCount: 1, classes: new Map([['Fake', { name: 'Fake', ivars: [forged] }]]) };
  const result = await pinpointField({ goal: parseGoal('health'), fields });
  assert.equal(result.candidates.length, 0);
  const text = proofText({ code: 'access-verified', detail: { source: 'cxx', className: 'Thing', loads: 1, stores: 0 } });
  assert.ok(text.includes('Thing'));
  assert.ok(!text.includes('undefined'));
});

test('new member publication invalidates cached Pinpoint evidence coverage', () => {
  const goal = parseGoal('health');
  const cxxFields = new CxxMemberIndex();
  const internals = __investigationInternalsForTests;
  const before = internals.pinRequestIdentity({ cxxFields, cxxRevision: cxxFields.revision }, goal, {});
  cxxFields.publish(projection('Thing', [{}]));
  const after = internals.pinRequestIdentity({ cxxFields, cxxRevision: cxxFields.revision }, goal, {});
  assert.equal(internals.pinRequestMatches(before, after), false);
});

test('composing the lattice twice keeps one candidate and forged indexes cannot publish fields', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}]));
  const once = composePinpointFields(null, cxxFields);
  const twice = composePinpointFields(once, cxxFields);
  assert.equal(twice.fieldCount, 1);
  assert.equal(twice.classCount, 1);
  const fake = Object.create(CxxMemberIndex.prototype);
  const empty = await pinpointField({ goal: parseGoal('health'), cxxFields: fake });
  assert.equal(empty.candidates.length, 0);
  assert.equal(composePinpointFields(null, fake), null);
});

test('production Fast decompile publishes existing C++ recovery to Pinpoint and expires with the binary epoch', async () => {
  const binary = fileURLToPath(new URL('../../fixtures/cxx-dwarf-holdout/holdout.stripped.elf', import.meta.url));
  const product = await openProduct(binary);
  try {
    assert.ok(!product.unsupported);
    assert.equal(cxxMemberIndexForApp(product.app), null);
    const snapshot = await product.query.snapshot();
    const index = product.app.symbols.names.indexOf('_ZNK5Thing6updateEi');
    assert.ok(index >= 0);
    await product.query.decompile(snapshot, product.app.symbols.addrs[index], { profile: 'fast' });
    const cxxFields = cxxMemberIndexForApp(product.app);
    assert.ok(cxxFields?.fieldCount >= 2);
    const result = await pinpointField({ goal: parseGoal('health'), fields: product.app.fields, cxxFields, limit: 400 });
    assert.ok(result.candidates.length >= 2);
    assert.ok(result.candidates.every((c) => c.className === 'Thing'));
    // Loading ObjC metadata on an ELF cannot erase published C++ evidence.
    await product.app.ensureObjc(product.sliceIndex);
    assert.equal(cxxMemberIndexForApp(product.app), cxxFields);
    product.app.backend.advanceEpoch();
    assert.equal(cxxMemberIndexForApp(product.app), null);
  } finally { await product.close(); }
});
