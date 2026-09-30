import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CxxMemberIndex } from '../../../js/analysis/cxx/member-index.js';
import { createCppReceiverEvidence, createCppMemberEvidence } from '../../../js/analysis/cxx/object-evidence.js';
import { pinpoint, pinpointField, pinpointFunction, rerankWithJev } from '../../../js/pinpoint.js';
import { FieldIndex } from '../../../js/fields.js';
import { parseGoal } from '../../../js/goals.js';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';
import { cxxMemberIndexForApp } from '../../../js/analysis/query/app-adapter.js';
import { composePinpointFields } from '../../../js/pinpoint-fields.js';
import { __investigationInternalsForTests } from '../../../js/analysis/investigation-service.js';
import { proofText } from '../../../js/narrate.js';
import { autoAnalyze } from '../../../js/auto.js';

function projection(className, members, address = 0x1000n) {
  const receiver = createCppReceiverEvidence({
    functionId: `fn_${address}`, functionAddress: address, canonicalValueId: 'arg0',
    receiverRole: 'this', classIdentity: { kind: 'named', className },
    nonStaticProof: { rule: 'vtable-slot', isStatic: false },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    snapshotId: 'test-binary:0', completeness: 'complete',
  });
  return { receiver, members: members.map((m) => createCppMemberEvidence({
    functionId: receiver.functionId, receiverDigest: receiver.digest,
    snapshotId: receiver.snapshotId, offsetBytes: 8n, sizeBytes: 4,
    category: 'int32', typeLabel: 'int32_t', rule: 'width-32',
    readCount: 1, writeCount: 0, ...m,
  })) };
}

test('canonical unnamed C++ members reach deterministic ranking without semantic names or new scans', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}, { offsetBytes: 12n }]));
  let analyses = 0;
  let scans = 0;
  const result = await pinpointField({ goal: parseGoal('health'), cxxFields,
    analyze: async () => { analyses++; throw new Error('unexpected analysis'); },
    scanAccess: async () => { scans++; throw new Error('unexpected scan'); }, limit: 400 });
  assert.equal(result.universe, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(analyses, 0);
  assert.equal(scans, 0);
  for (const c of result.candidates) {
    assert.equal(c.className, 'Thing');
    assert.match(c.field.name, /^(field|member)_/);
    assert.notEqual(c.field.name, 'health');
    assert.ok(c.classIdentity);
    assert.ok(c.provenance);
    assert.ok(Number.isFinite(c.fusion.logOdds));
    assert.ok(!c.evidence.some((e) => e.code === 'field-name-asked'));
    assert.equal(c.verified, false);
  }
  assert.ok(!['confirmed', 'likely'].includes(result.verdict));
  const seen = [];
  const reranked = await rerankWithJev('health', result, { enabled: true,
    client: { call: async ({ candidates }) => {
      seen.push(...candidates);
      return { selectedKey: candidates[1].key };
    } } });
  assert.equal(reranked.source, 'jev');
  assert.ok(result.candidates.includes(reranked.top1));
  assert.ok(seen.every((c) => result.candidates.includes(c)));
});

test('ObjC exact-name candidate retains its rank while unnamed C++ remains in the same lattice', async () => {
  const fields = new FieldIndex({ classes: [{ name: 'Thing', instanceSize: 32,
    ivars: [{ name: '_health', offset: 8, size: 4, type: { kind: 'int', bytes: 4 } }] }] });
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}]));
  const before = await pinpointField({ goal: parseGoal('health'), fields });
  const after = await pinpointField({ goal: parseGoal('health'), fields, cxxFields });
  assert.equal(after.top.key, before.top.key);
  assert.equal(after.top.probability, before.top.probability);
  assert.equal(after.candidates.length, 2);
  assert.equal(new Set(after.candidates.map((c) => c.key)).size, 2);
  assert.equal(after.candidates[1].source, 'cxx');
});

test('C++ keys remain disjoint from legacy ObjC keys even for separator-bearing binary names', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing#8#tail', [{ memberName: 'health' }]));
  const iv = [...cxxFields.classes.values()][0].ivars[0];
  // Construct the ObjC identity that collided with the previous C++ encoding.
  const oldKey = iv.key.replaceAll('\\u0023', '#');
  const [className, offset, name] = oldKey.split('#');
  const fields = new FieldIndex({ classes: [{ name: className, instanceSize: 32,
    ivars: [{ name, offset: Number(offset), size: 4, type: { kind: 'int', bytes: 4 } }] }] });
  assert.equal(`${className}#${offset}#${name}`, oldKey);
  assert.ok(!iv.key.includes('#'));
  assert.equal(JSON.parse(JSON.parse(iv.key.slice(4))[0])[2], 'Thing#8#tail');
  const result = await pinpointField({ goal: parseGoal(name), fields, cxxFields });
  assert.equal(result.candidates.length, 2);
  assert.equal(new Set(result.candidates.map((c) => c.key)).size, 2);
  assert.ok(result.candidates.some((c) => c.source === 'cxx'));
  assert.ok(result.candidates.some((c) => c.key === oldKey));
  cxxFields.publish(projection('Thing\\u00238\\u0023tail', [{ memberName: 'health' }]));
  assert.equal(new Set([...cxxFields.classes.values()].flatMap((cls) => cls.ivars.map((field) => field.key))).size, 2);
});

test('producer-supplied C++ names use existing deterministic evidence without creating another universe', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }, { offsetBytes: 12n }]));
  const result = await pinpointField({ goal: parseGoal('health'), cxxFields });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.top.memberName, 'health');
  assert.equal(result.top.anonymous, false);
  assert.ok(result.top.evidence.some((e) => e.code === 'access-verified' && e.detail.source === 'cxx'));
  assert.equal(result.top.provenance[0].member.memberName, 'health');
  assert.ok(result.candidates[1].anonymous);
});

test('the combined public Pinpoint entrypoint enumerates the same canonical C++ members', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }, { offsetBytes: 12n }]));
  const direct = await pinpointField({ goal: parseGoal('health'), cxxFields });
  const combined = await pinpoint({ goal: parseGoal('health'), cxxFields });
  assert.deepEqual(combined.field.candidates.map((c) => c.key), direct.candidates.map((c) => c.key));
  assert.equal(combined.field.top.field, direct.top.field);
});

test('automatic analysis can enumerate published C++ fields with no ObjC metadata or new analyzer', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }]));
  const report = await autoAnalyze({ cxxFields, deepLimit: 0 });
  assert.ok(report.stats.pinpointModes.field > 0);
  assert.ok(report.pinned.some((pin) => pin.top?.source === 'cxx' && pin.top.memberName === 'health'));
  assert.deepEqual(report.diagnostics, []);
});

test('an unrelated function touching the same offset cannot acquire a C++ class/member attribution', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Player', [{ memberName: 'health' }]));
  const goal = parseGoal('health');
  const ranked = [{ addr: 0x2000n, name: 'unrelated', reasons: [] }];
  let analyses = 0;
  const analyze = async () => {
    analyses++;
    return { basicBlocks: [], instructions: [{ row: 0, address: 0x2000n,
      mnemonic: 'str', ops: [], reads: [], writes: [],
      memory: { kind: 'store', base: 'x0', disp: 8n, size: 4 } }] };
  };
  const combined = await pinpoint({ goal, cxxFields, ranked, analyze });
  const direct = await pinpointFunction({ goal, ranked, analyze, field: combined.field.top });
  assert.ok(analyses > 0, 'existing function ranking still runs');
  assert.equal(combined.field.top.className, 'Player');
  for (const fn of [combined.function, direct]) {
    assert.equal(fn.candidates.length, 1);
    assert.ok(!fn.candidates[0].evidence.some((e) => e.detail?.className === 'Player'));
  }
});

test('synthetic labels cannot become recovered-name evidence or claim a semantic member name', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}, { offsetBytes: 12n }]));
  for (const query of ['member', 'member_0x8']) {
    const result = await pinpointField({ goal: parseGoal(query), cxxFields });
    assert.equal(result.candidates.length, 2);
    assert.ok(!['likely', 'confirmed'].includes(result.verdict));
    for (const c of result.candidates) {
      assert.equal(c.memberName, null);
      assert.equal(c.anonymous, true);
      assert.ok(!c.evidence.some((e) => /field-name|sibling-fields|access-verified/.test(e.code)));
    }
  }
});

test('a source flag cannot manufacture C++ candidates and C++ proof narration has no selector placeholder', async () => {
  const forged = { name: 'health', source: 'cxx', offset: 8, size: 4, type: { kind: 'int', bytes: 4 } };
  const fields = { classCount: 1, classes: new Map([['Fake', { name: 'Fake', ivars: [forged] }]]) };
  const result = await pinpointField({ goal: parseGoal('health'), fields });
  assert.equal(result.candidates.length, 0);
  const text = proofText({ code: 'access-verified', detail: { source: 'cxx', className: 'Thing', loads: 1, stores: 0 } });
  assert.ok(text.includes('Thing'));
  assert.ok(!text.includes('undefined'));
});

test('new member publication invalidates cached Pinpoint evidence coverage', () => {
  const goal = parseGoal('health');
  const cxxFields = new CxxMemberIndex();
  const internals = __investigationInternalsForTests;
  const before = internals.pinRequestIdentity({ cxxFields, cxxRevision: cxxFields.revision }, goal, {});
  cxxFields.publish(projection('Thing', [{}]));
  const after = internals.pinRequestIdentity({ cxxFields, cxxRevision: cxxFields.revision }, goal, {});
  assert.equal(internals.pinRequestMatches(before, after), false);
});

test('composing the lattice twice keeps one candidate and forged indexes cannot publish fields', async () => {
  const cxxFields = new CxxMemberIndex();
  cxxFields.publish(projection('Thing', [{}]));
  const once = composePinpointFields(null, cxxFields);
  const twice = composePinpointFields(once, cxxFields);
  assert.equal(twice.fieldCount, 1);
  assert.equal(twice.classCount, 1);
  const fake = Object.create(CxxMemberIndex.prototype);
  const empty = await pinpointField({ goal: parseGoal('health'), cxxFields: fake });
  assert.equal(empty.candidates.length, 0);
  assert.equal(composePinpointFields(null, fake), null);
});

test('production Fast decompile publishes existing C++ recovery to Pinpoint and expires with the binary epoch', async () => {
  const binary = fileURLToPath(new URL('../../fixtures/cxx-dwarf-holdout/holdout.stripped.elf', import.meta.url));
  const product = await openProduct(binary);
  try {
    assert.ok(!product.unsupported);
    assert.equal(cxxMemberIndexForApp(product.app), null);
    const snapshot = await product.query.snapshot();
    const index = product.app.symbols.names.indexOf('_ZNK5Thing6updateEi');
    assert.ok(index >= 0);
    await product.query.decompile(snapshot, product.app.symbols.addrs[index], { profile: 'fast' });
    const cxxFields = cxxMemberIndexForApp(product.app);
    assert.ok(cxxFields?.fieldCount >= 2);
    const result = await pinpointField({ goal: parseGoal('health'), fields: product.app.fields, cxxFields, limit: 400 });
    assert.ok(result.candidates.length >= 2);
    assert.ok(result.candidates.every((c) => c.className === 'Thing'));
    // Loading ObjC metadata on an ELF cannot erase published C++ evidence.
    await product.app.ensureObjc(product.sliceIndex);
    assert.equal(cxxMemberIndexForApp(product.app), cxxFields);
    product.app.backend.advanceEpoch();
    assert.equal(cxxMemberIndexForApp(product.app), null);
  } finally { await product.close(); }
});
