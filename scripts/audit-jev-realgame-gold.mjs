#!/usr/bin/env node
// Evaluation authority only. Never imported by the production collector/client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyCases, sha256, persistentWrite, CASE_HASH } from './jev-realgame-final-contract.mjs';

function resolveClass(layout,label) {
  const exact=layout.classes[label.class];
  if(exact?.status==='resolved')return exact;
  const alias=layout.qualifiedAliases?.[label.class];
  return alias?.verified===true ? layout.classes[alias.className] : null;
}
export function resolveStructuralGold(layout,label,binarySha256) {
  const cls=resolveClass(layout,label);
  if(cls?.status!=='resolved')return {status:'unverified',label,reason:'Class layout unresolved in exact-build DWARF'};
  const members=cls.members.filter(m=>m.path===label.field);
  if(members.length!==1)return {status:'unverified',label,reason:members.length?'Ambiguous layout member':'Named member absent from exact-build DWARF; no source/RTTI guess'};
  const m=members[0];
  if(!Number.isSafeInteger(m.offset)||m.offset<0||!Number.isSafeInteger(m.size)||m.size<=0)return {status:'unverified',label,reason:'Invalid structural extent'};
  const className=cls.className ?? /(?:class|struct)\s+([^\s:{]+(?:::[^\s:{]+)*)/.exec(cls.declaration)?.[1] ?? label.class;
  return {status:'verified',label,identity:{binarySha256,className,offset:m.offset,size:m.size,type:m.type},
    authority:{buildId:layout.buildId,debugSha256:layout.debugFileSha256,layoutDeclaration:cls.declaration}};
}

function buildId(file) {
  return /Build ID:\s*([0-9a-f]+)/i.exec(execFileSync('readelf',['-n',file],{encoding:'utf8',stdio:['ignore','pipe','ignore']}))?.[1]??null;
}
async function main() {
  const [layoutDir,outputFile]=process.argv.slice(2);
  if(!layoutDir||!outputFile)throw new Error('usage: LAYOUT_DIR OUTPUT_FILE');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const study=path.join(root,'reports/investigations/jev-real-game-freeform-holdout');
  const cases=verifyCases(fs.readFileSync(path.join(study,'holdout-cases.json')));
  const frozen=JSON.parse(fs.readFileSync(path.join(study,'holdout-manifest.json')));
  const semanticAudit=JSON.parse(fs.readFileSync(path.join(layoutDir,'oracle-authority.json')));
  const layouts={};const authority={};
  for(const key of ['openttd','openmw']) {
    const bytes=fs.readFileSync(path.join(layoutDir,`layout-${key}.json`));const l=JSON.parse(bytes);const b=frozen.binaries[key];
    if(sha256(fs.readFileSync(b.localPath))!==b.sha256 || l.binarySha256!==b.sha256
      || sha256(fs.readFileSync(l.debugFile))!==l.debugFileSha256
      || buildId(b.localPath)!==l.buildId||buildId(l.debugFile)!==l.buildId)throw new Error('exact oracle binding failure');
    layouts[key]=l;authority[key]={binarySha256:b.sha256,buildId:l.buildId,debugSha256:l.debugFileSha256,layoutSha256:sha256(bytes),
      packageVersion:b.version,method:'Matching GNU build-ID exact Ubuntu debug package; independently extracted DWARF ptype /o'};
  }
  const rows=cases.map(c=>{
    if(!c.gold)return {id:c.id,binary:c.binary,status:'control',reason:c.abstainReason,identities:[]};
    const primary=resolveStructuralGold(layouts[c.binary],c.gold,frozen.binaries[c.binary].sha256);
    const alternatives=(c.gold.alternatives??[]).map(label=>resolveStructuralGold(layouts[c.binary],label,frozen.binaries[c.binary].sha256));
    // An existing spell-container subobject does not prove an energy-pool gold.
    // Record this explicit frozen-gold audit finding; never substitute another
    // answer or alter the query to make the result pass.
    for(const alternative of alternatives)for(const rejection of semanticAudit.rejectedSemanticAlternatives??[]) {
      if(alternative.label.class===rejection.className&&alternative.label.field===rejection.fieldName) {
        alternative.status='unverified';alternative.reason=rejection.reason;
      }
    }
    const accepted=[primary,...alternatives].filter(g=>g.status==='verified');
    const identities=accepted.flatMap(g=>{
      const own=resolveClass(layouts[c.binary],g.label).members.find(m=>m.path===g.label.field);
      const expanded=[g.identity];
      // Match the same inherited member only when exact-build compiler metadata
      // proves the declaring owner, base adjustment, width and declared type.
      // No production receiver ownership is rewritten by this scoring mapping.
      for(const cls of Object.values(layouts[c.binary].classes)) {
        if(cls.status!=='resolved'||!cls.className)continue;
        for(const member of cls.members)if(member.path===g.label.field&&member.owningClassName===own.owningClassName
          &&member.owningOffset===own.owningOffset&&member.size===own.size&&member.type===own.type
          &&member.inheritance?.length)expanded.push({...g.identity,className:cls.className,offset:member.offset,
            declaringClass:member.owningClassName,declaringOffset:member.owningOffset,inheritance:member.inheritance});
      }
      return expanded;
    });
    const annotated=/offset\s+(\d+)/.exec(c.groundTruthSource??'');
    return {id:c.id,binary:c.binary,semanticLabel:`${c.gold.class}.${c.gold.field}`,
      status:accepted.length?'verified':'unverified',identities,
      primaryAudit:primary,alternativesAudit:alternatives,
      originalAnnotation:c.groundTruthSource,annotationOffsetMismatch:annotated&&primary.identity?Number(annotated[1])!==primary.identity.offset:null,
      reason:accepted.length?'Exact-build structural identity; semantic label preserved for reporting only':'No acceptable frozen gold identity proven; excluded from answerable denominator'};
  });
  const old=frozen.binaries.openttd.dwarfOracle;
  const oldBuildId=buildId(old.localPath);
  const report={schema:'hex-jev-realgame-structural-gold/v1',caseSha256:CASE_HASH,authority,
    semanticAuditSha256:sha256(fs.readFileSync(path.join(layoutDir,'oracle-authority.json'))),
    rejectedOldOracle:{sha256:old.sha256,buildId:oldBuildId,matchingBuildId:authority.openttd.buildId,
      reason:'Existing unstripped OpenTTD oracle has a different GNU build-ID and source revision; its offsets cannot score the frozen Ubuntu13.4 binary'},
    cases:rows};
  persistentWrite(outputFile,report);
  console.log(JSON.stringify({verified:rows.filter(c=>c.status==='verified').length,unverified:rows.filter(c=>c.status==='unverified').length,
    controls:rows.filter(c=>c.status==='control').length,oldOracleRejected:oldBuildId!==authority.openttd.buildId}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
