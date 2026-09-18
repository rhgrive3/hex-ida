import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil, collect } from '../fixtures/medium-cil.mjs';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8007: a valid CIL `ldstr` (0x72) retained only its raw metadata token —
// the parser never exposed the #US heap literal and the bridge dropped the
// token, so two assemblies differing only in the literal collapsed to the
// same complete projection and decompiled as `ldstr(0)`.

function fixture(ch) {
  // #US heap:
  //   offset 0 = required null byte
  //   offset 1 = entry, compressed byte length 3
  //              UTF-16LE code unit + terminal byte
  // stream padded to 4-byte alignment.
  const us = Uint8Array.from([
    0,
    3, ch.charCodeAt(0), 0, 0,
    0, 0, 0,
  ]);

  return buildCil({
    methods: [{
      name: 'Run',
      body: [
        0x72, 0x01, 0x00, 0x00, 0x70, // ldstr 0x70000001
        0x26,                         // pop
        0x2a,                         // ret
      ],
    }],
    extraStreams: [{ name: '#US', bytes: us }],
  }).bytes;
}

async function run(ch) {
  const frontend = new CilFrontend();
  const image = await frontend.open(fixture(ch), { binaryId: 'same' });
  const methods = await collect(frontend.enumerateMethods(image));
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const decompiled = decompileManagedMethod(lowered);

  const bundle = decoded.bundles.find((b) => b.mnemonic === 'ldstr');
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'ldstr');
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));

  return {
    imageStrings: image.strings,
    bundleStringRef: bundle.producedValues[0].stringRef,
    bundleCompleteness: bundle.completeness,
    validationSemanticEffect: validation.completeness.semanticEffect,
    semanticCompleteness: lowered.semanticIr.completeness,
    unknowns: lowered.semanticIr.unknowns,
    valueMetadata: value.metadata ?? null,
    pseudocode: decompiled.pseudocode,
  };
}

test('#8007 a valid ldstr resolves its #US literal and preserves it through the bridge', async () => {
  const a = await run('A');
  const b = await run('B');

  assert.equal(a.bundleStringRef, 'A', 'fixture precondition: the frontend resolves the literal');
  assert.equal(b.bundleStringRef, 'B');

  assert.equal(a.valueMetadata?.stringRef, 'A', 'the literal must reach the canonical IR value');
  assert.equal(b.valueMetadata?.stringRef, 'B');

  // Distinct literals must not collapse to the same complete projection.
  assert.notDeepEqual(
    { ...a, pseudocode: undefined },
    { ...b, pseudocode: undefined },
  );

  assert.equal(a.semanticCompleteness, 'complete');
  assert.deepEqual(a.unknowns, []);
  assert.equal(a.validationSemanticEffect, 'complete');
});

test('#8007 the decompiler renders the ldstr literal instead of ldstr(0)', async () => {
  const a = await run('A');
  assert.ok(a.pseudocode.includes('"A"'), `pseudocode must contain the literal: ${a.pseudocode}`);
  assert.ok(!a.pseudocode.includes('ldstr(0)'), `the fabricated call must be gone: ${a.pseudocode}`);
});
