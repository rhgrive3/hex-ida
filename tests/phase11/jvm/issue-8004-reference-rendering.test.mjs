import assert from 'node:assert/strict';

import { decompileManagedMethod } from '../../../js/managed/shared/bridge.js';

function renderReference(valueType, constant) {
  const valueId = `v_${valueType.replace(/[^a-z0-9]+/gi, '_')}`;
  const constNodeId = `n_${valueType.replace(/[^a-z0-9]+/gi, '_')}`;
  const returnNodeId = `${constNodeId}_return`;
  const blockId = 'entry';
  return decompileManagedMethod({
    methodId: `issue_8004_${valueType.replace(/[^a-z0-9]+/gi, '_')}`,
    frontendId: 'jvm',
    semanticIr: {
      nodes: [
        { id: constNodeId, kind: 'const', inputs: [], outputs: [valueId], metadata: {} },
        { id: returnNodeId, kind: 'return', inputs: [valueId], outputs: [], metadata: {} },
      ],
      values: [{
        id: valueId,
        definitionNodeId: constNodeId,
        machineType: { kind: 'address', widthBits: 64, addressSpace: 'managed-heap' },
        metadata: { valueType, constant },
      }],
      blocks: [{ id: blockId, nodeIds: [constNodeId, returnNodeId] }],
    },
    cfg: { blocks: [{ id: blockId, successors: [] }] },
    ssa: {},
  }).pseudocode;
}

const stringCode = renderReference('string', 'literal');
assert.match(stringCode, /return "literal";/, `String must remain literal syntax: ${stringCode}`);

for (const [valueType, constant, wrapper] of [
  ['class', 'java/lang/String', 'jvm_class_ref'],
  ['method-type', '(ID)V', 'jvm_method_type_ref'],
  ['method-handle', 'Owner.run:()V', 'jvm_method_handle_ref'],
]) {
  const code = renderReference(valueType, constant);
  assert.ok(
    code.includes(`${wrapper}(${JSON.stringify(constant)})`),
    `${valueType} must retain an explicit typed reference form: ${code}`,
  );
  assert.ok(
    !code.includes(`return ${JSON.stringify(constant)};`),
    `${valueType} must not collapse to Java String-literal syntax: ${code}`,
  );
}

console.log('issue-8004 JVM reference rendering regression: PASS');
