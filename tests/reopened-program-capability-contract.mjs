import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Backend } from '../js/backend.js';
import { ProgramIndex } from '../js/program.js';
import { findGlobals } from '../js/linkage.js';

// Architecture, never the Mach-O container, chooses the relation producer.
const backend=new Backend();
backend.formatId='macho';
const routes=[];
backend._callTo=(worker,t,payload)=>{routes.push([worker,t,payload]);return Promise.resolve({});};
await backend.scanProgram('text',null,{architecture:'x86_64'});assert.equal(routes.at(-1)[0],'platform');
await backend.scanProgram('text',null,{architecture:'riscv64'});assert.equal(routes.at(-1)[0],'platform');
await backend.scanProgram('text',null,{architecture:'arm64'});assert.equal(routes.at(-1)[0],'legacy');
await backend.scanProgram('text',null,{architecture:'arm64e'});assert.equal(routes.at(-1)[0],'legacy');
backend.dispose();

const dataRegion={id:'data',name:'__data',section:'__data',exec:false,read:true,write:true,vmAddr:0x2000n,size:0x100n};
const symbols={
  symbolCount:1,
  symbolList(){return [{addr:0x2000n,name:'global_value'}];},
  functionCount:0,
};

// Unsupported relation producer: named global survives, refs are unknown, not 0.
const unsupported=new ProgramIndex({unsupported:true,architecture:'x86_64',completeness:{complete:false,reasons:['unsupported-program-analysis']},refFrom:new BigUint64Array(),refTo:new BigUint64Array(),refKind:new Uint8Array()},symbols,null);
const unknown=findGlobals(symbols,unsupported,[dataRegion],{limit:20});
assert.equal(unknown.length,1);assert.equal(unknown[0].refs,null);assert.equal(unknown[0].relationSupported,false);assert.equal(unknown.relationComplete,false);

// Supported exact empty: zero is a valid absence proof.
const complete=new ProgramIndex({unsupported:false,architecture:'arm64',completeness:{complete:true,reasons:[]},refFrom:new BigUint64Array(),refTo:new BigUint64Array(),refKind:new Uint8Array()},symbols,null);
const exact=findGlobals(symbols,complete,[dataRegion],{limit:20});
assert.equal(exact[0].refs,0);assert.equal(exact[0].refsComplete,true);assert.equal(exact.relationComplete,true);

// Partial with one observed reference is a lower bound, never exact.
const partial=new ProgramIndex({unsupported:false,architecture:'arm64',completeness:{complete:false,reasons:['global-reference-budget']},refFrom:new BigUint64Array([0x1000n]),refTo:new BigUint64Array([0x2000n]),refKind:new Uint8Array([1])},symbols,null);
const lower=findGlobals(symbols,partial,[dataRegion],{limit:20,minRefs:1});
assert.equal(lower[0].refs,1);assert.equal(lower[0].refsComplete,false);assert.equal(lower.relationComplete,false);

const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const product=fs.readFileSync(new URL('../js/ui/product.js',import.meta.url),'utf8');
assert.match(app,/architecture:this\.store\.get\('architecture'\)/);
assert.match(product,/reference coverage unknown/);
console.log('reopened program capability contract: ok');
