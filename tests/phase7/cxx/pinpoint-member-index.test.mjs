import test from 'node:test';
import assert from 'node:assert/strict';
import { CxxMemberIndex, isCxxMemberField } from '../../../js/analysis/cxx/member-index.js';
import { createCppReceiverEvidence, createCppMemberEvidence } from '../../../js/analysis/cxx/object-evidence.js';
import { createCxxEvidenceProvider } from '../../../js/analysis/cxx/project.js';

function receiver(overrides = {}) {
  return createCppReceiverEvidence({ functionId: 'fn_1', functionAddress: 0x1000n,
    canonicalValueId: 'arg0', receiverRole: 'this', classIdentity: { kind: 'named', className: 'Thing' },
    nonStaticProof: { rule: 'vtable-slot', isStatic: false },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    snapshotId: 'binary:0', completeness: 'complete', ...overrides });
}
function member(owner, overrides = {}) {
  return createCppMemberEvidence({ functionId: owner.functionId, receiverDigest: owner.digest,
    snapshotId: owner.snapshotId, offsetBytes: 8n, sizeBytes: 4,
    category: 'int32', typeLabel: 'int32_t|uint32_t', rule: 'word-access',
    readCount: 1, writeCount: 0, ...overrides });
}
const publish = (index, owner, members) => index.publish({ receiver: owner, members });
const all = (index) => [...index.classes.values()].flatMap((cls) => cls.ivars);

test('named and unnamed members preserve owner, location, type and canonical sources', () => {
  const owner = receiver(), index = new CxxMemberIndex();
  publish(index, owner, [member(owner, { memberName: 'health' }), member(owner, { offsetBytes: 12n })]);
  assert.equal(index.classCount, 1);
  assert.equal(index.fieldCount, 2);
  const [named, unnamed] = all(index);
  assert.equal(named.name, 'health');
  assert.equal(unnamed.name, 'member_0xc');
  assert.equal(named.classIdentity.className, 'Thing');
  assert.deepEqual(named.type, { kind: 'int', bytes: 4 });
  assert.equal(named.recoveredType.label, 'int32_t|uint32_t');
  assert.equal(named.provenance[0].receiver, owner);
  assert.ok(isCxxMemberField(named, index.classInfo('Thing')));
  assert.equal(index.classInfo('Thing').byOffset.get(8), named);
});

test('same field name in distinct classes and snapshots never collides', () => {
  const index = new CxxMemberIndex();
  for (const name of ['Thing', 'Other', 'a#b@8']) {
    const owner = receiver({ classIdentity: { kind: 'named', className: name } });
    publish(index, owner, [member(owner, { memberName: 'health' })]);
  }
  const other = new CxxMemberIndex(), owner = receiver({ snapshotId: 'binary:1' });
  publish(other, owner, [member(owner, { memberName: 'health' })]);
  const keys = [...all(index), ...all(other)].map((iv) => iv.key);
  assert.equal(new Set(keys).size, 4);
});

test('different offsets, widths, types and signedness remain distinct; conflicts stay explicit', () => {
  const owner = receiver(), index = new CxxMemberIndex();
  publish(index, owner, [member(owner), member(owner, { offsetBytes: 12n }),
    member(owner, { sizeBytes: 8, category: 'double', typeLabel: 'double' }),
    member(owner, { category: 'float', typeLabel: 'float' }),
    member(owner, { signedness: true, typeLabel: 'int32_t' })]);
  assert.equal(index.fieldCount, 5);
  assert.equal(new Set(all(index).map((iv) => iv.key)).size, 5);
  assert.ok(all(index).filter((iv) => iv.offset === 8).every((iv) => iv.conflict));
  assert.equal(index.classInfo('Thing').byOffset.get(8), null);
  assert.equal(all(index).at(-1).type.signed, true);
  const unsigned = member(owner, { offsetBytes: 24n, signedness: false });
  publish(index, owner, [unsigned]);
  assert.equal(all(index).at(-1).type.signed, false);
});

test('partial RTTI retains a named receiver; unknown type stays unknown and pointer alternatives stay explicit', () => {
  const owner = receiver(), index = new CxxMemberIndex();
  publish(index, owner, [member(owner, { category: null, typeLabel: null, rule: null, reason: 'unknown-type' }),
    member(owner, { offsetBytes: 16n, sizeBytes: 8, category: 'int64', typeLabel: 'int64_t|uint64_t|pointer',
      categoryCandidates: ['int64_t', 'uint64_t', 'pointer'], widthOnly: true })]);
  assert.ok(all(index).every((iv) => iv.type.kind === 'unknown'));
  assert.equal(all(index)[1].recoveredType.candidates.includes('pointer'), true);
});

test('distinct functions dedupe the member and retain sources; exact repeated publication is inert', () => {
  const first = receiver(), second = receiver({ functionId: 'fn_2', functionAddress: 0x2000n }), index = new CxxMemberIndex();
  publish(index, first, [member(first)]);
  const key = all(index)[0].key;
  publish(index, second, [member(second)]);
  assert.equal(index.fieldCount, 1);
  assert.equal(all(index)[0].key, key);
  assert.equal(all(index)[0].provenance.length, 2);
  const revision = index.revision;
  assert.equal(publish(index, second, [member(second)]), false);
  assert.equal(index.revision, revision);
});

test('large repeated histories have bounded provenance and accurate dedupe without reanalysis', () => {
  const index = new CxxMemberIndex();
  for (let i = 0; i < 256; i++) {
    const owner = receiver({ functionId: `fn_${i}`, functionAddress: BigInt(0x1000 + i * 4) });
    publish(index, owner, [member(owner)]);
  }
  assert.equal(index.fieldCount, 1);
  assert.equal(all(index)[0].provenance.length, 64);
  assert.equal(all(index)[0].provenanceCount, 256);
  assert.equal(all(index)[0].readCount, 256);
  assert.equal(all(index)[0].provenanceTruncated, true);
});

test('anonymous classes require structural owner identity and cannot collide with a named display label', () => {
  const index = new CxxMemberIndex();
  const missing = receiver({ classIdentity: { kind: 'anonymous' } });
  assert.equal(publish(index, missing, [member(missing)]), false);
  const anonymous = receiver({ classIdentity: { kind: 'anonymous', vtableAddress: 0x100n } });
  publish(index, anonymous, [member(anonymous)]);
  const named = receiver({ classIdentity: { kind: 'named', className: 'anonymous@vtable:0x100' } });
  publish(index, named, [member(named)]);
  assert.equal(index.classCount, 2);
  assert.equal(new Set(all(index).map((iv) => iv.key)).size, 2);
  assert.equal(index.classInfo('anonymous@vtable:0x100'), null);
});

test('no-proof, forged and misbound evidence fail closed without binding an empty index', () => {
  const owner = receiver(), index = new CxxMemberIndex(), canonical = member(owner);
  for (const bad of [null, {}, { receiver: {}, members: [canonical] },
    { receiver: structuredClone(owner), members: [canonical] },
    { receiver: owner, members: [structuredClone(canonical)] },
    { receiver: owner, members: [member(owner, { functionId: 'other' })] },
    { receiver: owner, members: [member(owner, { snapshotId: 'other' })] },
    { receiver: owner, members: [member(owner, { receiverDigest: 'other' })] }]) {
    assert.equal(index.publish(bad), false);
  }
  assert.equal(index.snapshotId, null);
  assert.equal(index.fieldCount, 0);
  assert.equal(isCxxMemberField({ ...canonical, source: 'cxx' }), false);
});

test('unsupported mixed widths/indexing/unsafe offsets are withheld; clear expires publication', () => {
  const owner = receiver(), index = new CxxMemberIndex();
  for (const overrides of [{ mixedWidths: true }, { indexed: true }, { offsetBytes: 2n ** 54n }, { sizeBytes: 0 }]) {
    assert.equal(publish(index, owner, [member(owner, overrides)]), false);
  }
  publish(index, owner, [member(owner)]);
  const revision = index.revision;
  index.clear();
  assert.equal(index.fieldCount, 0);
  assert.equal(index.classCount, 0);
  assert.ok(index.revision > revision);
});

test('malformed RTTI reads cannot manufacture class/member candidates', async () => {
  const provider = createCxxEvidenceProvider({ symbols: { addrs: [0x100n], names: ['_ZTV6Broken'] },
    read: async () => new Uint8Array(1), architecture: 'arm64' });
  await provider.build();
  assert.equal(provider.projectForFunction({ functionAddress: 0x1000n, functionName: '_ZN6Broken4tickEv', ir: {} }), null);
  assert.equal(provider.memberIndex().fieldCount, 0);
});
