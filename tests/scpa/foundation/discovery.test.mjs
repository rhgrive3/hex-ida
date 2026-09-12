import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {discoverScpaTests,runScpaTests} from '../run.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('canonical SCPA discovery includes this nested sentinel and every direct suite',()=>{
  const files=discoverScpaTests();assert.ok(files.includes(fileURLToPath(import.meta.url)));
  for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.test.mjs')))assert.ok(files.includes(path.join(root,name)));
  const scripts=JSON.parse(fs.readFileSync(path.join(root,'../../package.json'),'utf8')).scripts;
  assert.equal(scripts['scpa:test'],'node tests/scpa/run.mjs');assert.match(scripts['core:test'],/npm run scpa:test/);
});
test('an actual failing nested test propagates through the canonical runner',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'scpa-discovery-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  fs.mkdirSync(path.join(temp,'nested','deeper'),{recursive:true});
  fs.writeFileSync(path.join(temp,'nested','deeper','sentinel.test.mjs'),"import test from 'node:test'; test('sentinel',()=>{throw Error('EXPECTED-SCPA-SENTINEL');});\n");
  let output='';
  assert.throws(()=>runScpaTests([],{root:temp,spawn:(exe,args,options)=>{
    const env={...options.env};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(exe,args,{...options,env,cwd:temp,timeout:10000});output=child.stdout+child.stderr;return child;
  }}),/runner failed/);
  assert.match(output,/EXPECTED-SCPA-SENTINEL/);
});
