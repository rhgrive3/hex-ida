import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const bit64 = Object.freeze({ kind: 'bitvector', widthBits: 64 });

function transform(producedId) {
  return {
    passId: 'semantic-ssa', passVersion: 'issue-4534-test', ruleId: 'fixture', proofKind: 'fixture',
    consumedEntityIds: [], producedEntityIds: [producedId], preconditions: [],
  };
}

function origin(id, producedId = null) {
  return {
    operationIds: [`operation:${id}`],
    ...(producedId == null ? {} : { transforms: [transform(producedId)] }),
  };
}

function irFor(blocks) {
  const nodes = blocks.flatMap(({ id: blockId, nodeIds }) => nodeIds.map((id) => ({
    id, kind: 'return', blockId, inputs: [], outputs: [], origin: origin(id),
  })));
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function_issue_4534',
    entryBlockId: 'b0',
    blocks: blocks.map(({ id, nodeIds }) => ({ id, nodeIds, origin: origin(`block:${id}`) })),
    values: [],
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  };
}

function cfgFor(blocks, edges = []) {
  const successors = new Map(blocks.map(({ id }) => [id, []]));
  for (const [from, to] of edges) successors.get(from).push({ to, kind: 'branch' });
  return {
    functionId: 'function_issue_4534',
    entryBlockId: 'b0',
    blocks: blocks.map(({ id }) => ({ id, successors: successors.get(id) })),
  };
}

function proof(sourceDefinitionNodeId) {
  return {
    passId: 'semantic-ssa', passVersion: 'issue-4534-test', machineType: bit64,
    ...(sourceDefinitionNodeId === undefined ? {} : { sourceDefinitionNodeId }),
  };
}

function ordinaryDefinition({ sourceEntityId = 'n-def', sourceDefinitionNodeId = undefined, blockId = 'b0' } = {}) {
  return {
    definitionId: 'd0', valueId: 'v0', kind: 'definition', blockId, variableKey: null,
    sourceEntityId, origin: origin('definition', 'v0'), proof: proof(sourceDefinitionNodeId),
  };
}

function use({ sourceEntityId = 'n-use', blockId = 'b0' } = {}) {
  return {
    useId: 'u0', valueId: 'v0', blockId, sourceEntityId,
    origin: origin('use', 'u0'), proof: proof(),
  };
}

function ssa(definition, ssaUse = use()) {
  return { contractVersion: '2.0.0', functionId: 'function_issue_4534', definitions: [definition], uses: [ssaUse] };
}

test('#4534 ordinary definitions require an existing source node in their definition block', () => {
  const oneBlock = [{ id: 'b0', nodeIds: ['n-use'] }];
  assert.throws(
    () => validateSemanticSsa(
      ssa(ordinaryDefinition({ sourceEntityId: 'not-an-ir-node' })),
      irFor(oneBlock), cfgFor(oneBlock),
    ),
    /semantic-ssa-definition-source-node-not-in-ir/,
  );

  const twoBlocks = [{ id: 'b0', nodeIds: ['n-use'] }, { id: 'b1', nodeIds: ['n-def'] }];
  assert.throws(
    () => validateSemanticSsa(
      ssa(ordinaryDefinition({ sourceDefinitionNodeId: 'n-def' })),
      irFor(twoBlocks), cfgFor(twoBlocks, [['b0', 'b1']]),
    ),
    /semantic-ssa-definition-source-block-mismatch/,
  );
});

test('#4534 same-block ordinary definitions cannot skip def-before-use ordering', () => {
  const useBeforeDefinition = [{ id: 'b0', nodeIds: ['n-use', 'n-def'] }];
  assert.throws(
    () => validateSemanticSsa(
      ssa(ordinaryDefinition({ sourceDefinitionNodeId: 'n-def' })),
      irFor(useBeforeDefinition), cfgFor(useBeforeDefinition),
    ),
    /semantic-ssa-definition-after-use/,
  );

  const definitionBeforeUse = [{ id: 'b0', nodeIds: ['n-def', 'n-use'] }];
  assert.doesNotThrow(() => validateSemanticSsa(
    ssa(ordinaryDefinition({ sourceDefinitionNodeId: 'n-def' })),
    irFor(definitionBeforeUse), cfgFor(definitionBeforeUse),
  ));
});

test('#4534 builder definitions remain valid while synthetic kinds keep their explicit no-node policy', () => {
  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function_issue_4534',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n-def', 'n-use'], origin: origin('block:b0') }],
    values: [{
      id: 'v-def', kind: 'definition', machineType: bit64, definitionNodeId: 'n-def',
      sourceEntityId: 'semantic-value:v-def', origin: origin('value:v-def'),
    }],
    nodes: [
      { id: 'n-def', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v-def'], attributes: { value: 1 }, origin: origin('n-def') },
      { id: 'n-use', kind: 'return', blockId: 'b0', inputs: ['v-def'], outputs: [], origin: origin('n-use') },
    ],
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  };
  const blocks = [{ id: 'b0' }];
  const cfg = cfgFor(blocks);
  const built = buildSemanticSsa(ir, cfg);
  const builtDefinition = built.definitions.find((definition) => definition.kind === 'definition');
  assert.equal(builtDefinition.proof.sourceDefinitionNodeId, 'n-def');
  assert.doesNotThrow(() => validateSemanticSsa(built, ir, cfg));

  const syntheticDefinitions = ['entry', 'unknown', 'undef'].map((kind) => ({
    definitionId: `d-${kind}`, valueId: `v-${kind}`, kind, blockId: 'b0', variableKey: null,
    sourceEntityId: `synthetic-${kind}`, origin: origin(`synthetic:${kind}`, `v-${kind}`), proof: proof(),
  }));
  assert.doesNotThrow(() => validateSemanticSsa(
    { contractVersion: '2.0.0', functionId: 'function_issue_4534', definitions: syntheticDefinitions, uses: [] },
    irFor([{ id: 'b0', nodeIds: ['n-use'] }]), cfgFor([{ id: 'b0', nodeIds: ['n-use'] }]),
  ));
});

test('#4534 use source nodes are also membership-checked instead of silently skipping ordering', () => {
  const blocks = [{ id: 'b0', nodeIds: ['n-def'] }];
  assert.throws(
    () => validateSemanticSsa(
      ssa(ordinaryDefinition({ sourceDefinitionNodeId: 'n-def' }), use({ sourceEntityId: 'not-an-ir-node' })),
      irFor(blocks), cfgFor(blocks),
    ),
    /semantic-ssa-use-source-node-not-in-ir/,
  );
});
