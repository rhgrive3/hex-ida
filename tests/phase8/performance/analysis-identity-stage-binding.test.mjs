import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindAnalysisIdentityToIr,
  boundAnalysisIdentityForIr,
  canonicalAnalysisIdentity,
} from '../../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

test('Phase8 exact-stage identity binding is private to the exact IR object', () => {
  const f = fixture('exact-stage-identity-binding');
  f.block(0);
  const left = f.constant(1n, 64);
  const right = f.constant(2n, 64);
  f.binary('add', left, right, 64);
  f.ret();
  const ir = f.build();

  const resolved = canonicalAnalysisIdentity({ ir });
  assert.equal(resolved.valid, true);

  const binding = bindAnalysisIdentityToIr(ir, resolved);
  assert.ok(binding);
  assert.equal(boundAnalysisIdentityForIr(binding, ir), resolved);

  const clone = { ...ir };
  assert.equal(
    boundAnalysisIdentityForIr(binding, clone),
    null,
    'a cloned/different IR object must not inherit exact-source identity authority',
  );
  assert.equal(
    bindAnalysisIdentityToIr(ir, { valid:false, identity:resolved.identity }),
    null,
    'an invalid identity result cannot mint a private binding',
  );
});
