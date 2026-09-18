import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperands } from '../../../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { prepareCanonicalComparisonCarrierBindings } from '../../../js/ir-core.js';

function projectedCsel() {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'c4-carrier-binding-1',
    binaryId: 'c4-carrier-binary',
    sliceId: 'c4-carrier-slice',
    addressWidthBits: 64,
    entryBlockKey: 'entry',
    blocks: [{
      key: 'entry', startAddress: 0x1000n, successors: [],
      instructions: [
        { decoded: { address: 0x1000n, mnemonic: 'cmp', operands: 'x0, x1', ops: parseOperands('x0, x1'), mode: 'a64' } },
        { decoded: { address: 0x1004n, mnemonic: 'csel', operands: 'x2, x3, x4, lt', ops: parseOperands('x2, x3, x4, lt'), mode: 'a64' } },
        { decoded: { address: 0x1008n, mnemonic: 'ret', operands: '', ops: parseOperands(''), mode: 'a64' } },
      ],
    }],
  }).legacyV1;
}

function carrierAndSelect(ir) {
  const carrier = ir.instructions.find(instruction => instruction.extra?.semanticComparisonCarrier === true);
  const select = ir.instructions.find(instruction => instruction.op === 'sel');
  assert.ok(carrier && select);
  return { carrier, select };
}

function identityFor(ir) {
  return { functionId: ir.functionId, queryId: 'c4-carrier-query' };
}

test('C4 carrier binding authenticates producer provenance and the exact SEL display edge', () => {
  const ir = projectedCsel();
  const { carrier, select } = carrierAndSelect(ir);
  const binding = prepareCanonicalComparisonCarrierBindings(ir, identityFor(ir));
  assert.equal(binding.status, 'prepared');
  assert.equal(binding.size, 1);
  assert.equal(binding.isCurrent(), true);
  assert.deepEqual(binding.get(carrier), {
    kind: 'display-carrier',
    carriedValueId: carrier.dst.id,
    producerInstructionId: carrier.id,
    sourceEntityId: carrier.sourceEntityId,
    consumerCount: 1,
  });
  assert.deepEqual(binding.get(select), {
    kind: 'display-consumer',
    carriedValueId: carrier.dst.id,
    producerInstructionId: carrier.id,
    sourceEntityId: carrier.sourceEntityId,
    role: 'select-condition-carrier',
    argumentIndex: 2,
    conditionValueId: select.extra.conditionValueId,
    condition: 'lt',
    signedness: true,
  });
});

test('C4 carrier binding rejects copied value wrappers and arbitrary marker authority', () => {
  const ir = projectedCsel();
  const { carrier, select } = carrierAndSelect(ir);
  const originalArgument = select.args[2];
  select.args[2] = { value: { ...carrier.dst }, bits: 1 };
  assert.equal(prepareCanonicalComparisonCarrierBindings(ir, identityFor(ir)).status, 'unavailable');
  select.args[2] = originalArgument;

  const fake = ir.instructions.find(instruction => instruction !== carrier && instruction.dst);
  assert.ok(fake);
  const originalExtra = fake.extra;
  fake.extra = { ...originalExtra, comparison: 'semantic-flag-result', semanticComparisonCarrier: true, completeness: 'complete' };
  assert.equal(prepareCanonicalComparisonCarrierBindings(ir, identityFor(ir)).status, 'unavailable');
  fake.extra = originalExtra;

  const sourceEntityId = carrier.sourceEntityId;
  const originalDerivedId = ir.compat.derivedComparisonCarriers[sourceEntityId];
  ir.compat.derivedComparisonCarriers[sourceEntityId] = carrier.dst.id + 1;
  assert.equal(prepareCanonicalComparisonCarrierBindings(ir, identityFor(ir)).status, 'unavailable');
  ir.compat.derivedComparisonCarriers[sourceEntityId] = originalDerivedId;
});

test('C4 carrier binding revokes on source graph and identity mutation', () => {
  const ir = projectedCsel();
  const { select } = carrierAndSelect(ir);
  const identity = identityFor(ir);
  const binding = prepareCanonicalComparisonCarrierBindings(ir, identity);
  assert.equal(binding.status, 'prepared');
  assert.equal(binding.isCurrent(), true);

  const originalConditionCarrierId = select.extra.conditionCarrierValueId;
  select.extra.conditionCarrierValueId = originalConditionCarrierId + 1;
  assert.equal(binding.isCurrent(), false);
  select.extra.conditionCarrierValueId = originalConditionCarrierId;
  assert.equal(binding.isCurrent(), true);

  const uses = carrierAndSelect(ir).carrier.dst.uses;
  uses.push(select);
  assert.equal(binding.isCurrent(), false);
  uses.pop();
  assert.equal(binding.isCurrent(), true);

  const originalFunctionId = identity.functionId;
  identity.functionId = 'stale-function';
  assert.equal(binding.isCurrent(), false);
  identity.functionId = originalFunctionId;
  assert.equal(binding.isCurrent(), true);

  const originalInstructions = ir.instructions;
  ir.instructions = originalInstructions.slice();
  assert.equal(binding.isCurrent(), false);
  ir.instructions = originalInstructions;
  assert.equal(binding.isCurrent(), true);
});
