import { deepFreeze } from '../../../js/core/identity/index.js';

// Fixed transport expectations, never inferred from the production lowering.
// The litmus references are separate whole-program, single-outcome evidence;
// they do not authorize arbitrary accesses with the same ordering label.
function orderingRecord(ordering, target = null, permitted = null) {
  const atomic = ordering !== 'unknown';
  return {
    id: `ordering-${ordering}`, kind: 'ordering', ordering,
    machineOrdering: atomic ? ordering : null,
    evidenceScope: 'contract-transport-only', expectedClassification: 'exact/equivalent',
    mustPreserve: {
      memory: [{ ordering, atomic }],
      memorySsa: [{ ordering, atomic, sequencing: { ordering, atomic } }],
      projectedMemory: [{ ordering, atomic }], undefinedResults: [], maskedOutputs: [],
    },
    mustForbid: ['ordering-loss-or-change', 'atomicity-change', 'unknown-to-known-upgrade'],
    litmus: target === null ? null : {
      artifactId: `arm64-a64-${ordering}-outcome`,
      sourcePath: `tests/machine-effects/fixtures/formal-source/aarch64-${ordering}.litmus`,
      permittedOutcomes: permitted ? [target] : [],
      forbiddenOutcomes: permitted ? [] : [target],
    },
  };
}

function undefinedRecord(resultClass, mask, condition = null) {
  const descriptor = {
    schemaVersion: 'machine-effects-undefined-result/v1',
    widthBits: 8, mask, class: resultClass, reason: `synthetic-contract-${resultClass}`,
    ...(condition === null ? {} : { condition }),
  };
  return {
    id: `undefined-${resultClass}`, kind: 'undefined', ordering: null, descriptor,
    evidenceScope: 'contract-transport-only', expectedClassification: 'exact/equivalent',
    mustPreserve: {
      // The masked add has two literal input nodes and one result node. Each
      // inherits the source descriptor and must project conservatively.
      memory: [], memorySsa: [], projectedMemory: [], undefinedResults: [descriptor, descriptor, descriptor],
      maskedOutputs: [0, 1, 2].map(() => ({ op: 'unknown', descriptor, concreteDestination: false })),
    },
    mustForbid: ['undefined-descriptor-loss', 'mask-or-condition-change', 'concrete-masked-output'],
    litmus: null,
  };
}

export const ORDERING_UNDEFINED_MATRIX = deepFreeze([
  orderingRecord('relaxed', 'target:ME01_relaxed_SB', true),
  orderingRecord('acquire', 'target:ME01_acquire_SB', true),
  orderingRecord('release', 'target:ME01_release_SB', true),
  orderingRecord('acq-rel', 'target:ME01_acq_rel_MP', false),
  orderingRecord('seq-cst', 'target:ME01_seq_cst_SB', false),
  orderingRecord('unknown'),
  undefinedRecord('fully', '0xff'),
  undefinedRecord('partial', '0xf0'),
  undefinedRecord('conditional', '0x80', { kind: 'synthetic-condition', operand: 'condition' }),
  undefinedRecord('operand-dependent', '0x0f', { kind: 'synthetic-operand-predicate', operand: 'count' }),
]);
