import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8028: the frontends publish a definite-null fact (`producedValues[].isNull`)
// for CIL `ldnull` and JVM `aconst_null`, but the bridge silently dropped it:
// the exact null reference became an ordinary bitvector definition with no
// null/reference authority while the IR stayed `complete`, and the decompiler
// fabricated `ldnull(0)`.

async function runCil() {
  const { bytes } = buildCil({
    methods: [{
      name: 'NullRet',
      body: [0x14, 0x2a],                 // ldnull; ret
      signature: [0x00, 0x00, 0x1c],     // static () -> object
    }],
  });
  const frontend = new CilFrontend();
  const image = await frontend.open(bytes, { binaryId: 'cil-null-audit' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === 'NullRet');

  const decoded = await frontend.decodeMethod(method, { image });
  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldnull');
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'ldnull');
  const output = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));
  return {
    bundleIsNull: bundle.producedValues[0].isNull,
    valueMetadata: output.metadata ?? null,
    valueMachineType: output.machineType,
    irCompleteness: lowered.semanticIr.completeness,
    unknowns: lowered.semanticIr.unknowns,
    pseudocode: decompileManagedMethod(lowered).pseudocode,
  };
}

test('#8028 CIL ldnull preserves the null-reference authority through the bridge', async () => {
  const r = await runCil();
  assert.equal(r.bundleIsNull, true, 'fixture precondition: the frontend publishes isNull');
  assert.equal(r.valueMetadata?.isNull, true, 'the null fact must survive the bridge');
  assert.equal(r.irCompleteness, 'complete');
  assert.deepEqual(r.unknowns, []);
});

test('#8028 the decompiler renders the null reference instead of ldnull(0)', async () => {
  const r = await runCil();
  assert.ok(r.pseudocode.includes('null'), `pseudocode must render null: ${r.pseudocode}`);
  assert.ok(!r.pseudocode.includes('ldnull(0)'), `the fabricated unary call must be gone: ${r.pseudocode}`);
});
