import test from 'node:test';
import assert from 'node:assert/strict';
import { captured, caller, callee, scope, request } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { assertScopedCanonicalOwner, semanticAbiAdapter, partitionDecodedFunction } from '../../js/analysis/semantic-function.js';
import { projectScopedFlowInputs, bindScopedFlowInputs } from '../../js/analysis/scoped-flow-projection.js';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { architecturePluginV2 } from '../../js/targets/architecture/index.js';
import { resolveABIPlugin } from '../../js/targets/abi/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const scalar = { returnType: 'int64', parameters: [{ type: 'int64', bits: 64 }] };
const leaf = [['mov', 'x0, #7', 0xd28000e0], ['ret', '', 0xd65f03c0]];
const declaredCaller = () => captured(0x1000n, caller, {
  functionPrototype: { returnType: 'int64', parameters: [] }, callPrototype: scalar,
});
async function load(t, source) {
  const f = scope();
  const raw = await projectScopedFlowInputs(source.owner, source.result, request(f), { limits: { deadlineMs: 10000 } });
  assert.equal(raw.status, 'completed', raw.reason);
  const projection = await buildCanonicalQueryProjection(source.result.pipeline, { ...f, snapshotId: 'snap', work: workFor(t) });
  t.after(() => projection.release());
  return { f, source, raw: raw.inputs, projection, bound: bindScopedFlowInputs(raw.inputs, projection, { ...f, snapshotId: 'snap' }) };
}
function rejectMutations(loaded, mutations) {
  for (const mutation of mutations) {
    const copy = structuredClone(loaded.raw); mutation(copy);
    assert.throws(() => bindScopedFlowInputs(copy, loaded.projection, { ...loaded.f, snapshotId: 'snap' }));
  }
}

test('only the issued canonical owner may produce physical boundary ports', async () => {
  const source = captured(), f = scope();
  assert.equal(assertScopedCanonicalOwner(source.owner), source.owner);
  assert.throws(() => assertScopedCanonicalOwner({ ...source.owner }), /issued-owner/);
  for (const owner of [{ ...source.owner }, Object.create(source.owner)]) {
    const raw = await projectScopedFlowInputs(owner, source.result, request(f));
    assert.equal(raw.status, 'unsupported'); assert.equal(raw.inputs, undefined);
  }
  const copiedMemory = { ...source.result, pipeline: { ...source.result.pipeline, memorySsa: structuredClone(source.result.pipeline.memorySsa) } };
  assert.equal((await projectScopedFlowInputs(source.owner, copiedMemory, request(f))).status, 'unsupported');
});

test('native MSSA entry, call read, clobber and return exit keep the owner version chain', async t => {
  const { bound, projection } = await load(t, captured());
  const memory = bound.memory;
  assert.equal(memory.entries.length, 1); assert.equal(memory.calls.length, 1); assert.equal(memory.exits.length, 1);
  const entry = memory.entries[0], read = memory.calls[0].inputs[0], clobber = memory.calls[0].outputs[0], exit = memory.exits[0];
  assert.equal(read.definitionId, entry.definitionId);
  assert.deepEqual(read.reachingReferences, entry.references);
  assert.equal(projection.source(read.references[0]).reachingDefinitionId, entry.definitionId);
  assert.equal(clobber.canonicalKind, 'call-clobber'); assert.equal(clobber.aliasRelation, 'may');
  assert.deepEqual(clobber.previousDefinitionIds, [entry.definitionId]);
  assert.equal(exit.definitionId, clobber.definitionId);
  assert.ok(projection.canonicalMemoryBlockState(exit.blockId).exit.some(item => item.definitionId === clobber.definitionId));
  assert.equal(memory.exact, false); assert.equal(clobber.exact, false);
  assert.ok(memory.remaining.includes('interprocedural-alias-byte-coverage-and-exception-values-open'));
});

test('native callee store publishes its own exit definition without a fabricated return value', async t => {
  const { bound, projection } = await load(t, captured(0x2000n, callee));
  assert.equal(bound.memory.entries.length, 1); assert.equal(bound.memory.exits.length, 1);
  const exit = bound.memory.exits[0], definition = projection.source(exit.references[0]);
  assert.equal(exit.canonicalKind, 'memory-def'); assert.equal(definition.kind, 'memory-def');
  assert.equal(projection.canonicalBlock(exit.blockId).nodeIds.at(-1), exit.returnSiteId);
  assert.deepEqual(bound.returns, []); assert.ok(bound.remaining.includes('function-return-binding-open'));
});

test('native MSSA scalar, region, reaching, clobber and exit claims are independently source-bound', async t => {
  const loaded = await load(t, captured());
  rejectMutations(loaded, [
    input => { input.memory.entries[0].definitionId = 'foreign'; },
    input => { input.memory.entries[0].regionId = 'foreign'; },
    input => { input.memory.entries[0].regionKind = 'stack-fixed'; },
    input => { input.memory.entries[0].canonicalKind = 'memory-def'; },
    input => { input.memory.entries[0].aliasRelation = 'must'; },
    input => { input.memory.entries[0].exact = true; },
    input => { input.memory.calls[0].callSiteId = input.memory.exits[0].returnSiteId; },
    input => { input.memory.calls[0].inputs[0].useId = 'foreign'; },
    input => { input.memory.calls[0].inputs[0].definitionId = input.memory.calls[0].outputs[0].definitionId; },
    input => { input.memory.calls[0].inputs[0].aliasRelation = 'must'; },
    input => { input.memory.calls[0].outputs[0].previousDefinitionIds = []; },
    input => { input.memory.calls[0].outputs[0].source = 'caller-asserted'; },
    input => { input.memory.exits[0].definitionId = input.memory.entries[0].definitionId; input.memory.exits[0].canonicalKind = 'entry'; input.memory.exits[0].aliasRelation = null; },
    input => { input.memory.exits[0].blockId = 'foreign'; },
    input => { input.memory.exits[0].returnSiteId = input.memory.calls[0].callSiteId; },
    input => { input.memory.entries.push({ ...input.memory.entries[0] }); },
    input => { input.memory.calls.push(structuredClone(input.memory.calls[0])); },
  ]);
});

test('a declared native return borrows the actual SSA consumed register value', async t => {
  const loaded = await load(t, captured(0x2000n, leaf, { functionPrototype: { returnType: 'int64', parameters: [] } }));
  const { bound, projection } = loaded;
  assert.equal(bound.returns.length, 1);
  const port = bound.returns[0], definition = projection.source(port.references[0]);
  assert.equal(port.register, 'x0'); assert.equal(port.canonicalKind, 'definition');
  assert.equal(definition.valueId, port.valueId); assert.equal(port.exact, false);
  const returnNode = projection.source(port.siteReference), read = projection.source(port.sourceReference);
  assert.equal(returnNode.kind, 'return'); assert.equal(read.kind, 'state-read');
  assert.equal(read.outputs[0], returnNode.attributes.abiReturnBinding.valueId);
  assert.equal(projection.source(projection.entityReference('ssa', port.useId)).valueId, port.valueId);
  assert.ok(bound.remaining.includes('hidden-result-and-exception-value-ports-open'));
});

test('declared native scalar input can reach the return without inventing a new SSA definition', async t => {
  const loaded = await load(t, captured(0x2000n, callee, { functionPrototype: scalar }));
  assert.equal(loaded.bound.parameters.length, 1); assert.equal(loaded.bound.returns.length, 1);
  assert.equal(loaded.bound.returns[0].valueId, loaded.bound.parameters[0].valueId);
  assert.equal(loaded.bound.returns[0].canonicalKind, 'entry');
});

test('declared native call binds a fresh normal result and retains unknown call effects', async t => {
  const loaded = await load(t, declaredCaller());
  const call = loaded.bound.calls[0];
  assert.equal(call.arguments.length, 1); assert.equal(call.returns.length, 1); assert.equal(loaded.bound.returns.length, 1);
  assert.notEqual(call.returns[0].valueId, call.arguments[0].valueId);
  assert.equal(loaded.bound.returns[0].valueId, call.returns[0].valueId);
  const node = loaded.projection.source(call.reference);
  assert.equal(node.call.completeness, 'unknown'); assert.equal(node.call.memoryWrite.scope, 'unknown');
  assert.equal(node.call.mayThrow, 'unknown');
  assert.ok(loaded.source.result.pipeline.semanticIr.unknowns.some(item => item.reason === 'call-context-effects-not-enriched'));
  assert.equal(loaded.bound.memory.calls[0].outputs[0].canonicalKind, 'call-clobber');
});

test('native return bindings reject register, descriptor, consumer and scalar definition mutations', async t => {
  const loaded = await load(t, declaredCaller());
  rejectMutations(loaded, [
    input => { input.returns[0].register = 'x30'; },
    input => { input.returns[0].widthBits = 32; },
    input => { input.returns[0].descriptor.reg = 'x30'; },
    input => { input.returns[0].descriptor.bits = 32; },
    input => { input.returns[0].useId = 'foreign'; },
    input => { input.returns[0].sourceEntityId = input.calls[0].callSiteId; },
    input => { input.returns[0].returnSiteId = input.calls[0].callSiteId; },
    input => { input.returns[0].definitionId = input.calls[0].arguments[0].definitionId; input.returns[0].valueId = input.calls[0].arguments[0].valueId; },
    input => { input.calls[0].returns[0].definitionId = input.calls[0].arguments[0].definitionId; input.calls[0].returns[0].valueId = input.calls[0].arguments[0].valueId; },
    input => { input.calls[0].returns[0].useId = input.returns[0].useId; },
    input => { input.calls[0].returns[0].exact = true; },
    input => { input.calls[0].returns.push({ ...input.calls[0].returns[0] }); },
    input => { input.returns.push({ ...input.returns[0] }); },
  ]);
});

for (const [name, prototype] of [['missing', null], ['void', { returnType: 'void' }], ['narrow', { returnType: 'int32', returnBits: 32 }],
  ['vector', { returnType: 'double' }], ['aggregate', { returnType: 'struct', aggregate: true }]]) {
  test(`${name} return declarations cannot fabricate a full scalar native port`, async t => {
    const { bound } = await load(t, captured(0x2000n, leaf, { functionPrototype: prototype }));
    assert.deepEqual(bound.returns, []);
    assert.ok(bound.remaining.includes('function-return-binding-open'));
  });
}

test('a later opaque call does not preserve a typed native return fact', async t => {
  const rows = [['mov', 'x0, #1', 0xd2800020], ['bl', '#0x2000', 0x940003ff], ['bl', '#0x3000', 0x940007fe], ['ret', '', 0xd65f03c0]];
  const loaded = await load(t, captured(0x1000n, rows, {
    functionPrototype: { returnType: 'int64', parameters: [] }, callPrototypeFor: (_target, call) => call?.address === 0x1004n ? scalar : null,
  }));
  assert.equal(loaded.bound.calls.filter(call => call.returns.length === 1).length, 1);
  assert.deepEqual(loaded.bound.returns, []);
  assert.ok(loaded.bound.remaining.includes('function-return-binding-open'));
  assert.equal(loaded.bound.memory.calls.length, 2);
});

test('boundary projection charges the shared work owner and never publishes partial budget results', async () => {
  const source = declaredCaller(), f = scope();
  const work = new ScopedAnalysisWork({ limits: { deadlineMs: 10000, results: 1 } });
  try {
    await assert.rejects(projectScopedFlowInputs(source.owner, source.result, request(f), { work }), error => {
      assert.equal(error.status, 'budget-exhausted'); assert.ok(error.cost.used.workUnits > 0); return true;
    });
    assert.doesNotThrow(() => work.checkpoint(), 'the borrower must not dispose shared work');
  } finally { work.dispose(); }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(projectScopedFlowInputs(source.owner, source.result, request(f), { signal: abort.signal }));
});

// Deliberately modified classifier responses self-test the imported binding
// gate. These are not issued native owners or independent ABI truth evidence.
for (const [name, change] of [
  ['exact false', argument => ({ ...argument, exact: false })],
  ['possible', argument => ({ ...argument, possible: true })],
  ['not required', argument => ({ ...argument, mustUse: false })],
  ['unknown possibility', argument => ({ ...argument, possible: undefined })],
  ['unknown use', argument => ({ ...argument, mustUse: undefined })],
  ['contradictory exact and possible', argument => ({ ...argument, exact: true, possible: true })],
  ['contradictory exact and optional', argument => ({ ...argument, exact: true, mustUse: false })],
]) {
  test(`canonical ABI call and entry gates reject ${name} argument fixtures`, () => {
    const instructions = captured().owner.decodedInstructions, architecture = architecturePluginV2('arm64');
    const options = { architecture: 'arm64', platform: 'linux', abiId: 'aapcs64', binaryId: 'binary-scpa-test',
      sliceId: 'slice-arm64', snapshotId: 'snap', functionPrototype: scalar, callPrototype: scalar };
    const adapter = semanticAbiAdapter(resolveABIPlugin(options), options);
    const modified = { ...adapter,
      classifyArguments: args => {
        const raw = adapter.classifyArguments(args);
        return { ...raw, arguments: raw.arguments.map(change) };
      },
      classifyCall: args => {
        const raw = adapter.classifyCall(args);
        return { ...raw, explicitArguments: raw.explicitArguments.map(change) };
      },
    };
    const blocks = partitionDecodedFunction(instructions, architecture);
    const pipeline = buildSemanticV2CompatibilityPipeline({ architecturePlugin: architecture,
      decoderSemanticVersion: 'legacy-model-decoder-v1', binaryId: 'binary-scpa-test', sliceId: 'slice-arm64',
      addressWidthBits: 64, mode: 'a64', entryBlockKey: blocks[0].key, blocks, abiAdapter: modified,
      functionPrototype: scalar, machineEffectsContext: { dataEndianness: 'little', instructionEndianness: 'little' },
    }, { snapshotId: 'snap' });
    assert.equal(pipeline.semanticIr.nodes.some(node => node.attributes?.abiCallBinding), false);
    assert.equal(pipeline.semanticIr.values.some(value => value.metadata?.abiArgumentBinding), false);
  });
}

test('native ABI observations preserve machine effects and canonical determinism', () => {
  const first = declaredCaller(), second = declaredCaller(), opaque = captured();
  assert.deepEqual(first.result.pipeline.machineEffects, opaque.result.pipeline.machineEffects);
  assert.deepEqual(first.result.pipeline.semanticIr, second.result.pipeline.semanticIr);
  const call = first.result.pipeline.semanticIr.nodes.find(node => node.call);
  assert.equal(call.call.targetEntityIds.length, 0);
  assert.ok(call.origin.transforms.some(transform => transform.passId === 'semantic-abi-call-binding'));
  const narrow = captured(0x2000n, leaf, { functionPrototype: { returnType: 'int32', returnBits: 32 } });
  const returned = narrow.result.pipeline.semanticIr.nodes.find(node => node.kind === 'return');
  const value = narrow.result.pipeline.semanticIr.values.find(item => item.id === returned.inputs[0]);
  assert.equal(value.machineType.widthBits, 32);
  assert.equal(narrow.result.pipeline.semanticIr.nodes.find(node => node.id === value.definitionNodeId).kind, 'trunc');
});
