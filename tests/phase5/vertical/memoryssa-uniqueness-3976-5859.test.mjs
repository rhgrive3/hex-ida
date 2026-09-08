import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createMemorySsaContract } from '../../../js/semantics/memoryssa/contract.js';
import { validateMemorySsa } from '../../../js/semantics/memoryssa/validate.js';
import { memoryVersionAtBlock } from '../../../js/semantics/memoryssa/queries.js';

const origin = { instructionIds: ['fixture'] };
const cfg = createSemanticCfg({
  functionId: 'f', entryBlockId: 'entry',
  blocks: [
    { id: 'entry', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ],
});
function input(incoming = [{ predecessorBlockId: 'entry', definitionId: 'e' }]) {
  return {
    functionId: 'f',
    regions: [{ id: 'r', kind: 'stack-fixed', functionId: 'f', offset: 0, widthBits: 64 }],
    definitions: [
      { id: 'e', kind: 'entry', regionId: 'r', blockId: 'entry', origin },
      { id: 'p', kind: 'memory-phi', regionId: 'r', blockId: 'join', incoming, origin },
    ],
    uses: [],
  };
}
function state(blockId, entry, exit) {
  return { blockId, entry: [{ regionId: 'r', definitionId: entry }], exit: [{ regionId: 'r', definitionId: exit }] };
}

for (const options of [{}, { cfg }]) {
  const mode = options.cfg ? 'with CFG' : 'without CFG';
  for (const distinctDefinitions of [false, true]) {
    test(`#5859 duplicate predecessor is rejected ${mode}, ${distinctDefinitions ? 'conflicting' : 'identical'} definitions`, () => {
      const raw = input([
        { predecessorBlockId: 'entry', definitionId: 'e' },
        { predecessorBlockId: 'entry', definitionId: distinctDefinitions ? 'p' : 'e' },
      ]);
      for (const construct of [createMemorySsaContract, validateMemorySsa]) {
        assert.throws(() => construct(raw, options), /memory-ssa-duplicate-phi-predecessor/);
      }
    });
  }
  test(`#5859 normalized duplicate predecessor is rejected ${mode}`, () => {
    const raw = input([
      { predecessorBlockId: 'entry', definitionId: 'e' },
      { predecessorBlockId: ' entry ', definitionId: 'e' },
    ]);
    assert.throws(() => createMemorySsaContract(raw, options), /memory-ssa-duplicate-phi-predecessor/);
  });
  test(`#5859 unique predecessor remains valid ${mode}`, () => {
    const result = createMemorySsaContract(input(), options);
    assert.deepEqual(result.definitions.find((d) => d.id === 'p').incoming, [{ predecessorBlockId: 'entry', definitionId: 'e' }]);
    assert.ok(Object.isFrozen(result));
    assert.doesNotThrow(() => validateMemorySsa(result, options));
  });
  for (const conflicting of [false, true]) {
    test(`#3976 ${conflicting ? 'conflicting' : 'identical'} duplicate block state is rejected ${mode}`, () => {
      const base = createMemorySsaContract(input(), options);
      const first = state('join', 'e', 'p');
      const second = conflicting ? state('join', 'p', 'e') : structuredClone(first);
      for (const blockStates of [[first, second], [second, first]]) {
        assert.throws(() => validateMemorySsa({ ...base, blockStates }, options), /memory-ssa-validate-duplicate-block-state/);
      }
    });
  }
  test(`#3976 distinct block states have order-independent queries ${mode}`, () => {
    const base = createMemorySsaContract(input(), options);
    const states = [state('entry', 'e', 'e'), state('join', 'p', 'p')];
    for (const blockStates of [states, states.slice().reverse()]) {
      const result = validateMemorySsa({ ...base, blockStates }, options);
      assert.equal(memoryVersionAtBlock(result, 'entry', 'r', 'entry'), 'e');
      assert.equal(memoryVersionAtBlock(result, 'join', 'r', 'exit'), 'p');
    }
    // This repair does not invent mandatory whole-CFG block-state coverage.
    assert.doesNotThrow(() => validateMemorySsa({ ...base, blockStates: [states[0]] }, options));
    assert.doesNotThrow(() => validateMemorySsa(base, options));
  });
}

test('CFG predecessor membership and complete incoming sets are still checked', () => {
  assert.throws(() => createMemorySsaContract(input([{ predecessorBlockId: 'other', definitionId: 'e' }]), { cfg }), /phi-predecessor-not-in-cfg/);
  const diamond = createSemanticCfg({ functionId: 'f', entryBlockId: 'entry', blocks: [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'join', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ] });
  assert.throws(() => createMemorySsaContract(input(), { cfg: diamond }), /phi-predecessor-set-incomplete/);
  assert.throws(() => createMemorySsaContract(input([{ predecessorBlockId: 'entry', definitionId: 'missing' }])), /dangling-phi-definition/);
});

test('block-state region coverage and definition membership remain mandatory', () => {
  const base = createMemorySsaContract(input());
  assert.throws(() => validateMemorySsa({ ...base, blockStates: [state('other', 'e', 'e')] }, { cfg }), /invalid-block-state/);
  assert.throws(() => validateMemorySsa({ ...base, blockStates: [{ ...state('entry', 'e', 'e'), entry: [] }] }), /incomplete-block-state/);
  assert.throws(() => validateMemorySsa({ ...base, blockStates: [state('entry', 'missing', 'e')] }), /block-state-definition-mismatch/);
  const duplicateRegion = state('entry', 'e', 'e');
  duplicateRegion.entry.push({ ...duplicateRegion.entry[0] });
  assert.throws(() => validateMemorySsa({ ...base, blockStates: [duplicateRegion] }), /duplicate-block-state-region/);
});

test('validation cancellation and work budgets are not bypassed', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => createMemorySsaContract(input(), { signal: controller.signal }), /cancelled/);
  assert.throws(() => validateMemorySsa(input(), { signal: controller.signal }), /cancelled/);
  assert.throws(() => createMemorySsaContract(input(), { budget: { maxWorkItems: 1 } }), /budget-exceeded-maxWorkItems/);
});
