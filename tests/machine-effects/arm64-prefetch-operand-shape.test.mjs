import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const prfop = (text = 'pldl1keep') => ({ k:'other', text });
const mem = (base) => ({
  k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset',
  disp:imm(0), addressDisp:imm(0), writebackDisp:null,
});

function lift(mnemonic, ops, extra = {}) {
  const instructionId = `arm64-prefetch-shape:${mnemonic}:${Math.random()}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    ops,
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
    ...extra,
  });
}

const validPrfm = lift('prfm', [prfop(), mem(x(1))]);
assert.equal(validPrfm.completeness, 'exact-with-intrinsic');
assert.equal(validPrfm.metadata.prefetch.prfop, 0);

const validPrfum = lift('prfum', [prfop(), mem(x(1))]);
assert.equal(validPrfum.completeness, 'exact-with-intrinsic');

const validLiteral = lift('prfm', [prfop(), imm(0x400004)], {
  address:0x400000n,
  pcRelTarget:0x400004n,
});
assert.equal(validLiteral.completeness, 'exact-with-intrinsic');
assert.equal(validLiteral.metadata.transfer, 'literal');

for (const malformed of [
  lift('prfm', [prfop(), mem(x(1)), x(2)]),
  lift('prfum', [prfop(), mem(x(1)), x(2)]),
  lift('prfm', [prfop(), imm(0x400004), x(2)], { address:0x400000n, pcRelTarget:0x400004n }),
  lift('prfm', [prfop(), mem(x(1)), imm(0x400004)]),
  lift('prfum', [prfop(), imm(0x400004)], { address:0x400000n, pcRelTarget:0x400004n }),
]) {
  assert.equal(malformed.completeness, 'partial');
  assert.match(malformed.unknownEffects.reason, /arm64-prf(?:m|um)-operand-shape-unencodable/);
  assert.equal(malformed.operations.length, 0, 'malformed prefetch input must not emit a prefetch intrinsic or register reads');
}

console.log('ARM64 prefetch operand-shape validation: PASS');
