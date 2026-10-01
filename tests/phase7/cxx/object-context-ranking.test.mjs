import test from 'node:test';
import assert from 'node:assert/strict';
import { cxxSemanticScores, cxxObjectSemanticScores, compareCxxSemanticScores } from '../../../js/analysis/query/cxx-semantic-preference.js';
import { jevSemanticRoute, jevArgumentFlowRequest, jevArgumentContextSignature } from '../../../js/analysis/query/jev-advisory.js';
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
  const input={functionId:'f',receiverDigest:'r',snapshotId:'s',offsetBytes:8n,sizeBytes:1,writeCount:1,reason:'unclassified'};
  assert.deepEqual(createCppMemberEvidence({...input,writtenArgumentBits:['x1:0']}).writtenArgumentBits,['x1:0']);
  for(const bits of [['x1:8'],['x8:0'],['x1:64'],[{toString:()=> 'x1:0'}]])
    assert.throws(()=>createCppMemberEvidence({...input,writtenArgumentBits:bits}),/argument-bit-invalid/);
  assert.throws(()=>createCppMemberEvidence({functionId:'f',receiverDigest:'r',snapshotId:'s',offsetBytes:8n,sizeBytes:1,
    writeCount:1,reason:'unclassified',writtenArgumentRegisters:[{toString:()=> 'x2'}]}),/argument-register-invalid/);
});
