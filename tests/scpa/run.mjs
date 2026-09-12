import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {discoverPhaseTests,runPhaseNodeTests} from '../support/phase-node-test-runner.mjs';
const DIRECTORY=path.dirname(fileURLToPath(import.meta.url));
export const discoverScpaTests=(root=DIRECTORY)=>discoverPhaseTests(root);
// Reuse the canonical recursive runner, with a bounded child lifetime.
export function runScpaTests(argv=process.argv.slice(2),{root=DIRECTORY,spawn=(exe,args,options)=>spawnSync(exe,args,{...options,timeout:180000,killSignal:'SIGKILL'})}={}) {
  return runPhaseNodeTests({phase:'scpa',root,argv,spawn,cwd:path.resolve(root,'../..'),parallel:true});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runScpaTests();
