import test from 'node:test';
import assert from 'node:assert/strict';
import { cxxSemanticScores, cxxObjectSemanticScores, compareCxxSemanticScores } from '../../../js/analysis/query/cxx-semantic-preference.js';
import { jevSemanticRoute, jevArgumentFlowRequest, jevArgumentContextSignature,jevVisibleArgumentContextSignature } from '../../../js/analysis/query/jev-advisory.js';
import { createCppMemberEvidence } from '../../../js/analysis/cxx/object-evidence.js';

test('object-aware ranking keeps the requested owner ahead of an unrelated lexical accessor',()=> {
  const views=[{key:'object',source:'cxx',anonymous:true,className:'Entity',functionContexts:[
    {address:'1',name:'_ZNK6Entity11getMovementEv',accessRoles:['comparison-input']}]},
  {key:'helper',source:'cxx',anonymous:true,className:'Subtitles',functionContexts:[
    {address:'2',name:'_ZNK9Subtitles10getEnabledEv',accessRoles:['return-input']}]}];
  const query='Which movement capabilities does this entity have enabled?';
  assert.equal(cxxSemanticScores(query,views).sort(compareCxxSemanticScores)[0].key,'helper');
  assert.equal(cxxObjectSemanticScores(query,views).sort(compareCxxSemanticScores)[0].key,'object');
  assert.equal(jevSemanticRoute(query,views,{topKey:'helper',policy:'object-context-v4'}).call,true,
    'an unrelated lexical accessor must not veto semantic comparison');
  assert.equal(jevSemanticRoute(query,views,{verdict:'confirmed',policy:'object-context-v4'}).call,false);
  assert.equal(jevSemanticRoute(query,views,{policy:'unknown'}).call,false);
  assert.deepEqual(cxxObjectSemanticScores(query,views.map(view=>({...view,offset:999,size:1,sourceFieldName:'gold'}))),
    cxxObjectSemanticScores(query,views),'layout and source names cannot alter semantic object priority');
  const input={address:'3',name:'_ZN6Entity8setStateEb',receiverProven:true,receiverRole:'this',
    accessRoles:['argument-written'],writtenArgumentRegisters:['x1']};
  const marker={...input,accessRoles:['constant-written','one-written'],writtenArgumentRegisters:[]};
  const stateViews=[{key:'setting',source:'cxx',anonymous:true,className:'Entity',functionContexts:[input]},
    {key:'marker',source:'cxx',anonymous:true,className:'Entity',functionContexts:[marker]}];
  const options={topKey:'setting',policy:'object-context-v4'};
  assert.deepEqual(jevSemanticRoute('What state is selected for this entity?',stateViews,options),
    {call:false,reason:'local-caller-input-versus-literal-markers'},
    'a unique local caller input is preserved against literal markers from the same operation');
  assert.equal(jevSemanticRoute('What state is selected for this entity?',stateViews.map(v=>({...v,
    functionContexts:v.functionContexts.map(c=>({...c,address:v.key==='marker'?'4':c.address}))})),options).call,true,
    'a marker from a different operation does not establish this preservation rule');
  assert.equal(jevSemanticRoute('What state is selected for this entity?',stateViews.map(v=>({...v,
    functionContexts:v.functionContexts.map(c=>({...c,receiverProven:false}))})),options).call,true,
    'unproven input origins cannot authorize the preservation rule');
  assert.equal(jevSemanticRoute('What state is selected for this entity?',stateViews.map(v=>({...v,
    functionContexts:v.functionContexts.map(c=>v.key==='marker'?{...c,writtenArgumentRegisters:['x2']}:c)})),options).call,true,
    'two caller-supplied values still require disambiguation');
});

test('argument context stays bounded and duplicate or forged metadata cannot create semantics',()=> {
  const context={address:'1',name:'_ZN6EntityC1Eib',receiverRole:'this',accessRoles:['argument-written'],writtenArgumentRegisters:['x2']};
  const view={key:'k',className:'Entity',offset:8,size:1,functionContexts:[context]};
  const body=jevArgumentFlowRequest('Which value was supplied when the entity was made?',[view]);
  assert.match(body.questions.pick.criteria.c0,/entry-register write: x2; receiver ABI role: this/);
  const forbidden={...view,sourceFieldName:'SECRET_ORACLE_FIELD',oracle:{name:'SECRET_ORACLE_FIELD'},functionContexts:[
    {...context,sourceParameterName:'SECRET_ORACLE_FIELD',writtenArgumentRegisters:['x2','x255','SECRET_ORACLE_FIELD']}]};
  assert.equal(JSON.stringify(jevArgumentFlowRequest('question',[forbidden])).includes('SECRET_ORACLE_FIELD'),false);
  assert.equal(jevArgumentContextSignature(view),jevArgumentContextSignature({...view,offset:99,functionContexts:[context,context]}));
  assert.notEqual(jevArgumentContextSignature(view),jevArgumentContextSignature({...view,functionContexts:[{...context,writtenArgumentRegisters:['x1']}]}));
  const bitContext={...context,writtenArgumentRegisters:[],writtenArgumentBits:['x2:0','x2:0','x255:0','SECRET_ORACLE_FIELD']};
  const bitView={...view,functionContexts:[bitContext]};
  const bitBody=jevArgumentFlowRequest('Which value was supplied?',[bitView]);
  assert.match(bitBody.questions.pick.criteria.c0,/entry-argument bit write: x2\[0\]/);
  assert.equal(JSON.stringify(bitBody).includes('SECRET_ORACLE_FIELD'),false);
  assert.equal(jevArgumentContextSignature(bitView),jevArgumentContextSignature({...bitView,functionContexts:[bitContext,bitContext]}));
  assert.notEqual(jevArgumentContextSignature(bitView),jevArgumentContextSignature(view));
  const truncatedView={...bitView,functionContexts:[{...bitContext,writtenArgumentBitsTruncated:true}]};
  assert.match(jevArgumentFlowRequest('question',[truncatedView]).questions.pick.criteria.c0,/context truncated/);
  assert.notEqual(jevArgumentContextSignature(truncatedView),jevArgumentContextSignature(bitView));
  const visible=Array.from({length:8},(_,i)=>({address:String(i),name:'_ZN6Entity4readEv',accessRoles:['comparison-input']}));
  const extras=address=>({...view,functionContexts:[...visible,{address,name:'_ZN6Entity5otherEv',accessRoles:[]}]});
  assert.notEqual(jevArgumentContextSignature(extras('999')),jevArgumentContextSignature(extras('998')));
  assert.equal(jevVisibleArgumentContextSignature('question',extras('999')),
    jevVisibleArgumentContextSignature('question',extras('998')),
    'unshown provenance must not defeat the ambiguity veto');
  const unnamed=address=>({...view,functionContexts:[{address,name:null,accessRoles:['comparison-input']}]});
  assert.equal(jevVisibleArgumentContextSignature('question',unnamed('1')),
    jevVisibleArgumentContextSignature('question',unnamed('2')),
    'unnamed code addresses do not distinguish member meaning');
  assert.equal(jevVisibleArgumentContextSignature('question',view),jevVisibleArgumentContextSignature('question',
    {...view,offset:999,size:8,readCount:999,recoveredType:{category:'pointer'}}));
  const input={functionId:'f',receiverDigest:'r',snapshotId:'s',offsetBytes:8n,sizeBytes:1,writeCount:1,reason:'unclassified'};
  assert.deepEqual(createCppMemberEvidence({...input,writtenArgumentBits:['x1:0']}).writtenArgumentBits,['x1:0']);
  for(const bits of [['x1:8'],['x8:0'],['x1:64'],[{toString:()=> 'x1:0'}]])
    assert.throws(()=>createCppMemberEvidence({...input,writtenArgumentBits:bits}),/argument-bit-invalid/);
  assert.throws(()=>createCppMemberEvidence({functionId:'f',receiverDigest:'r',snapshotId:'s',offsetBytes:8n,sizeBytes:1,
    writeCount:1,reason:'unclassified',writtenArgumentRegisters:[{toString:()=> 'x2'}]}),/argument-register-invalid/);
});
