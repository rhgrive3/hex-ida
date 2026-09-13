import assert from 'node:assert/strict';

import { WasmFrontend } from '../js/managed/wasm/frontend.js';
import { analyzeManagedInterprocedural, lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { createManagedMethodId } from '../js/managed/shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';
import { liftDexMethod } from '../js/managed/dex/lifter.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { parseCil } from '../js/managed/cil/parser.js';
import { dexMethod } from './phase11/fixtures/medium-dex.mjs';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

console.log('[issue-4825] managed direct-call target canonical methodId resolution...');

const leb = (value) => {
  const bytes = [];
  let n = value;
  do { const b = n & 0x7f; n >>>= 7; bytes.push(n ? b | 0x80 : b); } while (n);
  return bytes;
};
const section = (id, payload) => [id, ...leb(payload.length), ...payload];
const encodedName = (text) => { const bytes = [...new TextEncoder().encode(text)]; return [bytes.length, ...bytes]; };

// One `()->()` type, raw instruction bodies, optional `(import ... (func))` entries.
function wasmModule({ bodies, imports = [] }) {
  const typeSection = section(0x01, [1, 0x60, 0x00, 0x00]);
  const importSection = imports.length
    ? section(0x02, [imports.length, ...imports.flatMap((i) => [...encodedName(i.module), ...encodedName(i.field), 0x00, 0x00])])
    : [];
  const funcSection = section(0x03, [bodies.length, ...bodies.map(() => 0x00)]);
  const codeSection = section(0x0a, [bodies.length, ...bodies.flatMap((body) => {
    const code = [0x00, ...body, 0x0b];
    return [...leb(code.length), ...code];
  })]);
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSection, ...importSection, ...funcSection, ...codeSection]);
}

async function decodeAll(bytes, binaryId) {
  const frontend = new WasmFrontend();
  const image = await frontend.open(bytes, { binaryId });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = [];
  for (const method of methods) decoded.push(await frontend.decodeMethod(method, { image }));
  return { image, methods, decoded };
}

const callNodeOf = (fn) => lowerVMEffectsToSemanticIr(fn).semanticIr.nodes.find((node) => node.kind === 'call');

// 1. Wasm mutual recursion must condense into one SCC instead of losing both edges.
{
  // (func $a call 1) (func $b call 0)
  const mod = await decodeAll(wasmModule({ bodies: [[0x10, 0x01], [0x10, 0x00]] }), 'issue-4825-mutual');
  const aId = createManagedMethodId(mod.image.moduleId, 0);
  const bId = createManagedMethodId(mod.image.moduleId, 1);
  const analysis = analyzeManagedInterprocedural(mod.decoded);

  assert.deepEqual([...analysis.summaries.get(aId).directCalls.map((c) => c.target)], [bId],
    '#4825 the wasm internal direct call must resolve to the canonical callee methodId');
  assert.deepEqual([...analysis.summaries.get(bId).directCalls.map((c) => c.target)], [aId],
    '#4825 the reciprocal wasm call must resolve to the canonical callee methodId');
  assert.equal(analysis.components.length, 1,
    '#4825 mutually recursive wasm functions must condense into a single SCC');
  assert.deepEqual([...analysis.components[0]].sort(), [aId, bId].sort());
  assert.deepEqual([...analysis.summaries.get(aId).summary.directCalls[0].targetEntityIds], [bId],
    '#4825 the canonical FunctionSummary must share the callee identity namespace');
  assert.equal(callNodeOf(mod.decoded[0]).metadata.callTargetDisplay, 'func_1',
    '#4825 the human-readable wasm call target stays display metadata');
}

// 2. Wasm self-recursion must be a self edge on the canonical methodId.
{
  // (func $self call 0)
  const mod = await decodeAll(wasmModule({ bodies: [[0x10, 0x00]] }), 'issue-4825-self');
  const selfId = createManagedMethodId(mod.image.moduleId, 0);
  const analysis = analyzeManagedInterprocedural(mod.decoded);

  assert.deepEqual([...analysis.summaries.get(selfId).directCalls.map((c) => c.target)], [selfId],
    '#4825 a wasm self call must resolve to the function\'s own canonical methodId');
  assert.deepEqual([...analysis.components], [[selfId]]);
}

// 3. A call to an imported function must not be promoted to an internal methodId.
{
  // (import "env" "clock" (func)) (func call 0)
  const mod = await decodeAll(wasmModule({
    imports: [{ module: 'env', field: 'clock' }],
    bodies: [[0x10, 0x00]],
  }), 'issue-4825-import');
  const callerId = createManagedMethodId(mod.image.moduleId, 1);
  const analysis = analyzeManagedInterprocedural(mod.decoded);
  const entry = analysis.summaries.get(callerId);

  assert.deepEqual([...entry.directCalls.map((c) => c.target)], ['func_0'],
    '#4825 an import call keeps its display target instead of an invented internal identity');
  assert.equal(entry.directCalls.every((c) => !String(c.target).startsWith('managed-method:')), true,
    '#4825 an import target must never be promoted into the internal managed-method namespace');
  assert.equal(analysis.components.length, 2,
    '#4825 an import call must not form an internal call-graph edge');
}

// 4. DEX internal invoke must resolve to the canonical callee methodId.
{
  const image = dexMethod([0x1070, 0x0000, 0x0000, 0x000e], {
    methods: [
      { name: 'callee', classType: 'LTest;', proto: { params: [], returnType: 'V' } },
      { name: 'caller', classType: 'LTest;', proto: { params: [], returnType: 'V' } },
    ],
    classes: [{
      classType: 'LTest;',
      staticFields: [],
      instanceFields: [],
      directMethods: [{ methodIdx: 0, codeOff: 4, accessFlags: 9 }, { methodIdx: 1, codeOff: 4, accessFlags: 9 }],
      virtualMethods: [],
    }],
  });
  const calleeId = createManagedMethodId(image.moduleId, 0, 'callee');
  const callerId = createManagedMethodId(image.moduleId, 1, 'caller');
  const analysis = analyzeManagedInterprocedural([liftDexMethod(0, image), liftDexMethod(1, image)]);

  assert.deepEqual([...analysis.summaries.get(callerId).directCalls.map((c) => c.target)], [calleeId],
    '#4825 the DEX internal invoke must resolve to the canonical callee methodId');
  assert.equal(analysis.summaries.has(analysis.summaries.get(callerId).directCalls[0].target), true,
    '#4825 the DEX edge target must key into the canonical method map');
  assert.deepEqual([...analysis.summaries.get(calleeId).directCalls.map((c) => c.target)], [calleeId],
    '#4825 the DEX self invoke must resolve to the callee\'s own canonical methodId');
  assert.equal(analysis.components.length, 2);
  const callNode = callNodeOf(liftDexMethod(1, image));
  assert.deepEqual([...callNode.call.targetEntityIds], [calleeId]);
  assert.equal(callNode.metadata.callTargetDisplay, 'LTest;->callee',
    '#4825 the DEX display target must stay separate from identity');
}

// 5. CIL internal direct call must resolve to the canonical callee methodId.
{
  const tokenBytes = (t) => [t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff];
  const built = buildCil({
    methods: [
      { name: 'Callee', owner: 0, body: [0x2a] },
      { name: 'Caller', owner: 0, body: [0x28, ...tokenBytes(0x06000001), 0x2a] },
      { name: 'Foreign', owner: 0, body: [0x28, ...tokenBytes(0x0a000001), 0x2a] },
    ],
  });
  const image = parseCil(built.bytes ?? built);
  const calleeId = createManagedMethodId(image.moduleId, '0x06000001');
  const callerId = createManagedMethodId(image.moduleId, '0x06000002');
  const analysis = analyzeManagedInterprocedural(
    [0, 1, 2].map((bodyIndex) => liftCilMethod(bodyIndex, image)),
  );

  assert.deepEqual([...analysis.summaries.get(callerId).directCalls.map((c) => c.target)], [calleeId],
    '#4825 the CIL internal direct call must resolve to the canonical callee methodId');
  const foreign = analysis.summaries.get(createManagedMethodId(image.moduleId, '0x06000003'));
  assert.equal(foreign.directCalls.length, 0,
    '#4825 a MemberRef token must not be reported as a resolved internal direct call');
  assert.equal(foreign.dynamicCalls.every((c) => c.targets.every((t) => !String(t).startsWith('managed-method:'))), true,
    '#4825 an unresolved CIL token must not be promoted into the internal identity namespace');
  assert.equal(callNodeOf(liftCilMethod(1, image)).metadata.callTargetDisplay, '0x06000001',
    '#4825 the CIL token text stays display metadata');
}

// 6. A resolved identity is not re-classified by display-text substring rules.
{
  const methodId = 'managed-method:managed-image:bin:native-like:1';
  const calleeMethodId = 'managed-method:managed-image:bin:native-like:0';
  const bundle = createVMEffectBundle({
    frontendId: 'dex',
    methodId,
    operationId: `vm-op:${methodId}:0x0:0`,
    bytecodeOffset: 0,
    mnemonic: 'invoke-direct',
    callEffects: [{
      target: 'callee_native_helper',
      targetMethodId: calleeMethodId,
      dispatchKind: 'direct',
    }],
    controlEffects: [{ kind: 'return' }],
    completeness: 'exact',
  });
  const result = analyzeManagedInterprocedural([
    createVMEffectFunction({ frontendId: 'dex', methodId, bundles: [bundle] }),
  ]).summaries.get(methodId);

  assert.deepEqual([...result.directCalls.map((c) => c.target)], [calleeMethodId],
    '#4825 a resolved internal identity must not be re-classified by display-text substrings');
  assert.equal(result.externalCalls.length, 0,
    '#4825 the identity namespace, not a name substring, decides internal vs external');
}

console.log('  ok issue-4825 managed direct-call canonical target tests passed');
