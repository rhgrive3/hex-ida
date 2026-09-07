import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, MK } from '../../../js/ir-base.js';
import {
  TRANSLATION_STATUS,
  ASSUMPTION_TRUST,
  COMPLETENESS_STATUS,
  classifyOpSupport,
  createAssumption,
  createCompleteness,
} from '../../../js/symbolic/translate/support-matrix.js';

test('support matrix correctly classifies exact, exact-with-assumptions, and unsupported operations', () => {
  // Exact operations
  assert.equal(classifyOpSupport(OP.CONST), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.MOV), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.ADDR), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.BIN, { subOp: 'add' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.UN, { subOp: 'not' }), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.CMP), TRANSLATION_STATUS.EXACT);
  assert.equal(classifyOpSupport(OP.SEL), TRANSLATION_STATUS.EXACT);

  // A structural reachingStore pointer is not a MemorySSA value proof. It must
  // remain conservative even when the location is named.
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.STACK, key: 'sp+8' }, reachingStore: { id: 's1' } }),
    TRANSLATION_STATUS.UNSUPPORTED
  );

  // Shape-compatible payloads are not capabilities published by the canonical
  // MemorySSA query, so a downstream consumer must reject this forged fact.
  assert.equal(
    classifyOpSupport(OP.LOAD, {
      loc: { kind: MK.STACK, key: 'sp+8' },
      memoryForwarding: {
        status: 'exact', exact: true, reason: null, completeness: 'complete',
        proofKind: 'canonical-memoryssa-byte-forwarding', proofVersion: '1.0.0',
        artifactDigest: 'artifact-digest',
        identity: { digest: 'proof-digest' },
        widthBits: 16, endian: 'little', value: 0x1122n, bytes: [0x22, 0x11],
        contributingDefinitionIds: ['m1'],
        provenance: { sourceEntityIds: ['n_store'], definitionOrigins: [{}] },
      },
    }),
    TRANSLATION_STATUS.UNSUPPORTED
  );

  // A named location without a unique reaching store is not proof-safe.
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.STACK, key: 'sp+8' } }),
    TRANSLATION_STATUS.UNSUPPORTED
  );

  // Unknown memory location load is unsupported
  assert.equal(
    classifyOpSupport(OP.LOAD, { loc: { kind: MK.UNKNOWN } }),
    TRANSLATION_STATUS.UNSUPPORTED
  );

  // Side-effecting / unsupported ops
  assert.equal(classifyOpSupport(OP.STORE), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.CALL), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.CLOBBER), TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(classifyOpSupport(OP.UNKNOWN), TRANSLATION_STATUS.UNSUPPORTED);
});

test('assumptions enforce explicit taxonomy and trust classification', () => {
  const fact = createAssumption({
    id: 'a1',
    kind: 'memory-reaching-def',
    statement: 'stack load reaching store proven',
    source: 'dataflow',
    originIds: ['row:10', 'row:12'],
    trust: ASSUMPTION_TRUST.SEMANTIC_FACT,
  });
  assert.equal(fact.id, 'a1');
  assert.equal(fact.trust, 'semantic-fact');
  assert.deepEqual(fact.originIds, ['row:10', 'row:12']);

  assert.throws(
    () => createAssumption({ id: 'a2', kind: 'test', statement: 'stmt', trust: 'invalid-trust' }),
    TypeError
  );
});

test('completeness dimensions model all 5 critical verification axes', () => {
  const complete = createCompleteness();
  assert.equal(complete.translation, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.controlFlow, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.memoryEffects, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.pathCoverage, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(complete.queryScope, COMPLETENESS_STATUS.COMPLETE);

  const partial = createCompleteness({ translation: COMPLETENESS_STATUS.PARTIAL });
  assert.equal(partial.translation, COMPLETENESS_STATUS.PARTIAL);
});
