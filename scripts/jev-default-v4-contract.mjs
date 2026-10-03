// Evaluation authority only; never imported by production or representation.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from './jev-realgame-final-contract.mjs';

export const V4_ARMS=['A0','A','R1','O4','current','B','C','V4','S4'];
export const V4_REPORT=fileURLToPath(new URL('../reports/investigations/jev-realgame-final/default-v4/',import.meta.url));
export const V4_ROOT=fileURLToPath(new URL('../',import.meta.url));

export function assertV4Execution(snapshotDir,freezeFile) {
  const policyBytes=fs.readFileSync(path.join(V4_REPORT,'policy-freeze.json'));
  const policy=JSON.parse(policyBytes),freeze=JSON.parse(fs.readFileSync(freezeFile));
  if(policy.schema!=='hex-jev-default-quality-policy/v4'||policy.freezeBeforeFinalQueriesRead!==true
    ||freeze.policySha256!==sha256(policyBytes)
    ||policy.holdoutSha256!==sha256(fs.readFileSync(path.join(V4_REPORT,'holdout.json')))
    ||freeze.structuralCasesSha256!==sha256(fs.readFileSync(path.join(V4_REPORT,'structural-cases.json'))))
    throw new Error('V4 policy/gold binding failure');
  for(const [file,hash] of Object.entries({...policy.sourceHashes,...freeze.sourceHashes}))
    if(sha256(fs.readFileSync(path.join(V4_ROOT,file)))!==hash)throw new Error(`V4 execution source drift: ${file}`);
  const receipt=JSON.parse(fs.readFileSync(path.join(snapshotDir,'collection-receipt.json')));
  if(receipt.complete!==true||receipt.conclusion!=='success'||receipt.files?.length!==2)
    throw new Error('V4 complete successful actual artifact receipt required');
  const snapshots=['openttd','openmw'].map(game=>{
    const file=game+'.json',bytes=fs.readFileSync(path.join(snapshotDir,file)),s=JSON.parse(bytes);
    const item=receipt.files.find(item=>item.file===file);
    if(!item||item.sha256!==sha256(bytes)||item.productSha!==s.productSha
      ||!Number.isSafeInteger(item.run)||item.run<1||!Number.isSafeInteger(item.artifactId)||item.artifactId<1)
      throw new Error('V4 actual artifact identity mismatch');
    const manifestBytes=fs.readFileSync(path.join(V4_REPORT,`queries-${game}.json`));
    const manifest=JSON.parse(manifestBytes);
    if(s.schema!=='hex-jev-default-candidate-snapshot/v4'||s.complete!==true||s.developmentOnly!==false
      ||s.authorizesDefaultActivation!==false||s.binaryKey!==game||s.rows.length!==25
      ||s.collection.keyCollisions!==0||s.policySha256!==sha256(policyBytes)
      ||s.queriesSha256!==sha256(manifestBytes)||policy.queryManifests[game]!==sha256(manifestBytes)
      ||s.binarySha256!==manifest.binarySha256||s.rows.some((row,i)=>row.id!==manifest.cases[i].id||row.query!==manifest.cases[i].query))
      throw new Error('V4 complete query/order/binary binding failure');
    for(const [file,hash] of Object.entries(s.sourceHashes))
      if(sha256(fs.readFileSync(path.join(V4_ROOT,file)))!==hash
        ||sha256(execFileSync('git',['show',`${s.productSha}:${file}`],{cwd:V4_ROOT,maxBuffer:32*1024*1024}))!==hash)
        throw new Error(`V4 measured source revision drift: ${file}`);
    return s;
  });
  if(new Set(snapshots.map(s=>s.productSha)).size!==1)throw new Error('V4 mixed source revisions');
  const cases=JSON.parse(fs.readFileSync(path.join(V4_REPORT,'structural-cases.json')));
  if(cases.length!==50||new Set(cases.map(g=>g.id)).size!==50
    ||cases.filter(g=>g.status==='verified').length!==40||cases.filter(g=>g.status==='control').length!==10)
    throw new Error('V4 full independent denominator required');
  return {policy,snapshots,cases};
}
