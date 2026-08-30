import assert from 'node:assert/strict';
import { arm64RegisterOperand } from '../../js/targets/architecture/arm64/effects/addressing.js';

for (const input of [
  { k:'reg', cls:'gp', num:'0', bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:0, bits:'64', text:'x0' },
  { k:'reg', cls:'gp', num:false, bits:64, text:'x0' },
  { k:'reg', cls:'vec', num:'31', bits:128, text:'q31' },
]) {
  assert.equal(arm64RegisterOperand(input), null, `structured canonical register scalars must not be coerced: ${JSON.stringify(input)}`);
}

for (const input of [
  { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:30, bits:64, text:'lr' },
  { k:'reg', cls:'sp', num:31, bits:64, text:'sp' },
  { k:'reg', cls:'zr', num:31, bits:64, text:'xzr' },
  { k:'reg', cls:'vec', num:31, bits:128, text:'q31' },
]) {
  assert.ok(arm64RegisterOperand(input), `valid numeric structured register must remain accepted: ${JSON.stringify(input)}`);
}

console.log('arm64 structured register strict scalar regression PASS');
