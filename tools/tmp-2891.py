from pathlib import Path

for name in ['js/semantics/ssa/contract.js','js/semantics/ssa/validate.js']:
    p=Path(name)
    s=p.read_text()
    old="""function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}"""
    new="""function positiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}"""
    if old not in s:
        raise SystemExit(f'positiveInteger anchor drift: {name}')
    p.write_text(s.replace(old,new,1))

Path('tests/semantic-ssa-budget-strict.mjs').write_text(r'''import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../js/semantics/ssa/contract.js';
import { validateSemanticSsa } from '../js/semantics/ssa/validate.js';

const base={contractVersion:'2.0.0',functionId:'f',definitions:[],uses:[]};
const malformed=['1',['1'],true,{valueOf(){return 1;}}];
for (const key of ['maxDefinitions','maxUses','maxLinks']) {
  for (const value of malformed) {
    assert.throws(() => createSemanticSsaContract(base,{budget:{[key]:value}}), new RegExp(`semantic-ssa-invalid-budget-${key}`));
  }
  assert.doesNotThrow(() => createSemanticSsaContract(base,{budget:{[key]:1}}));
}
for (const value of malformed) {
  assert.throws(() => validateSemanticSsa({}, {}, {}, {budget:{maxWorkItems:value}}), /semantic-ssa-invalid-budget-maxWorkItems/);
}
for (const value of [0,-1,1.5,NaN,Infinity]) {
  assert.throws(() => createSemanticSsaContract(base,{budget:{maxDefinitions:value}}), /semantic-ssa-invalid-budget-maxDefinitions/);
}
console.log('semantic-ssa-budget-strict: PASS');
''')
