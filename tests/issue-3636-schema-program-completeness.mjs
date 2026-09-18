import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';

const base = {
  architecture:'arm64',
  strings:[{ addr:0x1000n, text:'data.csv' }],
  read:async () => new Uint8Array(),
};

{
  const program = {
    unsupported:false,
    completeness:{ complete:false, reasons:['global-reference-budget'] },
    queryIncompleteReason:'global-reference-budget',
    functionsReferencing() { return []; },
  };
  const schemas = await recoverSchemas({ ...base, program });
  assert.equal(schemas.length, 0);
  assert.equal(schemas.complete, false);
  assert.equal(schemas.incompleteReason, 'global-reference-budget');
}
{
  const program = {
    unsupported:false,
    completeness:{ complete:true, reasons:[] },
    functionsReferencing() { return []; },
  };
  const schemas = await recoverSchemas({ ...base, program });
  assert.equal(schemas.complete, true);
  assert.equal(schemas.incompleteReason, null);
}
{
  const program = {
    unsupported:false,
    complete:false,
    incompleteReason:'legacy-partial',
    functionsReferencing() { return []; },
  };
  const schemas = await recoverSchemas({ ...base, program });
  assert.equal(schemas.complete, false, 'legacy compatibility field remains honored');
  assert.equal(schemas.incompleteReason, 'legacy-partial');
}
{
  const program = {
    unsupported:false,
    completeness:{ complete:true, reasons:[] },
    complete:false,
    functionsReferencing() { return []; },
  };
  const schemas = await recoverSchemas({ ...base, program });
  assert.equal(schemas.complete, true, 'canonical ProgramIndex completeness takes precedence over legacy shadow fields');
}

console.log('issue-3636 schema ProgramIndex completeness: PASS');
