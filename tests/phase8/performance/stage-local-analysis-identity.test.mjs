import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalAnalysisIdentity,
  stageAnalysisIdentity,
} from '../../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

test('fresh stage-local identity is deterministic, mutation-sensitive, and separate from canonical identity', () => {
  const f = fixture('stage-local-identity');
  f.block(0);
  const left = f.constant(1n, 64);
  const right = f.constant(2n, 64);
  const sum = f.binary('add', left, right, 64);
  f.ret(sum);
  const ir = f.build();

  const canonical = canonicalAnalysisIdentity({ ir });
  const first = stageAnalysisIdentity({ ir });
  const second = stageAnalysisIdentity({ ir });

  assert.equal(canonical.valid, true);
  assert.equal(first.valid, true);
  assert.deepEqual(second, first);
  assert.equal(canonical.identity.analyzerVersion, 'phase8-analysis-v1');
  assert.equal(first.identity.analyzerVersion, 'phase8-stage-local-v1');
  assert.notDeepEqual(first.identity, canonical.identity);

  const before = first.identity;
  ir.blocks[0].insts[0].extra.stageMutation = 'changed';
  const after = stageAnalysisIdentity({ ir });
  assert.equal(after.valid, true);
  assert.notDeepEqual(after.identity, before,
    'a semantic mutation must change the stage-local identity');
});

test('stage-local identity falls back to canonical when explicit cross-object identity metadata is present', () => {
  const f = fixture('stage-local-explicit-fallback');
  f.block(0);
  f.ret(f.constant(7n, 32));
  const ir = f.build();
  const canonical = canonicalAnalysisIdentity({ ir });
  assert.equal(canonical.valid, true);

  const resolved = stageAnalysisIdentity({ ir, identity: canonical.identity });
  assert.deepEqual(resolved, canonical);
});
