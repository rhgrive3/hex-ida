import assert from 'node:assert/strict';
import test from 'node:test';

import { FAMILY, fuse, decide, evidence, adapterEvidence, ADAPTER_EVIDENCE } from '../js/evidence.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';

test('#5972 raw items with unregistered codes cannot forge confirmed evidence', () => {
  assert.throws(
    () => fuse([
      { code: 'made-up-metadata', family: FAMILY.NAME, kind: 'fact', id: true, strength: 1, lr: 1e9 },
      { code: 'runtime-made-up', family: FAMILY.VERIFIED, kind: 'verified', id: true, strength: 1, lr: 4000 },
      { code: 'cfg-made-up', family: FAMILY.NAMING, kind: 'fact', id: true, strength: 1, lr: 1e5 },
    ]),
    (err) => err instanceof TypeError && /raw-evidence-item-rejected:made-up-metadata/.test(err.message),
  );
});

test('#5972 raw items cannot reach the fusion at all, even with a registered code', () => {
  assert.throws(
    () => fuse([{ code: 'fn-numeric', family: FAMILY.VERIFIED, kind: 'verified', id: true, strength: 1, lr: 1e9 }]),
    (err) => err instanceof TypeError && /raw-evidence-item-rejected:fn-numeric/.test(err.message),
  );
});

test('#5972 fuse re-derives authority from the code even for mutated factory items', () => {
  const item = evidence('fn-numeric');
  item.family = FAMILY.VERIFIED;
  item.kind = 'verified';
  item.id = true;
  const fusion = fuse([item]);
  const applied = fusion.items.find((it) => it.code === 'fn-numeric');
  assert.equal(applied.family, FAMILY.USAGE);
  assert.equal(applied.kind, 'fact');
  assert.equal(applied.id, false);
});

test('#5972 static evidence cannot mint adapter-only verified authority', () => {
  const fusion = fuse([evidence('runtime-field-verified', 1, {}, 18)]);
  const applied = fusion.items.find((it) => it.code === 'runtime-field-verified');
  assert.ok(applied, 'wrong-factory item remains weak evidence rather than gaining adapter authority');
  assert.equal(applied.family, FAMILY.CONTEXT);
  assert.equal(applied.kind, 'inference');
  assert.equal(applied.id, false);
  assert.equal(fusion.verified, 0);
});

test('#5972 post-mint code mutation cannot switch producer authority', () => {
  const item = evidence('fn-numeric');
  item.code = 'runtime-field-verified';
  assert.throws(
    () => fuse([item]),
    (err) => err instanceof TypeError && err.message === 'evidence-code-mutated',
  );
});

test('#5972 registered codes keep table lr when the factory receives none', () => {
  const fusion = fuse([evidence('field-name-asked')]);
  const item = fusion.items.find((it) => it.code === 'field-name-asked');
  assert.equal(item.lr, 400);
  assert.equal(item.family, FAMILY.NAME);
  assert.equal(item.id, true);
});

test('#5972 unregistered codes through the factory keep the weak default authority', () => {
  // shapes.js emits diagnostic codes that are not in the EVIDENCE table; the
  // factory defaults them to CONTEXT/inference/non-identifying and they stay inert.
  const fusion = fuse([evidence('loc-object-identity-unknown'), evidence('loc-scan-capped')]);
  assert.equal(fusion.items.length, 0, 'default lr 1 keeps unregistered codes inert');
  assert.equal(fusion.verified, 0);
  assert.equal(fusion.identifying, 0);
});

test('#5972 the confirm gate cannot be satisfied by made-up evidence', () => {
  const fusion = fuse([
    evidence('made-up-metadata', 1, {}, 1e9),
    evidence('runtime-made-up', 1, {}, 4000),
    evidence('cfg-made-up', 1, {}, 1e5),
  ]);
  const decision = decide([
    { fusion },
    { fusion: { logOdds: -20, probability: 1e-9, verified: 0, identifying: 0 } },
  ]);
  assert.notEqual(decision.verdict, 'confirmed');
  assert.notEqual(decision.verdict, 'likely');
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
