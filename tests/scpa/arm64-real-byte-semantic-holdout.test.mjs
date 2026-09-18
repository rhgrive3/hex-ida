import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { threadedNativeFixture } from './threaded-native-fixture.mjs';
import { fixture as worldFixture, workFor } from './helpers.mjs';
import { createSliceId } from '../../js/core/identity/index.js';
import { produceScopedArm64Pipeline } from '../../js/analysis/scoped-arm64-producer.js';

const FIXTURE = 'arm64-real-byte-semantic-holdout';
const PIPELINE_ROUTE = Object.freeze(['MachineEffects', 'SemanticIR', 'SSA', 'MemorySSA']);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const caseById = (f, id) => {
  const row = f.manifest.cases.find(candidate => candidate.id === id);
  assert.ok(row, `fixture case ${id} must exist`);
  return row;
};
const registerOp = (bundle, kind, registerId) => bundle.operations.find(operation =>
  operation.kind === kind && operation.register?.registerId === registerId);
const valueOp = (bundle, opcode) => bundle.operations.find(operation =>
  operation.kind === 'value' && operation.opcode === opcode);
const virtualStart = entity => entity.origin?.virtualRanges?.find(range => range.sliceId)?.start;

function assertMove(bundle, from, to) {
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata?.sourceMnemonic, 'mov');
  const read = registerOp(bundle, 'register-read', from);
  const write = registerOp(bundle, 'register-write', to);
  assert.ok(read, `mov must read ${from}`);
  assert.ok(write, `mov must write ${to}`);
  assert.equal(write.value?.temporaryId, read.value?.temporaryId,
    `mov ${from} -> ${to} must preserve the same value`);
}

async function loadPipeline(t, f, world, row) {
  const address = BigInt(row.start), end = BigInt(row.end), length = Number(end - address);
  const symbol = f.symbols.functionAt(address);
  assert.ok(symbol, `${row.function} must have a loader-proven extent`);
  assert.equal(symbol.start, address);
  assert.equal(symbol.end, end);
  const region = f.info.slices[0].regions.find(candidate => candidate.exec === true
    && address >= BigInt(candidate.vmAddr)
    && end <= BigInt(candidate.vmAddr) + BigInt(candidate.size));
  assert.ok(region, `${row.function} must be contained in an executable source region`);

  // Bind the oracle to the exact bytes that the production producer will read.
  const source = await f.backend.readAt(address, length, false);
  assert.equal(source?.found, true);
  assert.equal(source.bytes?.byteLength, length);
  assert.equal(digest(source.bytes), row.bytesSha256, `${row.id} machine bytes drifted`);

  const before = { ...f.counters };
  const result = await produceScopedArm64Pipeline(f.backend, {
    region, address, length, sliceIndex: 0, snapshotId: 'arm64-real-byte-semantic-holdout',
    binaryId: f.backend.binaryId, architecture: 'arm64', abiId: 'aapcs64', platform: 'linux',
    dataEndianness: 'little', world, work: workFor(t, { deadlineMs: 8000 }), isCurrent: () => true,
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.pipeline.instrumentation?.v2Executed, true);
  assert.equal(result.pipeline.architectureId, 'arm64');
  assert.equal(result.nativeSource.virtualStart, address.toString());
  assert.equal(result.nativeSource.length, length);
  assert.ok(f.counters.decodes > before.decodes, 'shipped Capstone decoder must execute for this case');
  assert.ok(f.counters.semantic > before.semantic, 'actual platform semantic worker must execute for this case');
  for (const owner of ['machineEffects', 'semanticIr', 'ssa', 'memorySsa']) assert.ok(result.pipeline[owner], `${owner} owner must exist`);
  return result.pipeline;
}

test('G-01 real AArch64 bytes traverse the shipped decoder and shared semantic owners', { timeout: 35000 }, async t => {
  const f = await threadedNativeFixture(t, { fixture: FIXTURE });
  assert.equal(f.info.formatId, 'elf');
  assert.equal(f.manifest.schema, 'arm64-real-byte-semantic-holdout/v1');
  assert.equal(f.manifest.cases.length, 5);
  assert.ok(f.workerThreadId > 0, 'semantic analysis must run in the actual platform worker thread');
  assert.equal(f.capstoneVersion.major, 5, 'fixture must use the repository-shipped Capstone 5 decoder');
  assert.match(f.manifest.claim, /not product pseudocode/i);

  const binaryId = f.backend.binaryId;
  const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const { world } = worldFixture(data => {
    data.binarySet[0].binaryId = binaryId;
    data.binarySet[0].sliceId = sliceId;
    data.binarySet[0].sourceIdentity.sha256 = f.manifest.binarySha256;
  });

  await t.test('arithmetic/wrap: W-register add is 32-bit modulo arithmetic then zero-extended', async t => {
    const row = caseById(f, 'arithmetic-wrap');
    const pipeline = await loadPipeline(t, f, world, row);
    const [mov, add, ret] = pipeline.machineEffects;
    assert.equal(mov.metadata?.widthBits, 32);
    assert.equal(add.metadata?.widthBits, 32);
    assert.equal(ret.controlEffect?.kind, 'return');

    const seed = valueOp(mov, 'zext');
    assert.deepEqual(seed?.inputs?.[0], { kind: 'bitvector', value: '4294967295', widthBits: 32 });
    assert.equal(seed?.metadata?.fromBits, 32);
    assert.equal(seed?.metadata?.toBits, 64);

    const add32 = valueOp(add, 'add-with-carry');
    assert.equal(add32?.metadata?.widthBits, 32);
    assert.equal(add32?.metadata?.subtract, false);
    assert.ok(add32.inputs.some(input => input.kind === 'bitvector' && input.value === '1' && input.widthBits === 32));
    const extend = valueOp(add, 'zext');
    assert.equal(extend?.metadata?.fromBits, 32);
    assert.equal(extend?.metadata?.toBits, 64);
    assert.equal(registerOp(add, 'register-write', 'x0')?.value?.temporaryId, extend?.outputs?.[0]?.temporaryId);

    // Independent source-contract oracle: (2^32 - 1 + 1) mod 2^32 == 0.
    assert.equal((0xffff_ffffn + 1n) & 0xffff_ffffn, 0n);
    assert.ok(pipeline.semanticIr.nodes.some(node => node.kind === 'zext'), 'SemanticIR must retain W->X zero extension');
  });

  await t.test('conditional semantics: CMP zero feeds B.EQ and preserves taken/fallthrough polarity', async t => {
    const row = caseById(f, 'conditional-semantics');
    const pipeline = await loadPipeline(t, f, world, row);
    const cmp = pipeline.machineEffects[0], branch = pipeline.machineEffects[1];
    assert.equal(cmp.metadata?.sourceMnemonic, 'cmp');
    assert.equal(cmp.metadata?.widthBits, 64);
    assert.equal(branch.metadata?.sourceMnemonic, 'b.eq');
    assert.equal(branch.metadata?.conditionCode, 'eq');
    assert.equal(branch.controlEffect?.kind, 'conditional-branch');
    assert.equal(branch.controlEffect?.target?.value, String(0x101cn));
    assert.equal(branch.controlEffect?.fallthrough?.value, String(0x1014n));
    const zRead = branch.operations.find(operation => operation.kind === 'flag-read' && operation.flag?.flagId === 'NZCV.Z');
    assert.ok(zRead, 'B.EQ must read Z, so B.NE substitution cannot false-green');
    assert.equal(branch.controlEffect.condition?.temporaryId, zRead.value?.temporaryId);

    const irBranch = pipeline.semanticIr.nodes.find(node => node.kind === 'conditional-branch');
    assert.ok(irBranch, 'conditional MachineEffects must project into SemanticIR');
    assert.equal(irBranch.attributes?.machineEffects?.bundleMetadata?.conditionCode, 'eq');
    assert.equal(irBranch.attributes?.machineControlEffect?.target?.value, String(0x101cn));
    assert.equal(irBranch.attributes?.machineControlEffect?.fallthrough?.value, String(0x1014n));
    assert.equal(pipeline.cfg.blocks.length, 4, 'taken/fallthrough/join CFG must remain explicit');
  });

  await t.test('memory reaching-definition: stack load must reach the preceding must-alias store', async t => {
    const row = caseById(f, 'memory-reaching-definition');
    const pipeline = await loadPipeline(t, f, world, row);
    const write = pipeline.memorySsa.canonicalAccessBindings.find(binding => binding.sourceKind === 'store');
    const read = pipeline.memorySsa.canonicalAccessBindings.find(binding => binding.sourceKind === 'load');
    assert.ok(write && read, 'canonical MemorySSA must bind both store and load');
    assert.equal(write.role, 'write');
    assert.equal(read.role, 'read');
    assert.equal(write.aliasRelation, 'must');
    assert.equal(read.aliasRelation, 'must');
    assert.equal(write.regionId, read.regionId);

    const use = pipeline.memorySsa.uses.find(candidate => candidate.id === read.memorySsaEntityId);
    assert.ok(use);
    assert.equal(use.reachingDefinitionId, write.memorySsaEntityId,
      'load must reach the exact preceding store, not the entry memory version');
    const link = pipeline.memorySsa.defUseLinks.find(candidate => candidate.definitionId === write.memorySsaEntityId);
    assert.ok(link?.useIds.includes(read.memorySsaEntityId));
    assert.equal(virtualStart(use), '0x102c', 'reaching use must originate at the fixture LDR');
  });

  await t.test('direct call/AAPCS64: x1/x2 are placed in x0/x1 before the exact BL target', async t => {
    const row = caseById(f, 'direct-call-aapcs64');
    const pipeline = await loadPipeline(t, f, world, row);
    assertMove(pipeline.machineEffects[2], 'x1', 'x0');
    assertMove(pipeline.machineEffects[3], 'x2', 'x1');
    const call = pipeline.machineEffects[4];
    assert.equal(call.metadata?.sourceMnemonic, 'bl');
    assert.equal(call.metadata?.direct, true);
    assert.equal(call.controlEffect?.kind, 'call');
    assert.equal(call.controlEffect?.target?.value, String(0x105cn));
    assert.equal(call.controlEffect?.fallthrough?.value, String(0x1050n));

    const irCall = pipeline.semanticIr.nodes.find(node => node.kind === 'call');
    assert.ok(irCall);
    assert.equal(irCall.call?.summarySource, 'machine-effects-abi-neutral-call');
    assert.equal(irCall.call?.completeness, 'unknown', 'canonical call owner must not invent callee effects');
    assert.equal(irCall.attributes?.machineControlEffect?.target?.value, String(0x105cn));

    const abi = await f.invoke('abiInputBindings', { functionId: row.start });
    assert.equal(abi.abiId, 'aapcs64');
    assert.equal(abi.calls.length, 1);
    assert.deepEqual(abi.calls[0].arguments.map(argument => argument.register), ['x0', 'x1']);
    assert.equal(abi.calls[0].exact, false, 'ABI binding remains candidate evidence, not semantic proof');
  });

  await t.test('unknown/fail-closed: unsupported LDAXP stays explicit unknown instead of fabricated effects', async t => {
    const row = caseById(f, 'unknown-fail-closed');
    const pipeline = await loadPipeline(t, f, world, row);
    const unknown = pipeline.machineEffects[0];
    assert.equal(unknown.completeness, 'unknown');
    assert.equal(unknown.metadata?.explicitUnknown, true);
    assert.equal(unknown.operations.length, 0);
    assert.equal(unknown.controlEffect?.kind, 'unknown');
    assert.equal(unknown.unknownEffects?.preservation, 'not-assumed');
    assert.deepEqual(new Set(unknown.unknownEffects?.categories),
      new Set(['control', 'faults', 'flags', 'memory', 'other', 'registers']));
    assert.ok(pipeline.semanticIr.nodes.some(node => node.kind === 'unknown-control-effect'));
    assert.ok(pipeline.semanticIr.nodes.some(node => node.kind === 'unknown-memory-effect'));
    assert.ok(!pipeline.machineEffects.some(bundle => bundle.metadata?.sourceMnemonic === 'ldaxp' && bundle.completeness === 'exact'));
  });

  assert.ok(f.counters.decodes >= 5, 'each semantic case must exercise the shipped decoder');
  assert.ok(f.counters.semantic >= 5, 'each semantic case must exercise the shared semantic worker');
  assert.deepEqual(PIPELINE_ROUTE, ['MachineEffects', 'SemanticIR', 'SSA', 'MemorySSA']);
});
