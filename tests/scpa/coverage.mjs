import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {discoverScpaTests} from './run.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const scope=JSON.parse(fs.readFileSync(new URL('./coverage-scope.json',import.meta.url),'utf8'));
if(scope.files.length!==32||new Set(scope.files).size!==32)throw Error('SCPA coverage denominator changed; review the scope manifest explicitly');
for(const file of scope.files)if(!file.startsWith('js/')||!file.endsWith('.js')||file.includes('..')||!fs.statSync(path.join(root,file)).isFile())throw Error('invalid coverage scope');
fs.mkdirSync(path.join(root,'.scpa-validation'),{recursive:true});
const report=path.join(root,'.scpa-validation','coverage.lcov');
const args=['--test','--test-concurrency=2','--experimental-test-coverage',
  '--test-reporter=spec','--test-reporter-destination=stdout','--test-reporter=lcov',`--test-reporter-destination=${report}`,
  ...scope.files.map(file=>`--test-coverage-include=${file}`),...discoverScpaTests()];
const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:180000,killSignal:'SIGKILL'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
const seen=new Set(fs.readFileSync(report,'utf8').split('\n').filter(line=>line.startsWith('SF:')).map(line=>line.slice(3).replaceAll('\\','/')));
const missing=scope.files.filter(file=>![...seen].some(source=>source===file||source.endsWith('/'+file)));
if(missing.length)throw Error(`Coverage omitted ${missing.length} declared files: ${missing.join(', ')}`);
console.log(`SCPA coverage scope: ${seen.size}/${scope.files.length} declared product modules; no claim of full branch/semantic qualification.`);
