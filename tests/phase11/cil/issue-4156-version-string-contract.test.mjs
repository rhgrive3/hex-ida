import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil } from '../fixtures/medium-cil.mjs';
test('#4156: unterminated, malformed UTF-8 and noncanonical version lengths are rejected',()=>{
  for(const versionBytes of [Uint8Array.of(65,66,67,68),Uint8Array.of(0xc2,0x41,0,0),Uint8Array.of(65,0,0,0,0,0,0,0),new Uint8Array(260).fill(65)]) {
    assert.throws(()=>parseCil(buildCil({versionBytes}).bytes),/cil-unsupported-binary/);
  }
});
test('#4156: canonical UTF-8 version including multibyte characters is retained',()=>{
  const versionBytes=Uint8Array.of(0x76,0xc3,0xa9,0);
  assert.equal(parseCil(buildCil({versionBytes}).bytes).vmSpecEdition,'vé');
  assert.equal(parseCil(buildCil().bytes).vmSpecEdition,'v4.0.30319');
});
test('#4156: maximum legal terminated length and uninterpreted padding remain accepted',()=>{
  const versionBytes=new Uint8Array(256);versionBytes.fill(65,0,254);versionBytes[255]=0x80;
  assert.equal(parseCil(buildCil({versionBytes}).bytes).vmSpecEdition,'A'.repeat(254));
  assert.equal(parseCil(buildCil({versionBytes:Uint8Array.of(0,0,0,0)}).bytes).vmSpecEdition,'');
});
