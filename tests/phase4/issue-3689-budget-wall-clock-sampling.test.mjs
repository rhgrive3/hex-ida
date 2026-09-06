import assert from 'node:assert/strict';
import { createDynamicSymbolBudget } from '../../js/binary/dynamic-symbol-budget.js';
import { createRelocationBudget } from '../../js/binary/relocation-budget.js';
import { createPEMetadataBudget } from '../../js/binary/pe-loader-core.js';

function exhaustDynamicWithOddOperations() {
  let now = 0;
  const budget = createDynamicSymbolBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => now },
  });
  assert.equal(budget.step(1), true);
  now = 2;
  let ok = true;
  for (let i = 0; i < 2048 && ok; i++) ok = budget.step(2);
  assert.equal(ok, false);
  assert.equal(budget.stopped, true);
  assert.match(budget.reason, /wall-clock/);
  assert.equal(budget.snapshot().operations, 4097);
}

function exhaustRelocationWithOddOperations() {
  let now = 0;
  const budget = createRelocationBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => now },
  });
  assert.equal(budget.step(1), true);
  now = 2;
  let ok = true;
  for (let i = 0; i < 2048 && ok; i++) ok = budget.step(2);
  assert.equal(ok, false);
  assert.equal(budget.stopped, true);
  assert.match(budget.reason, /decode time exceeds/);
  assert.equal(budget.snapshot().operations, 4097);
}

function exhaustPEWithOddOperations() {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const image = { metadata: {}, warnings: [] };
    const budget = createPEMetadataBudget(image, {
      limits: { wallClockMs: 1, operations: 100_000 },
    });
    assert.equal(budget.take({ operations: 1 }, 'seed'), true);
    now = 2;
    let ok = true;
    for (let i = 0; i < 512 && ok; i++) ok = budget.take({ operations: 2 }, 'work');
    assert.equal(ok, false);
    assert.equal(image.metadata.peMetadata.complete, false);
    assert.ok(image.metadata.peMetadata.reasons.includes('budget:wall-clock'));
    assert.equal(budget.used.operations, 1023);
  } finally {
    Date.now = realNow;
  }
}

function largeCrossingsStillSample() {
  let dynamicNow = 0;
  const dynamic = createDynamicSymbolBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => dynamicNow },
  });
  dynamicNow = 2;
  assert.equal(dynamic.step(5000), false);
  assert.match(dynamic.reason, /wall-clock/);

  let relocationNow = 0;
  const relocation = createRelocationBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => relocationNow },
  });
  relocationNow = 2;
  assert.equal(relocation.step(5000), false);
  assert.match(relocation.reason, /decode time exceeds/);

  const realNow = Date.now;
  let peNow = 0;
  Date.now = () => peNow;
  try {
    const image = { metadata: {}, warnings: [] };
    const pe = createPEMetadataBudget(image, {
      limits: { wallClockMs: 1, operations: 100_000 },
    });
    peNow = 2;
    assert.equal(pe.take({ operations: 1025 }, 'large-crossing'), false);
    assert.ok(image.metadata.peMetadata.reasons.includes('budget:wall-clock'));
    assert.equal(pe.used.operations, 0);
  } finally {
    Date.now = realNow;
  }
}

function unitIncrementsStillSample() {
  let dynamicNow = 0;
  const dynamic = createDynamicSymbolBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => dynamicNow },
  });
  assert.equal(dynamic.step(1), true);
  dynamicNow = 2;
  let dynamicOk = true;
  for (let i = 0; i < 4095 && dynamicOk; i++) dynamicOk = dynamic.step(1);
  assert.equal(dynamicOk, false);
  assert.equal(dynamic.snapshot().operations, 4096);

  let relocationNow = 0;
  const relocation = createRelocationBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => relocationNow },
  });
  assert.equal(relocation.step(1), true);
  relocationNow = 2;
  let relocationOk = true;
  for (let i = 0; i < 4095 && relocationOk; i++) relocationOk = relocation.step(1);
  assert.equal(relocationOk, false);
  assert.equal(relocation.snapshot().operations, 4096);

  const realNow = Date.now;
  let peNow = 0;
  Date.now = () => peNow;
  try {
    const image = { metadata: {}, warnings: [] };
    const pe = createPEMetadataBudget(image, {
      limits: { wallClockMs: 1, operations: 100_000 },
    });
    peNow = 2;
    let peOk = true;
    for (let i = 0; i < 1024 && peOk; i++) peOk = pe.take({ operations: 1 }, 'unit');
    assert.equal(peOk, false);
    assert.equal(pe.used.operations, 1023);
  } finally {
    Date.now = realNow;
  }
}

function crossingWithinTimeBudgetSucceeds() {
  const dynamic = createDynamicSymbolBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => 0 },
  });
  assert.equal(dynamic.step(5000), true);

  const relocation = createRelocationBudget({
    limits: { maxWallMs: 1, maxOperations: 100_000, now: () => 0 },
  });
  assert.equal(relocation.step(5000), true);

  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const image = { metadata: {}, warnings: [] };
    const pe = createPEMetadataBudget(image, {
      limits: { wallClockMs: 1, operations: 100_000 },
    });
    assert.equal(pe.take({ operations: 1025 }, 'within-time'), true);
    assert.equal(image.metadata.peMetadata.complete, true);
  } finally {
    Date.now = realNow;
  }
}

function operationHardLimitsRemainAuthoritative() {
  const dynamic = createDynamicSymbolBudget({
    limits: { maxWallMs: 10_000, maxOperations: 2, now: () => 0 },
  });
  assert.equal(dynamic.step(3), false);
  assert.match(dynamic.reason, /2 operations/);

  const relocation = createRelocationBudget({
    limits: { maxWallMs: 10_000, maxOperations: 2, now: () => 0 },
  });
  assert.equal(relocation.step(3), false);
  assert.match(relocation.reason, /2 operations/);

  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const image = { metadata: {}, warnings: [] };
    const pe = createPEMetadataBudget(image, {
      limits: { wallClockMs: 10_000, operations: 2 },
    });
    assert.equal(pe.take({ operations: 3 }, 'hard-limit'), false);
    assert.ok(image.metadata.peMetadata.reasons.includes('budget:hard-limit:operations'));
  } finally {
    Date.now = realNow;
  }
}

exhaustDynamicWithOddOperations();
exhaustRelocationWithOddOperations();
exhaustPEWithOddOperations();
largeCrossingsStillSample();
unitIncrementsStillSample();
crossingWithinTimeBudgetSucceeds();
operationHardLimitsRemainAuthoritative();

console.log('issue-3689-budget-wall-clock-sampling: PASS');
