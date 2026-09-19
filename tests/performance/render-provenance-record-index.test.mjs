import assert from 'node:assert/strict';
import test from 'node:test';

import { RENDER_PROVENANCE_VERSION, validateRenderProvenance } from '../../js/decompiler/phase8/render-provenance.js';

const emptyOrigin = Object.freeze({
  addresses:Object.freeze([]), rows:Object.freeze([]), ir:Object.freeze([]),
  ssaDefs:Object.freeze([]), ssaUses:Object.freeze([]),
});

function frozenObservedRefs(values, counter) {
  const target = [...values];
  const proxy = new Proxy(target, {
    get(array, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) counter.reads++;
      return Reflect.get(array, property, receiver);
    },
  });
  Object.freeze(proxy);
  return proxy;
}

function groupedFixture(groups = 80, paddingEntities = 240) {
  const counter = { reads:0 };
  const ledger = [];
  const entities = {};
  for (let index = 0; index < groups; index++) {
    const refs = [`entity_${index}_a`, `entity_${index}_b`];
    const witnesses = refs.map((ref, offset) => Object.freeze({
      kind:'expression-rewrite', rule:'compact-public-state', phase:'compatibility-projection',
      before:'suppress-unused-entry-state:0:x', after:'x',
      proof:'observed-state-compaction-not-equivalence', version:RENDER_PROVENANCE_VERSION,
      sourceRecordIndex:index * 2 + offset,
      originHistory:Object.freeze({ scope:'replacement-expression-source', completeness:'complete',
        consumedRefs:Object.freeze([]), producedRefs:Object.freeze([]), elidedRefs:Object.freeze([]) }),
      origin:emptyOrigin, producedRefs:Object.freeze([ref]), removedRefs:Object.freeze([]), renderedBinding:'producer-bound',
    }));
    ledger.push(Object.freeze({
      kind:'state-consumer-group', rule:'compact-public-state', phase:'compatibility-projection',
      before:'suppress-unused-entry-state:0:x', after:'x', proof:'observed-state-event-with-distinct-consumers',
      valueId:null, version:RENDER_PROVENANCE_VERSION, targets:Object.freeze([]), removedRefs:Object.freeze([]),
      origin:emptyOrigin, consumerWitnesses:Object.freeze(witnesses), producedRefs:Object.freeze(refs),
    }));
    for (const ref of refs) entities[ref] = Object.freeze({
      entityKey:ref, recordRefs:frozenObservedRefs([index], counter), complete:true, reasons:Object.freeze([]),
    });
  }
  for (let index = 0; index < paddingEntities; index++) {
    const ref = `padding_${index}`;
    entities[ref] = Object.freeze({ entityKey:ref, recordRefs:frozenObservedRefs([], counter), complete:true, reasons:Object.freeze([]) });
  }
  Object.freeze(entities); Object.freeze(ledger);
  return {
    counter,
    map:Object.freeze({
      version:RENDER_PROVENANCE_VERSION, entities, ledger, reasons:Object.freeze([]),
      budget:Object.freeze({ maxConsumerWitnesses:groups * 2 + 1, truncated:false }),
      counts:Object.freeze({ sourceRecordWitnesses:groups * 2, transformRecords:groups,
        attachedPublicStateNormalizations:0, groupedExpressionWitnesses:groups,
        expressionConsumerWitnesses:groups * 2, provenanceLoss:0 }),
    }),
  };
}

test('render provenance validation indexes immutable entity record refs once for grouped consumers', () => {
  const { map, counter } = groupedFixture();
  const result = validateRenderProvenance(map);
  assert.equal(result.state, 'complete', result.reasons.join(','));
  // Legacy validation rescanned every entity for each of 80 groups and performs
  // >12k indexed reads of one-element recordRefs arrays. The immutable reverse
  // index plus the two direct witness checks per group stays comfortably linear.
  assert.ok(counter.reads < 1000, `recordRefs performed ${counter.reads} indexed reads`);
});
