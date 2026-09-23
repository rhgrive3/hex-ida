// Focused regressions for canonical member (field) evidence.
//
// The projection seam can now hand a consumer `this + 0x38 -> int32_t|uint32_t`.
// That is a claim about a type, so it needs the same treatment as `this` itself:
// only the producer may issue it, a label may never exist without the rule that
// proved it, and a record may not travel to a function or receiver it was not
// derived from. These tests pin exactly those boundaries — they are the reason a
// decompiler can render a type category without being able to invent one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCppMemberEvidence,
  createCppReceiverEvidence,
  isCanonicalCppMemberEvidence,
} from '../../../js/analysis/cxx/object-evidence.js';
import { normalizeCxxEvidenceInput } from '../../../js/analysis/cxx/project.js';

function receiver(functionId = 'sub_1000', canonicalValueId = 1) {
  return createCppReceiverEvidence({
    functionId,
    canonicalValueId,
    receiverRole: 'this',
    nonStaticProof: { rule: 'constructor-has-this' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-member',
  });
}

function member(overrides = {}) {
  return createCppMemberEvidence({
    functionId: 'sub_1000',
    receiverDigest: receiver().digest,
    snapshotId: 'snap-member',
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    rule: 'word-access',
    widthOnly: true,
    readCount: 1,
    writeCount: 0,
    ...overrides,
  });
}

test('a member record is producer-bound and not copyable', () => {
  const record = member();
  assert.equal(isCanonicalCppMemberEvidence(record), true);
  assert.equal(isCanonicalCppMemberEvidence({ ...record }), false);
  assert.equal(isCanonicalCppMemberEvidence(structuredClone(record)), false);
  assert.equal(isCanonicalCppMemberEvidence(null), false);
  assert.equal(record.schema, 'cpp-canonical-member-evidence/v1');
  assert.equal(record.accessProven, true);
  assert.equal(record.typeProven, true);
  // A type is never a name: the record has no field-name column at all.
  assert.equal('name' in record, false);
  assert.equal('fieldName' in record, false);
});

test('a type label and its category must agree in both directions', () => {
  assert.throws(() => member({ category: null }), /cpp-member-type-and-category-must-agree/);
  assert.throws(() => member({ typeLabel: null }), /cpp-member-type-and-category-must-agree/);
});

test('a proven type must cite its rule and an unproven member its reason', () => {
  assert.throws(() => member({ rule: null }), /cpp-member-rule-required/);

  const unproven = member({
    category: null,
    typeLabel: null,
    rule: null,
    reason: 'mixed-access-widths',
    mixedWidths: true,
  });
  assert.equal(unproven.typeProven, false);
  assert.equal(unproven.rule, null);
  assert.equal(unproven.reason, 'mixed-access-widths');
  assert.equal(unproven.accessProven, true, 'an unproven type is still a proven offset');

  assert.throws(() => member({ category: null, typeLabel: null, rule: null, reason: null }),
    /cpp-member-unproven-reason-required/);
});

test('a member record requires a real access, identity, and a bounded offset and size', () => {
  assert.throws(() => member({ readCount: 0, writeCount: 0 }), /cpp-member-access-count-required/);
  assert.throws(() => member({ receiverDigest: null }), /cpp-member-receiver-digest-required/);
  assert.throws(() => member({ functionId: '' }), /cpp-member-function-id-required/);
  assert.throws(() => member({ snapshotId: null }), /cpp-member-snapshot-id-required/);
  assert.throws(() => member({ offsetBytes: -8n }), /cpp-member-offset-invalid/);
  assert.throws(() => member({ sizeBytes: 65 }), /cpp-member-size-invalid/);
  assert.throws(() => member({ sizeBytes: -1 }), /cpp-member-size-invalid/);
});

test('the consumer gate drops a look-alike member record', () => {
  const canonical = member();
  const forged = { ...canonical };
  const normalized = normalizeCxxEvidenceInput({ receiver: receiver(), members: [forged, canonical] });
  assert.ok(normalized);
  assert.deepEqual(normalized.members, [canonical],
    'only the producer-issued record may reach a consumer');
});

test('a canonical member is dropped when it is not bound to the accepted receiver', () => {
  const record = member();
  const other = receiver('sub_2000', 7);
  assert.notEqual(other.digest, record.receiverDigest);

  const mismatched = normalizeCxxEvidenceInput({ receiver: other, members: [record] });
  assert.ok(mismatched);
  assert.deepEqual(mismatched.members, []);

  const matched = normalizeCxxEvidenceInput({ receiver: receiver(), members: [record] });
  assert.deepEqual(matched.members, [record]);
});

test('a member set without a proven receiver is never accepted on its own', () => {
  const record = member();
  // Members cannot stand in for the receiver: without one there is nothing for
  // them to be member *of*, so the whole evidence value is rejected.
  assert.equal(normalizeCxxEvidenceInput({ members: [record] }), null);

  const accepted = normalizeCxxEvidenceInput({ receiver: receiver(), members: [record] });
  assert.deepEqual(accepted.members, [record]);
});
