import assert from 'node:assert/strict';
import test from 'node:test';

import { FAMILY, GROUP, fuse, decide, adapterEvidence, ADAPTER_EVIDENCE } from '../js/evidence.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';

test('#5972 raw items with unregistered codes cannot forge confirmed evidence', () => {
  assert.throws(
    () => fuse([
      { code: 'made-up-metadata', family: FAMILY.NAME, kind: 'fact', id: true, strength: 1, lr: 1e9 },
      { code: 'runtime-made-up', family: FAMILY.VERIFIED, kind: 'verified', id: true, strength: 1, lr: 4000 },
      { code: 'cfg-made-up', family: FAMILY.NAMING, kind: 'fact', id: true, strength: 1, lr: 1e5 },
    ]),
    (err) => err instanceof TypeError && /unregistered-evidence-code:made-up-metadata/.test(err.message),
  );
});

test('#5972 raw items cannot override authority of a registered code', () => {
  // 'fn-numeric' is a weak corroborating fact in the table; a raw item claiming
  // kind 'verified' + id:true must not adopt those claims. (lr stays the
  // caller-supplied measured channel for registered codes, bounded by the
  // family cap; family/kind/id authority is always re-derived from the table.)
  const fusion = fuse([
    { code: 'fn-numeric', family: FAMILY.VERIFIED, kind: 'verified', id: true, strength: 1, lr: 1e9 },
  ]);
  const item = fusion.items.find((it) => it.code === 'fn-numeric');
  assert.equal(item.family, FAMILY.USAGE);
  assert.equal(item.kind, 'fact');
  assert.equal(item.id, false);
  // Family-cap authority still bounds the inflated measured LR (USAGE cap 30).
  assert.ok(item.applied <= Math.log(30) + 1e-9);
});

test('#5972 registered codes keep table lr when caller omits it', () => {
  const fusion = fuse([{ code: 'field-name-asked' }]);
  const item = fusion.items.find((it) => it.code === 'field-name-asked');
  assert.equal(item.lr, 400);
  assert.equal(item.family, FAMILY.NAME);
  assert.equal(item.id, true);
});

test('#5972 the issue 3-item confirmed repro cannot be rebuilt from registered codes either', () => {
  // Even with table-registered codes, the caller cannot claim kind/id authority;
  // the confirm gate (independent groups + verified + margin) must still hold.
  const fusion = fuse([
    { code: 'field-name-asked' },
    { code: 'rmw-verified' },
    { code: 'loc-drain-verified' },
  ]);
  const decision = decide([
    { fusion },
    { fusion: { logOdds: -20, probability: 1e-9, verified: 0, identifying: 0 } },
  ]);
  assert.notEqual(decision.verdict, 'confirmed');
});

test('#5972 adapterEvidence rejects unregistered codes', () => {
  assert.throws(
    () => adapterEvidence('runtime-made-up', 1, {}),
    (err) => err instanceof TypeError && /unregistered-adapter-evidence-code/.test(err.message),
  );
});

test('#5972 adapterEvidence is typed and keeps the contract authority', () => {
  const item = adapterEvidence('runtime-field-verified', 0.5, { address: 0x1000 }, 18);
  assert.equal(item.code, 'runtime-field-verified');
  assert.equal(item.family, FAMILY.VERIFIED);
  assert.equal(item.kind, 'verified');
  assert.equal(item.id, false);
  assert.equal(item.lr, 18);
  const fallback = adapterEvidence('semantic-ir-observation', 1, {});
  assert.equal(fallback.family, FAMILY.USAGE);
  assert.equal(fallback.kind, 'semantic');
  assert.equal(fallback.id, false);
});

test('#5972 semantic/runtime adapter items still fuse with their contract authority', () => {
  const semantic = semanticEvidenceItems([
    { kind: 'reads-field', confidence: 0.8, evidence: [{ id: 'ir-1', row: 3 }] },
  ], {});
  assert.equal(semantic.length, 1);
  assert.equal(semantic[0].code, 'semantic-ir-observation');

  const runtime = runtimeEvidenceItems({
    ok: true,
    touchedFields: [{ address: 0x1000 }],
    takenBranches: [{ address: 0x1004 }],
  }, { strength: 1, lr: 18 });
  assert.equal(runtime.length, 2);

  const fusion = fuse([...semantic, ...runtime]);
  assert.ok(fusion.verified >= 1);
  assert.ok(fusion.independentGroups >= 1);
});

test('#5972 ADAPTER_EVIDENCE table is frozen and complete for emitted codes', () => {
  assert.equal(Object.isFrozen(ADAPTER_EVIDENCE), true);
  for (const code of ['semantic-ir-proof', 'semantic-ir-observation', 'runtime-field-verified', 'runtime-branch-verified']) {
    assert.ok(Object.hasOwn(ADAPTER_EVIDENCE, code));
  }
});
