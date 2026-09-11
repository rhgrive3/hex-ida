import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';

function programFor(addresses) {
  return {
    unsupported:false,
    completeness:{ complete:true, reasons:[] },
    functionsReferencing() { return addresses.map((addr) => ({ addr })); },
    functionRange(addr) { return { start:addr, end:addr + 0x100n }; },
  };
}

{
  let reads = 0;
  const progress = [];
  const schemas = await recoverSchemas({
    architecture:'arm64',
    strings:[{ addr:0x2000n, text:'data.csv' }],
    program:programFor([0x1000n]),
    read:async () => { reads++; return new Uint8Array(0x100); },
    isCancelled:() => true,
    onProgress:(value) => progress.push(value),
  });
  assert.equal(reads, 0);
  assert.equal(schemas.complete, false);
  assert.ok(schemas.incompleteReason.includes('schema-recovery-cancelled'));
  assert.deepEqual(progress.at(-1), { phase:'schema', done:0, all:1 });
}

{
  const schemas = await recoverSchemas({
    architecture:'arm64',
    strings:[{ addr:0x2000n, text:'data.csv' }],
    program:programFor([0x1000n, 0x2000n]),
    read:async () => new Uint8Array(0x100),
    limit:1,
    isCancelled:() => true,
  });
  assert.equal(schemas.complete, false);
  assert.ok(schemas.incompleteReason.includes('schema-recovery-limit'));
  assert.ok(schemas.incompleteReason.includes('schema-recovery-cancelled'));
}

{
  const progress = [];
  const schemas = await recoverSchemas({
    architecture:'arm64',
    strings:[{ addr:0x2000n, text:'data.csv' }],
    program:programFor([0x1000n]),
    read:async () => new Uint8Array(0x100),
    isCancelled:() => false,
    onProgress:(value) => progress.push(value),
  });
  assert.equal(schemas.complete, true);
  assert.deepEqual(progress.at(-1), { phase:'schema', done:1, all:1 });
}

console.log('issue-3741 schema cancellation completeness: PASS');
