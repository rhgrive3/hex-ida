import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged } from '../../../js/ai/control/runtime-support.js';

const source = await readFile(new URL('../../../js/ai/control/turn-executor.js', import.meta.url), 'utf8');
const guard = 'assertLiveBindingsUnchanged(this.localContext, snapshot);';
const plannerBranch = source.indexOf('if (this.planner && shouldRunPlanner(request, snapshot, intent))');
const plannerAwait = source.indexOf('plan = await this.planner(', plannerBranch);
const ingest = source.indexOf('const plannedEvidence = this.evidenceStore.ingestPlan(plan);', plannerAwait);
const caughtDecision = source.indexOf('if (!decision) decision = deterministicDecision(plan, request, normalized);', ingest);
const finalize = source.indexOf('const result = this.finalize(', caughtDecision);

assert.ok(plannerBranch >= 0 && plannerAwait > plannerBranch && ingest > plannerAwait, 'planner path markers must remain discoverable');
assert.ok(
  source.slice(plannerBranch, plannerAwait).includes(guard),
  'live binding must be checked immediately before starting the deterministic planner',
);
assert.ok(
  source.slice(plannerAwait, ingest).includes(guard),
  'live binding must be rechecked after planner completion and before evidence ingestion',
);

const finalGuard = source.lastIndexOf(guard, finalize);
assert.ok(
  caughtDecision >= 0 && finalize > caughtDecision && finalGuard > caughtDecision,
  'live binding must be rechecked after planner/model error handling and before finalization',
);

const stable = { binaryHash: 'A', projectId: 'P1' };
const stableSnapshot = createTurnSnapshot(stable, {});
assert.doesNotThrow(() => assertLiveBindingsUnchanged(stable, stableSnapshot));

const binaryDrift = { binaryHash: 'A', projectId: 'P1' };
const binarySnapshot = createTurnSnapshot(binaryDrift, {});
binaryDrift.binaryHash = 'B';
assert.throws(
  () => assertLiveBindingsUnchanged(binaryDrift, binarySnapshot),
  (error) => error?.type === 'scope_violation',
  'binary drift must fail closed',
);

const projectDrift = { binaryHash: 'A', projectId: 'P1' };
const projectSnapshot = createTurnSnapshot(projectDrift, {});
projectDrift.projectId = 'P2';
assert.throws(
  () => assertLiveBindingsUnchanged(projectDrift, projectSnapshot),
  (error) => error?.type === 'scope_violation',
  'project drift must fail closed',
);

console.log('issue-4047-ai-planner-binding: ok');
