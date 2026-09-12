import assert from 'node:assert/strict';
import { ProductWorkspace, sameProjectIdentity, snapshotWorkspace } from '../js/workspace.js';
import { serializeHexProject, parseHexProject } from '../js/project/index.js';

console.log('Testing #4816: .hexproj structured slice metadata must not launder into live identity via String()...');

// The issue #4816 reproduction uses primitive live values.
const live = {
  hash: 'same-hash',
  metadata: { sliceIndex: 0, sliceOffset: 4096, sliceSize: 8192, uuid: 'ABCDEF', architecture: 'arm64' },
};

function binding(projectMetadata){
  return sameProjectIdentity({ binary: { hash: 'same-hash', metadata: projectMetadata } }, live);
}

// 1. The issue #4816 minimal counterexample: single-element arrays coerce to the
//    same string as the live primitive and must NOT bind.
const counterexample = binding({
  sliceIndex: ['0'],
  sliceOffset: ['4096'],
  sliceSize: ['8192'],
  uuid: ['ABCDEF'],
  architecture: ['arm64'],
});
assert.equal(counterexample.ok, false, 'structured-array metadata must never bind to the live slice identity');

// 2. Every identity field: structured / wrong-primitive values that survive a
//    String() coercion must fail closed instead of matching.
const coercionCandidates = {
  sliceIndex: [['0'], { toString: () => '0' }, [0], '0', true, false, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x100000000n],
  sliceOffset: [['4096'], { toString: () => '4096' }, [4096], '4096', true, 4096.5],
  sliceSize: [['8192'], { toString: () => '8192' }, [8192], '8192', false, 8192.5],
  uuid: [['ABCDEF'], { toString: () => 'ABCDEF' }, ['ABCDEF'.length], true, {}],
  architecture: [['arm64'], { toString: () => 'arm64' }, [1], true, {}],
};
for (const [field, values] of Object.entries(coercionCandidates)) {
  for (const value of values) {
    const meta = { ...live.metadata, [field]: value };
    const match = binding(meta);
    assert.equal(match.ok, false, `field ${field} with coercible value ${String(value)} must not bind`);
    assert.equal(match.reason, 'slice-identity-mismatch', `field ${field} structured/wrong-primitive value must fail closed as a mismatch`);
    assert.equal(match.field, field);
  }
}

// A numeric project value laundered into a primitive-string live field must fail closed.
assert.equal(binding({ ...live.metadata, uuid: 12345 }).ok, false, 'a number must not String-match a primitive uuid');
assert.equal(binding({ ...live.metadata, architecture: 1 }).ok, false, 'a number must not String-match an architecture string');

// 3. Genuine mismatch / incomplete metadata reason semantics must be preserved.
const genuineMismatch = binding({ ...live.metadata, sliceIndex: 1 });
assert.equal(genuineMismatch.ok, false);
assert.equal(genuineMismatch.reason, 'slice-identity-mismatch');
assert.equal(genuineMismatch.field, 'sliceIndex');

for (const field of ['sliceIndex', 'sliceOffset', 'sliceSize', 'uuid', 'architecture']) {
  const meta = { ...live.metadata };
  delete meta[field];
  const incomplete = binding(meta);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'slice-identity-incomplete', `missing project field ${field} keeps the incomplete reason`);
  assert.equal(incomplete.field, field);
}

// 4. Canonical project/live identity must keep binding (existing match behavior).
assert.deepEqual(binding(live.metadata), { ok: true }, 'exact primitive identity must still bind');
assert.deepEqual(
  binding({ ...live.metadata, sliceIndex: 0n, sliceOffset: 4096n, sliceSize: 8192n }),
  { ok: true },
  'primitive integer representations (bigint vs number) of the same slice must still bind',
);
assert.equal(
  sameProjectIdentity({ binary: { hash: 'other-hash', metadata: live.metadata } }, live).reason,
  'binary-hash-mismatch',
  'hash mismatch still short-circuits first',
);

// 5. Live fields that are absent impose no constraint, but a structured project
//    value must still not be laundered even on an otherwise-unconstrained field.
assert.deepEqual(
  sameProjectIdentity({ binary: { hash: 'same-hash', metadata: { sliceIndex: 0 } } }, { hash: 'same-hash', metadata: { sliceIndex: 0 } }),
  { ok: true },
  'a minimal canonical identity must still bind',
);
assert.equal(
  sameProjectIdentity(
    { binary: { hash: 'same-hash', metadata: { sliceIndex: 0, uuid: ['X'] } } },
    { hash: 'same-hash', metadata: { sliceIndex: 0 } },
  ).ok,
  false,
  'a structured uuid is rejected even though the live identity leaves uuid unconstrained',
);

// 6. End-to-end: the parser preserves the structured metadata, so the binding
//    gate must reject an imported .hexproj whose metadata would otherwise be
//    coerced, and no user state may be applied to the live binary.
class Storage { constructor(){ this.m = new Map(); } getItem(k){ return this.m.get(k) || null; } setItem(k, v){ this.m.set(k, String(v)); } }
class Notes {
  constructor(){ this.id = 'notes'; this.names = new Map(); this.comments = new Map(); this.types = new Map(); this.vars = new Map(); this.structs = []; this.lastSaveError = null; }
  nameEntries(){ return [...this.names].map(([k, name]) => ({ addr: BigInt(k), name })); }
  save(){ return true; }
}
class Patches { constructor(){ this.x = []; } clear(){ this.x = []; } list(){ return this.x.slice(); } add(offset, before, after, meta = {}){ this.x.push({ offset: BigInt(offset), before: [...before], after: [...after], ...meta }); } }
const region = { id: 'text', name: '__text', section: '__text', exec: true, vmAddr: 0x1000n, size: 0x1000n, fileOffset: 0n };
function fakeApp(){
  const values = {
    fileInfo: { name: 'A.bin', size: 4096, format: 'macho', slices: [{ offset: 0n, size: 4096n, info: { uuid: 'ABCDEF', architecture: 'arm64' }, capability: { architecture: 'arm64' }, regions: [region] }] },
    file: { name: 'A.bin', size: 4096 }, sliceIndex: 0, architecture: 'arm64', currentAddress: 0x1000n,
  };
  const app = {
    store: { get: (k) => values[k] }, prefs: { lang: 'ja', explain: true, textSize: 'm' }, notes: new Notes(), patches: new Patches(),
    navigation: { entries: [], index: -1, limit: 40, snapshot(){ return {}; }, onChange(){} },
    backend: { gen: 1, contentHash: 'same-hash', async ensureContentHash(){ return this.contentHash; } },
    symbols: { gen: 1, funcs: BigUint64Array.from([0x1000n]), functionStartsComplete: true, nameAt: () => null, rename(){}, functionAt(){ return null; } },
    viewer: { setSymbols(){} }, codeRegion: () => region, ensureRecognition: async () => null,
  };
  return app;
}

const liveApp = fakeApp();
const liveWorkspace = new ProductWorkspace(liveApp, { storage: new Storage(), backendFactory: () => ({}) });
liveApp.workspace = liveWorkspace;
await liveWorkspace.bind();

// Forge a project whose identity fields are single-element arrays that each
// String()-coerce to the live value, then give it user state that must not land.
const identityMeta = liveWorkspace.identity.metadata;
const structuredMetadata = {};
for (const field of ['sliceIndex', 'sliceOffset', 'sliceSize', 'uuid', 'architecture']) {
  structuredMetadata[field] = [String(identityMeta[field])];
}
const forged = snapshotWorkspace(liveApp, liveWorkspace.identity);
forged.binary = { hash: liveWorkspace.identity.hash, metadata: structuredMetadata, embedded: false };
forged.user.names = [{ address: 0x1000n, value: 'MISBOUND' }];
const forgedText = serializeHexProject(forged);
assert.deepEqual(parseHexProject(forgedText).binary.metadata.sliceIndex, ['0'], 'the parser must still carry the structured metadata, so the binding gate is the enforcement point');

liveApp.notes.names.set('4096', 'original');
let importError = null;
try {
  await liveWorkspace.importProject(new Blob([forgedText]));
} catch (error) { importError = error; }
assert.equal(importError?.code, 'HEX_PROJECT_BINARY_MISMATCH', 'importing a structured-metadata project must be rejected at the binding gate');
assert.equal(liveApp.notes.names.get('4096'), 'original', 'a rejected import must never apply user state to the live binary');

// A canonical project that genuinely matches the live slice must still import.
const honest = snapshotWorkspace(liveApp, liveWorkspace.identity);
const honestText = serializeHexProject(honest);
await liveWorkspace.importProject(new Blob([honestText]));
assert.equal(liveApp.notes.names.get('4096'), 'original', 'a legitimate same-identity import must still apply (existing match behavior preserved)');

console.log('#4816 structured-metadata binding regression: all assertions passed');
