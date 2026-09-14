import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { memoryAccessMetadata, reachingConcreteStore } from '../../js/semantics/memoryssa/queries.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const functionId = 'function_issue_4388';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const register = (physicalId) => ({ kind: 'register', physicalId });
const plus = (root, offset) => ({ kind: 'add', left: register(root), right: typeof offset === 'string'
  ? register(offset) : { kind: 'bitvector', value: String(offset) } });
function stackRegion(id, root = 'sp', offset = 0, widthBits = 32) {
  return createMemoryRegionRef({ id, kind: 'stack-fixed', functionId, offset, widthBits,
    rootIdentity: { registerId: root }, addressSpace: 'memory' });
}
function build({ expression = plus('sp', 64), knownLoad = false, qualifiers = false,
  displacement, loadWidth = 32, extraRegions = [] } = {}) {
  const stored = stackRegion('stack_sp_0');
  const loadRegion = knownLoad === true ? stored : knownLoad || null;
  const mem = (id, widthBits) => ({ addressSpace: 'memory', addressExpr: { valueId: id },
    widthBits, endian: 'little', volatility: qualifiers, atomic: qualifiers, ordering: 'unknown' });
  const attributes = displacement == null ? {} : { machineEffects: {
    operationMetadata: { addressing: { addressDisplacement: String(displacement) } },
  } };
  const nodes = [
    { id: 'store', kind: 'store', blockId: 'entry', inputs: [], outputs: [],
      memory: mem('addr_store', 32), attributes, origin: origin('store') },
    { id: 'load', kind: 'load', blockId: 'entry', inputs: [], outputs: [],
      memory: mem('addr_load', loadWidth), attributes, origin: origin('load') },
  ];
  const ir = createSemanticIrFunction({ functionId, entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('block') }],
    values: [plus('sp', 0), expression].map((expr, i) => ({
      id: i ? 'addr_load' : 'addr_store', kind: 'entry',
      machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
      metadata: { machineAddressExpression: expr }, origin: origin(`address_${i}`),
    })), nodes, origin: origin('function') });
  const cfg = createSemanticCfg({ functionId, entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }] });
  const memorySsa = buildMemorySsa(ir, cfg, {
    regions: extraRegions,
    resolveRegion: (memory) => memory.addressExpr.valueId === 'addr_store' ? stored : loadRegion,
    queryAlias: (left, right) => left.kind === 'unknown' || right.kind === 'unknown'
      ? 'unknown' : left.id === right.id ? 'must' : 'unknown',
  });
  validateMemorySsa(memorySsa, { cfg });
  const use = memorySsa.uses.find((u) => u.sourceEntityId === 'load');
  assert.ok(use);
  return { memorySsa, use, stored, loadRegion };
}
for (const [name, expression] of [
  ['different constant offset', plus('sp', 64)], ['negative offset', plus('sp', -16)],
  ['dynamic offset', plus('sp', 'x1')], ['different frame root', plus('fp', 0)],
  ['unproven stack identity', plus('sp', 0)],
]) {
  for (const displacement of [undefined, 0]) {
    test(`#4388: ${name}, displacement ${String(displacement)} does not borrow a proven slot`, () => {
      const { memorySsa, use, stored } = build({ expression, displacement });
      assert.notEqual(use.regionId, stored.id);
      assert.notEqual(use.aliasRelation, 'must');
      assert.equal(reachingConcreteStore(memorySsa, use), null);
    });
  }
}
for (const [name, region, expression] of [
  ['different offset', stackRegion('stack_sp_64', 'sp', 64), plus('sp', 64)],
  ['different root', stackRegion('stack_fp_0', 'fp', 0), plus('fp', 0)],
]) {
  test(`#4388: a resolver-proven ${name} is not overwritten by a colliding displacement`, () => {
    const { memorySsa, use } = build({ knownLoad: region, expression });
    assert.equal(use.regionId, region.id);
    assert.equal(reachingConcreteStore(memorySsa, use), null);
  });
}
for (const loadWidth of [8, 64]) {
  test(`#4388: inventory fallback cannot lend a slot to an unproven ${loadWidth}-bit load`, () => {
    const { memorySsa, use } = build({ loadWidth, extraRegions: [stackRegion('other_slot', 'fp', 0)] });
    assert.notEqual(use.aliasRelation, 'must');
    assert.equal(reachingConcreteStore(memorySsa, use), null);
  });
}
for (const qualifiers of ['unknown', true]) {
  test(`#4388: stack placement alone does not erase ${qualifiers} memory qualifiers`, () => {
    const { memorySsa, use } = build({ knownLoad: true, expression: plus('sp', 0), qualifiers });
    const access = memoryAccessMetadata(memorySsa, use.id);
    assert.equal(access.sequencing.volatility, qualifiers);
    assert.equal(access.sequencing.atomic, qualifiers);
  });
}
test('#4388: independently proven same-slot reads still reach the real store', () => {
  const { memorySsa, use, stored } = build({ knownLoad: true, expression: plus('sp', 0) });
  assert.equal(use.regionId, stored.id);
  assert.equal(use.aliasRelation, 'must');
  assert.equal(reachingConcreteStore(memorySsa, use)?.sourceEntityId, 'store');
});

test('#4388: artifacts from the old stack-normalization producer require rebuilding', () => {
  const { memorySsa } = build();
  assert.notEqual(memorySsa.buildVersion, '1.0.0');
  assert.throws(() => validateMemorySsa({ ...memorySsa, buildVersion: '1.0.0' }), /build-version/);
});
