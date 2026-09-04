/**
 * #6216 regression: concurrent turns must not share `this.*Store` execution
 * authority.
 *
 * NOTE: js/ai/control/runtime-support.js currently fails to import on main
 * (it names `canonicalBindingId`/`firstBinding` from snapshot.js, which does
 * not export them), so js/ai/runtime.js and turn-executor.js cannot be loaded
 * at runtime here. This test therefore verifies the fix structurally (the
 * turn body must use turn-local stores, never re-read the shared fields
 * across awaits) and proves the isolation pattern with the real store
 * classes, which load without that broken chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EvidenceStore } from '../js/ai/evidence.js';
import { HypothesisStore } from '../js/ai/hypothesis.js';
import { ProposalStore } from '../js/ai/proposals.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const turnSource = readFileSync(path.join(root, 'js/ai/control/turn-executor.js'), 'utf8');
const runtimeSource = readFileSync(path.join(root, 'js/ai/runtime.js'), 'utf8');

test('#6216 turn body captures turn-local stores', () => {
  assert.match(
    turnSource,
    /const evidenceStore = stores\.evidenceStore/,
    'executeTurn must capture a turn-local evidenceStore',
  );
  assert.match(
    turnSource,
    /const hypothesisStore = stores\.hypothesisStore/,
    'executeTurn must capture a turn-local hypothesisStore',
  );
  assert.match(
    turnSource,
    /const proposalStore = stores\.proposalStore/,
    'executeTurn must capture a turn-local proposalStore',
  );
});

test('#6216 turn body never re-reads shared fields as execution authority', () => {
  const authorityReads = [
    'this.evidenceStore.ingestPlan',
    'this.hypothesisStore.all()',
    'this.evidenceStore.byStatus',
    'this.evidenceStore.all()',
    'this.evidenceStore.get(',
    'this.evidenceStore.has(',
    'this.proposalStore.all()',
    'evidenceStore: this.evidenceStore',
    'hypotheses: this.hypothesisStore.all()',
  ];
  for (const pattern of authorityReads) {
    assert.equal(
      turnSource.includes(pattern),
      false,
      `turn body must not use shared field as execution authority: ${pattern}`,
    );
  }
});

test('#6216 finalize accepts turn-local stores', () => {
  assert.match(runtimeSource, /stores = null/, 'finalize must accept explicit turn-local stores');
  assert.match(
    runtimeSource,
    /stores\?\.evidenceStore \?\? this\.evidenceStore/,
    'finalize must prefer turn-local evidenceStore',
  );
  assert.match(
    runtimeSource,
    /stores\?\.hypothesisStore \?\? this\.hypothesisStore/,
    'finalize must prefer turn-local hypothesisStore',
  );
  assert.match(
    runtimeSource,
    /stores\?\.proposalStore \?\? this\.proposalStore/,
    'finalize must prefer turn-local proposalStore',
  );
});

test('#6216 turn-local pattern isolates namespaces under shared-field overwrite', async () => {
  const makeStores = () => {
    const evidenceStore = new EvidenceStore();
    const hypothesisStore = new HypothesisStore(evidenceStore);
    const proposalStore = new ProposalStore({ evidenceStore });
    return { evidenceStore, hypothesisStore, proposalStore };
  };
  const storesA = makeStores();
  const storesB = makeStores();
  // Simulate the fixed turn body: capture locals once, then run across an
  // await during which a concurrent turn rebinds the shared fields.
  const shared = {
    evidenceStore: storesA.evidenceStore,
    hypothesisStore: storesA.hypothesisStore,
    proposalStore: storesA.proposalStore,
  };
  const evidenceStore = storesA.evidenceStore;
  const hypothesisStore = storesA.hypothesisStore;
  await Promise.resolve();
  // Concurrent turn B rebinds the shared fields here.
  shared.evidenceStore = storesB.evidenceStore;
  shared.hypothesisStore = storesB.hypothesisStore;
  shared.proposalStore = storesB.proposalStore;
  await Promise.resolve();
  // Fixed code keeps using the captured locals.
  evidenceStore.add({
    sourceTool: 'test',
    kind: 'isolation-probe',
    status: 'supported',
    title: 'probe-A',
    summary: 'namespace A probe',
  });
  hypothesisStore.upsert({ status: 'open', claim: 'hyp-A claim', title: 'hyp-A' });
  assert.equal(storesA.evidenceStore.all().length, 1);
  assert.equal(storesB.evidenceStore.all().length, 0);
  assert.equal(storesA.hypothesisStore.all().length, 1);
  assert.equal(storesB.hypothesisStore.all().length, 0);
  // The buggy pattern (re-reading shared) would have written to B instead.
  const buggyWritesTo = (field) => field;
  assert.equal(buggyWritesTo(shared.evidenceStore), storesB.evidenceStore);
});
