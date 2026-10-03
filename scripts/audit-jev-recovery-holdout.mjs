#!/usr/bin/env node
// Evaluation-only authority: never imported by a product collector or client.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {sha256,persistentWrite} from './jev-realgame-final-contract.mjs';

const [evidenceDir,outputDir]=process.argv.slice(2);
if(!outputDir)throw new Error('usage: EVIDENCE OUTPUT');
const inputBytes=fs.readFileSync(path.join(evidenceDir,'fresh-holdout.json'));
const original=JSON.parse(inputBytes),freeze=JSON.parse(fs.readFileSync(path.join(evidenceDir,'fresh-holdout-freeze.json')));
assert.equal(sha256(inputBytes),freeze.holdoutSha256);
assert.equal(sha256(fs.readFileSync(path.join(evidenceDir,'fresh-holdout-authority.md'))),freeze.authoritySha256);
const report=new URL('../reports/investigations/jev-realgame-final/',import.meta.url);
const oldCases=JSON.parse(fs.readFileSync(new URL('../reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json',import.meta.url)));
const oldGold=JSON.parse(fs.readFileSync(new URL('structural-gold.json',report)));
const layouts={},authority={};
for(const game of ['openttd','openmw']) {
  const bytes=fs.readFileSync(path.join(evidenceDir,`fresh-parent-layout-${game}.json`));
  const prior=JSON.parse(fs.readFileSync(new URL(`layout-${game}.json`,report)));
  const parent=JSON.parse(bytes);layouts[game]={...prior.classes,...parent};
  const identity=original.cases.find(c=>c.binary===game&&c.status==='verified').identities[0];
  assert.equal(sha256(fs.readFileSync(identity.debugFile)),identity.debugFileSha256);
  const build=/Build ID:\s*([0-9a-f]+)/i.exec(execFileSync('readelf',['-n',identity.debugFile],{encoding:'utf8'}))?.[1];
  assert.equal(build,identity.buildId);assert.equal(build,prior.buildId);
  assert.equal(identity.binarySha256,prior.binarySha256);assert.equal(identity.debugFileSha256,prior.debugFileSha256);
  authority[game]={binarySha256:identity.binarySha256,buildId:build,debugSha256:identity.debugFileSha256,
    parentLayoutSha256:sha256(bytes),method:'Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID'};
  persistentWrite(path.join(outputDir,`fresh-layout-${game}.json`),{...authority[game],classes:parent});
}
const rows=original.cases.map(c=>{
  assert.ok(!oldCases.some(old=>old.query===c.query));
  if(c.status==='control')return {id:c.id,binary:c.binary,query:c.query,mode:c.mode,status:'control',identities:[],semanticLabel:c.semanticLabel};
  assert.equal(c.status,'verified');
  const identities=[];
  for(const g of c.identities) {
    assert.equal(g.binarySha256,authority[c.binary].binarySha256);
    const cls=layouts[c.binary][g.compilerClass];assert.equal(cls?.status,'resolved');
    assert.equal(cls.className,g.compilerClass);
    const matches=cls.members.filter(m=>m.path===g.field);assert.equal(matches.length,1);
    const m=matches[0];assert.equal(m.isAggregate,false);assert.equal(m.offset,g.offset);assert.equal(m.size,g.size);assert.equal(m.type,g.type);
    assert.ok(m.offset>=0&&m.size>0&&m.offset+m.size<=cls.size);
    const label={className:cls.className,offset:m.offset,size:m.size,type:m.type,binarySha256:g.binarySha256};
    identities.push(label);
    for(const alias of Object.values(layouts[c.binary])) {
      if(alias.status!=='resolved'||!alias.className)continue;
      for(const a of alias.members)if(a.path===m.path&&a.owningClassName===m.owningClassName
        &&a.owningOffset===m.owningOffset&&a.size===m.size&&a.type===m.type&&a.inheritance?.length)
        identities.push({...label,className:alias.className,offset:a.offset,declaringClass:a.owningClassName,
          declaringOffset:a.owningOffset,inheritance:a.inheritance});
    }
    // Exclude both verified physical overlap and any unresolved original label.
    assert.ok(!oldCases.filter(old=>old.binary===c.binary).some(old=>[old.gold,...(old.gold?.alternatives??[])].filter(Boolean)
      .some(old=>old.field===g.field&&old.class.split('::').at(-1)===g.compilerClass.split('::').at(-1))));
    assert.ok(!oldGold.cases.filter(old=>old.binary===c.binary).flatMap(old=>old.identities)
      .some(old=>identities.some(i=>old.className===i.className&&old.offset===i.offset&&old.size===i.size)));
  }
  const unique=[...new Map(identities.map(g=>[JSON.stringify([g.className,g.offset,g.size,g.type]),g])).values()];
  return {id:c.id,binary:c.binary,query:c.query,mode:c.mode,status:'verified',semanticLabel:c.goldLabel,
    identities:unique,selectionLabel:c.semanticLabel};
});
assert.equal(new Set(rows.map(c=>c.id)).size,rows.length);assert.equal(new Set(rows.map(c=>c.query)).size,rows.length);
persistentWrite(path.join(outputDir,'fresh-structural-cases.json'),rows);
persistentWrite(path.join(outputDir,'fresh-parent-authority.json'),{schema:'hex-jev-fresh-parent-audit/v1',
  independentlyFrozenInputSha256:freeze.holdoutSha256,normalizedCasesSha256:sha256(fs.readFileSync(path.join(outputDir,'fresh-structural-cases.json'))),
  authority,cases:rows.length,verified:rows.filter(c=>c.status==='verified').length,
  queryBodiesUnchanged:true,original70Overlap:false,oracleIsEvaluationOnly:true});
console.log(JSON.stringify({cases:rows.length,verified:rows.filter(c=>c.status==='verified').length,verifiedByIndependentParentDwarf:true}));
