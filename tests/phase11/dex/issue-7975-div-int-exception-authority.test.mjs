// Regression for #7975: Dalvik div-int/rem-int (all encodings: 23x, /2addr,
// /lit8) must carry their specified zero-divisor exceptional path —
// java/lang/ArithmeticException when the divisor is zero — instead of
// publishing exception-free exact semantics. The DEX opcodes are provably
// integral (float division uses separate opcodes), so the predicate can be
// represented losslessly via possibleExceptions (wasm #1134 vocabulary);
// no signed-overflow condition is imported from CIL/WASM semantics.
import assert from 'node:assert/strict';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running dex div-int/rem-int exception authority regression #7975...');

async function lift(words) {
  const { bytes } = buildDex({
    fields: [],
    methods: [{
      classType: 'LTest;', name: 'divzero', returnType: 'I', params: [],
      flags: 9, registers: 4, ins: 0, outs: 0, words,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'dex-divzero-audit' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === 'divzero');
  return frontend.decodeMethod(method, { image });
}

const ZERO_DIVIDE = { kind: 'integer-divide-by-zero', condition: 'rhs==0' };

// Issue's exact repro: const/4 v0,#1; const/4 v1,#0; div-int v2,v0,v1; return v2.
{
  const decoded = await lift([0x1012, 0x0112, 0x0293, 0x0100, 0x020f]);
  const div = decoded.bundles.find((b) => b.mnemonic === 'div-int');
  assert.ok(div, 'div-int bundle present');
  assert.equal(div.completeness, 'exact');
  assert.deepEqual(div.possibleExceptions, [ZERO_DIVIDE]);
  assert.equal(decoded.aggregateCompleteness, 'exact');
}

// rem-int carries the same zero-divisor authority.
{
  const decoded = await lift([0x1012, 0x0112, 0x0294, 0x0100, 0x020f]);
  const rem = decoded.bundles.find((b) => b.mnemonic === 'rem-int');
  assert.deepEqual(rem.possibleExceptions, [ZERO_DIVIDE]);
  assert.equal(rem.completeness, 'exact');
}

// /2addr encodings (div-int/2addr 0xb3, rem-int/2addr 0xb4) carry it too.
{
  const decoded = await lift([0x1012, 0x01b0, 0x020f]); // add-int/2addr control
  const add2 = decoded.bundles.find((b) => b.mnemonic === 'binop-2addr');
  assert.equal(add2.possibleExceptions.length, 0, 'add-int/2addr control stays exception-free');
}
{
  const decoded = await lift([0x1012, 0x01b3, 0x020f]); // div-int/2addr v1, v0
  const div = decoded.bundles.find((b) => b.mnemonic === 'binop-2addr');
  assert.deepEqual(div.possibleExceptions, [ZERO_DIVIDE]);
}
{
  const decoded = await lift([0x1012, 0x01b4, 0x020f]); // rem-int/2addr v1, v0
  const rem = decoded.bundles.find((b) => b.mnemonic === 'binop-2addr');
  assert.deepEqual(rem.possibleExceptions, [ZERO_DIVIDE]);
}

// /lit8 encodings (div-int/lit8 0xdb, rem-int/lit8 0xdc) carry it too.
{
  const decoded = await lift([0x1012, 0x01d8, 0x0201, 0x020f]); // add-int/lit8 v1, v0, #2 control
  const add = decoded.bundles.find((b) => b.mnemonic === 'binop-lit8');
  assert.equal(add.possibleExceptions.length, 0, 'add-int/lit8 control stays exception-free');
}
{
  const decoded = await lift([0x1012, 0x01db, 0x0201, 0x020f]); // div-int/lit8 v1, v0, #2
  const div = decoded.bundles.find((b) => b.mnemonic === 'binop-lit8');
  assert.deepEqual(div.possibleExceptions, [ZERO_DIVIDE]);
}
{
  const decoded = await lift([0x1012, 0x01dc, 0x0201, 0x020f]); // rem-int/lit8 v1, v0, #2
  const rem = decoded.bundles.find((b) => b.mnemonic === 'binop-lit8');
  assert.deepEqual(rem.possibleExceptions, [ZERO_DIVIDE]);
}

// The shared bridge preserves the exception authority on the Semantic IR node.
{
  const decoded = await lift([0x1012, 0x0112, 0x0293, 0x0100, 0x020f]);
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const divNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'div-int');
  assert.ok(divNode, 'div-int node present in lowered IR');
  assert.deepEqual(divNode.metadata.possibleExceptions, [ZERO_DIVIDE]);
  assert.equal(lowered.semanticIr.completeness, 'complete');
}

console.log('[phase11] dex div-int/rem-int exception authority regression #7975 passed');
