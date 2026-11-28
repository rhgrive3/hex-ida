import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgramIndex } from '../js/program.js';
import { rankCandidates } from '../js/rank.js';

function makeRealProgram(refs, funcStarts) {
  const refFrom = BigUint64Array.from(refs.map((r) => r.from));
  const refTo = BigUint64Array.from(refs.map((r) => r.to));
  const refKind = Uint8Array.from(refs.map((r) => r.kind ?? 1));
  const symbols = {
    functionStarts: BigUint64Array.from(funcStarts),
    functionCount: funcStarts.length,
    nameAt: () => null,
    functionAt: (addr) => {
      let best = null;
      for (const s of funcStarts) {
        if (s <= addr) best = s;
      }
      return best != null ? { start: best, name: null } : null;
    },
    functionsInRange: () => [],
  };
  return {
    program: new ProgramIndex({
      callFrom: new BigUint64Array(0),
      callTo: new BigUint64Array(0),
      refFrom,
      refTo,
      refKind,
      callsCapped: false,
      refsCapped: false,
      statsComplete: true,
    }, symbols, null),
    symbols,
  };
}

test('rankCandidates passes BigInt span for cryptoConstants without BigInt/Number TypeError', () => {
  const { program, symbols } = makeRealProgram(
    [{ from: 0x100010n, to: 0x200004n, kind: 1 }],
    [0x100000n]
  );

  // Verify ProgramIndex.functionsReferencing handles both BigInt and safe-integer Number span
  const byBigInt = program.functionsReferencing(0x200000n, 16n);
  const byNumber = program.functionsReferencing(0x200000n, 16);
  assert.equal(byBigInt.length, 1);
  assert.equal(byBigInt[0].addr, 0x100000n);
  assert.equal(byNumber.length, 1);
  assert.equal(byNumber[0].addr, 0x100000n);

  // Verify rankCandidates with cryptoConstants on a real ProgramIndex does not throw
  const res = rankCandidates({
    goal: { id: 'crypto', text: 'crypto', expects: { crypto: true } },
    strings: [],
    program,
    symbols,
    cryptoConstants: [{ id: 'aes_sbox', name: 'AES S-box', address: 0x200000n, length: 256 }],
  });
  const cands = res?.candidates || res || [];
  assert.equal(cands.length, 1);
  assert.equal(cands[0].addr, 0x100000n);
});
