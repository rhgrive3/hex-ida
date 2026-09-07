import assert from 'node:assert/strict';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

console.log('[phase11] running cil pipeline tests...');

const cilBytes = buildMinimalCil();
const frontend = new CilFrontend();
const image = await frontend.open(cilBytes);

const methods = [];
for await (const m of frontend.enumerateMethods(image)) {
  methods.push(m);
}
assert.equal(methods.length, 1);

const decoded = await frontend.decodeMethod(methods[0], { image });
// This minimal PE/CLI fixture omits #Blob method-signature authority. Its
// bytecode returns one int32 local; state that contract explicitly for the
// positive pipeline rather than certifying an unknown return shape as valid.
const unknownReturn = await frontend.validateMethod(decoded);
assert.equal(unknownReturn.status, 'partial');
assert.ok(unknownReturn.warnings.some((warning) => warning.code === 'cil-return-stack-shape-unavailable'));

const wrongReturn = await frontend.validateMethod(decoded, { returnStackSlots: 0 });
assert.equal(wrongReturn.status, 'invalid');
assert.ok(wrongReturn.errors.some((error) => error.code === 'cil-return-stack-shape-invalid'));

const val = await frontend.validateMethod(decoded, { returnStackSlots: 1 });
assert.equal(val.status, 'valid');

const lifted = await frontend.liftMethod(decoded, val);
const bridged = lowerVMEffectsToSemanticIr(lifted);

assert.ok(bridged.semanticIr);
assert.ok(bridged.cfg);
assert.ok(bridged.ssa);
assert.ok(bridged.cfg.blocks.length >= 1);

console.log('  ok cil pipeline tests passed');
