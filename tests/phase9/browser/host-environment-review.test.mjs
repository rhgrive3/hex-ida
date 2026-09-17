import test from 'node:test';
import assert from 'node:assert/strict';
import { machineIR } from '../memory/main-fixtures.mjs';
test('production semantic-IR compatibility does not require the Node diagnostic host in a browser',()=>{
  const host=globalThis.process;let ir;
  try {globalThis.process=undefined;assert.doesNotThrow(()=>{ir=machineIR(['udiv w0, w1, w2','ret']);});}
  finally {globalThis.process=host;}
  assert.ok(ir.instructions.some(i=>i.sub==='udiv'));
});
