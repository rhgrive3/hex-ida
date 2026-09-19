import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { threadedNativeFixture } from './threaded-native-fixture.mjs';
import { fixture as worldFixture, workFor } from './helpers.mjs';
import { createSliceId } from '../../js/core/identity/index.js';
import { produceScopedArm64Pipeline } from '../../js/analysis/scoped-arm64-producer.js';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { createCapstoneArm64Session } from '../machine-effects/helpers/arm64-capstone-session.mjs';

const FIXTURE = 'arm64-real-byte-fpsimd-atomic-holdout';
const PIPELINE_ROUTE = Object.freeze(['MachineEffects', 'SemanticIR', 'SSA', 'MemorySSA']);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const caseById = (f, id) => {
  const row = f.manifest.cases.find(candidate => candidate.id === id);
  assert.ok(row, `fixture case ${id} must exist`);
  return row;
};
const isVRegister = id => /^v\d+$/.test(id || '');
const isGpRegister = id => /^[wx]\d+$/.test(id || '');
const bundleByMnemonic = (pipeline, mnemonic) => pipeline.machineEffects.find(bundle =>
  bundle.metadata?.mnemonic === mnemonic || bundle.metadata?.sourceMnemonic === mnemonic);

async function loadPipeline(t, f, world, row) {
  const address = BigInt(row.start), end = BigInt(row.end), length = Number(end - address);
  const symbol = f.symbols.functionAt(address);
  assert.ok(symbol, `${row.function} must have a loader-proven extent`);
  assert.equal(symbol.start, address);
  assert.equal(symbol.end, end);
  const region = f.info.slices[0].regions.find(candidate => candidate.exec === true
    && address >= BigInt(candidate.vmAddr)
    && end <= BigInt(candidate.vmAddr) + BigInt(candidate.size));
  assert.ok(region, `${row.function} must be contained in an executable source region`);

  const source = await f.backend.readAt(address, length, false);
  assert.equal(source?.found, true);
  assert.equal(source.bytes?.byteLength, length);
  assert.equal(digest(source.bytes), row.bytesSha256, `${row.id} machine bytes drifted`);

  const before = { ...f.counters };
  const result = await produceScopedArm64Pipeline(f.backend, {
    region, address, length, sliceIndex: 0, snapshotId: 'arm64-real-byte-fpsimd-atomic-holdout',
    binaryId: f.backend.binaryId, architecture: 'arm64', abiId: 'aapcs64', platform: 'linux',
    dataEndianness: 'little', world, work: workFor(t, { deadlineMs: 8000 }), isCurrent: () => true,
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.pipeline.instrumentation?.v2Executed, true);
  assert.equal(result.pipeline.architectureId, 'arm64');
  assert.equal(result.nativeSource.virtualStart, address.toString());
  assert.equal(result.nativeSource.length, length);
  assert.ok(f.counters.decodes > before.decodes, 'shipped Capstone decoder must execute for this case');
  assert.ok(f.counters.semantic > before.semantic, 'actual platform semantic worker must execute for this case');
  for (const owner of ['machineEffects', 'semanticIr', 'ssa', 'memorySsa']) assert.ok(result.pipeline[owner], `${owner} owner must exist`);
  return result.pipeline;
}

// ---------------------------------------------------------------------------
// Independent architecture-contract oracles.
//
// These predicates describe A64 semantics (register roles, widths, lane shape,
// ordering, exclusive monitor/status) directly. They never read product
// pseudocode or renderer text, and they operate on descriptors projected out of
// the production MachineEffects bundles so a substitution is observable.
// ---------------------------------------------------------------------------

function fpScalarDescriptor(bundle) {
  const metadata = bundle.metadata || {};
  return {
    completeness: bundle.completeness,
    family: metadata.family,
    mnemonic: metadata.mnemonic,
    widthBits: metadata.destinationWidthBits,
    reads: bundle.operations.filter(op => op.kind === 'register-read' && isVRegister(op.register?.registerId))
      .map(op => ({ id: op.register.registerId, view: op.metadata?.architecturalViewRead })),
    writes: bundle.operations.filter(op => op.kind === 'register-write' && isVRegister(op.register?.registerId))
      .map(op => ({ id: op.register.registerId, view: op.metadata?.architecturalViewWritten, writePolicy: op.metadata?.writePolicy })),
    intrinsicId: bundle.operations.find(op => op.kind === 'intrinsic')?.intrinsicId,
    intrinsicReads: bundle.operations.find(op => op.kind === 'intrinsic')?.effectSummary?.registersRead || [],
    intrinsicWrites: bundle.operations.find(op => op.kind === 'intrinsic')?.effectSummary?.registersWritten || [],
    fpcrRead: bundle.operations.some(op => op.kind === 'register-read' && op.register?.registerId === 'fpcr'),
    fpsrRead: bundle.operations.some(op => op.kind === 'register-read' && op.register?.registerId === 'fpsr'),
    fpsrWrite: bundle.operations.some(op => op.kind === 'register-write' && op.register?.registerId === 'fpsr'),
  };
}

function assertFpScalarArithContract(d) {
  assert.ok(['exact', 'exact-with-intrinsic'].includes(d.completeness), 'scalar FP add must be exact');
  assert.equal(d.family, 'arm64-fp');
  assert.equal(d.mnemonic, 'fadd', 'FADD identity must come from the decoded instruction, not a substitution');
  assert.equal(d.intrinsicId, 'arm64.fp.fadd');
  assert.equal(d.widthBits, 64, 'FADD D0,D1,D2 is binary64');
  // Architectural roles: D0 = D1 + D2 (reads D1/D2 in source order, writes D0).
  assert.deepEqual(d.reads.map(r => r.id), ['v1', 'v2'], 'FADD must read exactly its two sources in order');
  assert.deepEqual(d.reads.map(r => r.view), ['d1', 'd2'], 'scalar FP width/format identity must be binary64');
  assert.deepEqual(d.writes.map(w => w.id), ['v0'], 'FADD result ownership must be D0');
  assert.deepEqual(d.writes.map(w => w.view), ['d0']);
  assert.ok(d.writes.every(w => w.writePolicy === 'zero-upper-vector-bits' || w.writePolicy === 'full-width'));
  assert.equal(d.fpcrRead, true, 'scalar FP arithmetic is rounded by FPCR');
  assert.equal(d.fpsrRead, true);
  assert.equal(d.fpsrWrite, true, 'scalar FP arithmetic may update FPSR status');
  assert.ok(d.intrinsicReads.includes('v1') && d.intrinsicReads.includes('v2'));
  assert.ok(d.intrinsicWrites.includes('v0'), 'the intrinsic must own the destination register');
  assert.ok(d.intrinsicWrites.includes('fpsr'));
}

function assertFpCompareContract(fcmp, branch) {
  const metadata = fcmp.metadata || {};
  assert.ok(['exact', 'exact-with-intrinsic'].includes(fcmp.completeness));
  assert.equal(metadata.family, 'arm64-fp');
  assert.equal(metadata.mnemonic, 'fcmp');
  assert.equal(metadata.widthBits, 64);
  const intrinsic = fcmp.operations.find(op => op.kind === 'intrinsic');
  assert.equal(intrinsic?.intrinsicId, 'arm64.fp.fcmp');
  assert.ok(intrinsic.effectSummary.registersRead.includes('v0') && intrinsic.effectSummary.registersRead.includes('v1'));
  assert.ok(intrinsic.effectSummary.registersRead.includes('fpcr') && intrinsic.effectSummary.registersRead.includes('fpsr'));
  assert.ok(intrinsic.effectSummary.registersWritten.includes('nzcv'), 'FCMP writes the canonical nzcv PSTATE state');
  assert.ok(intrinsic.effectSummary.registersWritten.includes('fpsr'));
  assert.ok(fcmp.operations.some(op => op.kind === 'register-write' && op.register?.registerId === 'nzcv'));
  // No fabrication: the FP owner must not mint per-flag NZCV semantics it does not own.
  assert.ok(!fcmp.operations.some(op => op.kind === 'flag-write'), 'FCMP must not fabricate NZCV flag writes');
  assert.ok(!fcmp.operations.some(op => op.kind === 'register-write' && /^NZCV\./.test(op.register?.registerId || '')),
    'FCMP must not write generic NZCV flag cells');

  assert.equal(branch.completeness, 'exact');
  assert.equal(branch.metadata?.sourceMnemonic, 'b.eq');
  assert.equal(branch.metadata?.conditionCode, 'eq');
  assert.equal(branch.controlEffect?.kind, 'conditional-branch');
  assert.equal(branch.controlEffect?.target?.value, String(0x1018n));
  assert.equal(branch.controlEffect?.fallthrough?.value, String(0x1010n));
  assert.ok(branch.operations.some(op => op.kind === 'flag-read' && op.flag?.flagId === 'NZCV.Z'),
    'B.EQ must read the NZCV.Z generic flag');
}

function fpCompareFailClosed(pipeline, fcmp, branch) {
  // The generic flag model cannot bind the FP owner's nzcv state to the integer
  // NZCV.Z flag cell. The pipeline must therefore keep the branch's flag input
  // as an explicit undefined, never a fabricated reaching definition.
  assert.equal(bundleByMnemonic(pipeline, 'fcmp'), fcmp);
  const zDefs = pipeline.ssa.definitions.filter(def =>
    def.proof?.variableIdentity?.physicalIdentity?.flagId === 'NZCV.Z');
  assert.ok(zDefs.length >= 1, 'the branch flag read must have an explicit definition entry');
  assert.ok(zDefs.every(def => def.proof?.transform?.proofKind === 'explicit-undefined'),
    'NZCV.Z must stay an explicit undefined; the FP compare must not fabricate a flag dependency');
  const zUses = pipeline.ssa.uses.filter(use => use.proof?.variableIdentity?.physicalIdentity?.flagId === 'NZCV.Z');
  assert.ok(zUses.length >= 1);
  for (const use of zUses) {
    assert.equal(use.proof?.variableIdentity?.key,
      zDefs[0].proof.variableIdentity.key, 'the flag read must resolve to the explicit-undefined state cell');
  }
  assert.equal(branch.controlEffect.condition?.temporaryId,
    branch.operations.find(op => op.kind === 'flag-read')?.value?.temporaryId);
  assert.ok(!pipeline.machineEffects.some(bundle =>
    bundle.operations.some(op => op.kind === 'register-write' && /^NZCV\./.test(op.register?.registerId || ''))),
    'no FP owner may launder nzcv into a generic NZCV flag cell in this lane');
}

function simdDescriptor(bundle) {
  const metadata = bundle.metadata || {};
  return {
    completeness: bundle.completeness,
    family: metadata.family,
    mnemonic: metadata.mnemonic,
    arrangement: metadata.arrangement,
    laneCount: metadata.laneCount,
    laneWidthBits: metadata.laneWidthBits,
    reads: bundle.operations.filter(op => op.kind === 'register-read' && isVRegister(op.register?.registerId))
      .map(op => ({ id: op.register.registerId, view: op.metadata?.architecturalViewRead })),
    writes: bundle.operations.filter(op => op.kind === 'register-write' && isVRegister(op.register?.registerId))
      .map(op => ({ id: op.register.registerId, view: op.metadata?.architecturalViewWritten, writePolicy: op.metadata?.writePolicy })),
    intrinsicId: bundle.operations.find(op => op.kind === 'intrinsic')?.intrinsicId,
    intrinsicReads: bundle.operations.find(op => op.kind === 'intrinsic')?.effectSummary?.registersRead || [],
    intrinsicWrites: bundle.operations.find(op => op.kind === 'intrinsic')?.effectSummary?.registersWritten || [],
  };
}

function assertSimdVectorAddContract(d) {
  assert.ok(['exact', 'exact-with-intrinsic'].includes(d.completeness));
  assert.equal(d.family, 'arm64-simd');
  assert.equal(d.mnemonic, 'add');
  assert.equal(d.intrinsicId, 'arm64.simd.add');
  // Lane shape: V0.4S = four 32-bit lanes, 128-bit vector.
  assert.equal(d.arrangement, '4s');
  assert.equal(d.laneCount, 4);
  assert.equal(d.laneWidthBits, 32);
  assert.deepEqual(d.reads.map(r => r.id), ['v1', 'v2']);
  assert.deepEqual(d.reads.map(r => r.view), ['v1.4s', 'v2.4s']);
  assert.deepEqual(d.writes.map(w => w.id), ['v0']);
  assert.deepEqual(d.writes.map(w => w.view), ['v0.4s']);
  assert.equal(d.writes[0].writePolicy, 'full-width');
  assert.ok(d.intrinsicReads.includes('v1') && d.intrinsicReads.includes('v2'));
  assert.ok(d.intrinsicWrites.includes('v0'));
}

function memoryDescriptor(bundle) {
  const metadata = bundle.metadata || {};
  const read = bundle.operations.find(op => op.kind === 'memory-read');
  const write = bundle.operations.find(op => op.kind === 'memory-write');
  return {
    completeness: bundle.completeness,
    family: metadata.family,
    mnemonic: metadata.mnemonic,
    widthBits: metadata.widthBits,
    ordering: metadata.ordering,
    regReads: bundle.operations.filter(op => op.kind === 'register-read').map(op => op.register?.registerId),
    regWrites: bundle.operations.filter(op => op.kind === 'register-write').map(op => op.register?.registerId),
    memRead: read ? { atomic: read.access?.atomic, ordering: read.access?.ordering, widthBits: read.access?.widthBits } : null,
    memWrite: write ? { atomic: write.access?.atomic, ordering: write.access?.ordering, widthBits: write.access?.widthBits } : null,
  };
}

function assertAcquireLoadContract(d) {
  assert.equal(d.completeness, 'exact');
  assert.equal(d.family, 'arm64-memory');
  assert.equal(d.mnemonic, 'ldar', 'LDAR identity must not be substituted with an ordinary LDR');
  assert.equal(d.widthBits, 64);
  assert.equal(d.ordering, 'acquire', 'LDAR must carry acquire ordering');
  assert.ok(d.regReads.includes('x1'), 'LDAR address provenance must be X1');
  assert.ok(d.regWrites.includes('x0'), 'LDAR must write its destination X0');
  assert.ok(d.memRead, 'LDAR must perform a memory read');
  assert.equal(d.memRead.atomic, true, 'LDAR must stay an atomic access, not a plain load');
  assert.equal(d.memRead.ordering, 'acquire');
  assert.equal(d.memRead.widthBits, 64);
  assert.equal(d.memWrite, null, 'LDAR must not write memory');
}

function assertReleaseStoreContract(d) {
  assert.equal(d.completeness, 'exact');
  assert.equal(d.family, 'arm64-memory');
  assert.equal(d.mnemonic, 'stlr', 'STLR identity must not be substituted with an ordinary STR');
  assert.equal(d.widthBits, 64);
  assert.equal(d.ordering, 'release', 'STLR must carry release ordering');
  assert.ok(d.regReads.includes('x1'), 'STLR address provenance must be X1');
  assert.ok(d.regReads.includes('x0'), 'STLR must read its source X0');
  assert.ok(d.memWrite, 'STLR must perform a memory write');
  assert.equal(d.memWrite.atomic, true, 'STLR must stay an atomic access, not a plain store');
  assert.equal(d.memWrite.ordering, 'release');
  assert.equal(d.memWrite.widthBits, 64);
  assert.equal(d.memRead, null, 'STLR must not read memory');
}

function exclusiveDescriptor(bundle) {
  const metadata = bundle.metadata || {};
  const memRead = bundle.operations.find(op => op.kind === 'memory-read');
  const memWrite = bundle.operations.find(op => op.kind === 'memory-write');
  return {
    completeness: bundle.completeness,
    family: metadata.family,
    mnemonic: metadata.mnemonic,
    kind: metadata.kind,
    widthBits: metadata.widthBits,
    ordering: metadata.ordering,
    intrinsics: bundle.operations.filter(op => op.kind === 'intrinsic').map(op => ({
      id: op.intrinsicId,
      reads: op.effectSummary?.registersRead || [],
      writes: op.effectSummary?.registersWritten || [],
      memWrite: op.effectSummary?.memoryWrite || null,
      conditional: op.metadata?.conditional,
      condition: op.metadata?.condition,
      successValue: op.metadata?.successValue,
      failureValue: op.metadata?.failureValue,
      hiddenState: op.metadata?.hiddenState,
    })),
    monitorWrites: bundle.operations.filter(op => op.kind === 'register-write'
      && /^arm64\.exclusive\./.test(op.register?.registerId || '')).map(op => op.register.registerId),
    regWrites: bundle.operations.filter(op => op.kind === 'register-write' && isGpRegister(op.register?.registerId))
      .map(op => ({ id: op.register.registerId, writePolicy: op.metadata?.writePolicy })),
    memRead: memRead ? { atomic: memRead.access?.atomic, ordering: memRead.access?.ordering, exclusive: memRead.metadata?.exclusive } : null,
    hasTopLevelMemoryWrite: memWrite != null,
  };
}

function assertExclusiveLoadContract(d) {
  assert.ok(['exact', 'exact-with-intrinsic'].includes(d.completeness));
  assert.equal(d.family, 'arm64-atomic');
  assert.equal(d.mnemonic, 'ldxr');
  assert.equal(d.kind, 'exclusive-load');
  assert.equal(d.widthBits, 64);
  assert.equal(d.ordering, 'relaxed', 'plain LDXR is relaxed, not acquire');
  assert.ok(d.memRead, 'LDXR must read memory');
  assert.equal(d.memRead.atomic, true);
  assert.equal(d.memRead.ordering, 'relaxed');
  assert.equal(d.memRead.exclusive, true, 'LDXR must be an exclusive access, never an ordinary load');
  assert.ok(d.intrinsics.some(i => i.id === 'arm64.exclusive-monitor-set'),
    'LDXR must set the exclusive reservation monitor');
  for (const id of ['arm64.exclusive.valid', 'arm64.exclusive.address', 'arm64.exclusive.size', 'arm64.exclusive.token']) {
    assert.ok(d.monitorWrites.includes(id), `LDXR must publish explicit monitor state ${id}`);
  }
  assert.ok(d.regWrites.some(w => w.id === 'x0'), 'LDXR must write the loaded value to X0');
}

function assertExclusiveStoreContract(d) {
  assert.ok(['exact', 'exact-with-intrinsic'].includes(d.completeness));
  assert.equal(d.family, 'arm64-atomic');
  assert.equal(d.mnemonic, 'stxr');
  assert.equal(d.kind, 'exclusive-store');
  assert.equal(d.widthBits, 64);
  assert.equal(d.ordering, 'relaxed', 'plain STXR is relaxed, not release');
  // The conditional store must not be modelled as an ordinary exact store.
  assert.equal(d.hasTopLevelMemoryWrite, false, 'STXR must not project an unconditional top-level memory write');
  const conditional = d.intrinsics.find(i => i.id === 'arm64.exclusive-store-conditional');
  assert.ok(conditional, 'STXR must own a conditional store intrinsic');
  assert.equal(conditional.conditional, true);
  assert.equal(conditional.condition, 'exclusive-monitor-pass');
  assert.equal(conditional.successValue, 0, 'exclusive status 0 is success');
  assert.equal(conditional.failureValue, 1, 'exclusive status 1 is failure');
  assert.equal(conditional.hiddenState, 'exclusive-monitor');
  assert.equal(conditional.memWrite?.scope, 'accesses', 'the guarded write stays a conservative may-write');
  assert.ok(conditional.writes.includes('arm64.exclusive.valid'));
  assert.ok(d.monitorWrites.includes('arm64.exclusive.valid'), 'STXR must clear the exclusive monitor on attempt');
  const statusWrite = d.regWrites.find(w => w.id === 'x2');
  assert.ok(statusWrite, 'STXR status must be written to W2');
  assert.equal(statusWrite.writePolicy, 'zero-upper-32', 'W status write zero-extends into X2');
}

function assertExclusiveMemorySsa(memorySsa) {
  const intrinsicWrites = memorySsa.canonicalAccessBindings.filter(binding =>
    binding.role === 'write' && binding.sourceKind === 'intrinsic');
  assert.ok(intrinsicWrites.length >= 1, 'the guarded exclusive store must bind a memory definition');
  assert.ok(intrinsicWrites.every(binding => binding.aliasRelation !== 'must'),
    'a conditional exclusive write must never be promoted to a must-alias write');
}

// Real machine bytes assembled for each mutation, decoded by the repository
// shipped Capstone 5 decoder, then lifted through the production ARM64 effects
// owner. These are not hand-fed mnemonics: each is a real A64 encoding.
const MUTATION_WORDS = Object.freeze({
  'fadd.d0.d1.d2': 0x1e622820,
  'fsub.d0.d1.d2': 0x1e623820,
  'fmul.d0.d1.d2': 0x1e620820,
  'fadd.s0.s1.s2': 0x1e222820,
  'fadd.d0.d2.d1': 0x1e612840,
  'add.v0.4s.v1.4s.v2.4s': 0x4ea28420,
  'add.v0.2d.v1.2d.v2.2d': 0x4ee28420,
  'add.v0.4s.v2.4s.v1.4s': 0x4ea18440,
  'add.v3.4s.v1.4s.v2.4s': 0x4ea28423,
  'ldar.x0.x1': 0xc8dffc20,
  'ldr.x0.x1': 0xf9400020,
  'stlr.x0.x1': 0xc89ffc20,
  'str.x0.x1': 0xf9000020,
  'ldxr.x0.x1': 0xc85f7c20,
  'stxr.w2.x0.x1': 0xc8027c20,
});

const wordBytes = word => Uint8Array.of(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24);

export function liftRealWord(session, word, label) {
  const raw = session.decode(wordBytes(word), 0x400000n)[0];
  assert.ok(raw, `${label} must decode with the shipped decoder`);
  return liftArm64MachineEffects({
    instructionId: `arm64-real-byte-fpsimd-atomic-holdout:mutation:${label}`,
    address: raw.address,
    mnemonic: raw.mnemonic,
    operands: raw.opStr,
    opStr: raw.opStr,
    ops: parseOperands(raw.opStr),
    mode: 'a64',
    origin: { instructionIds: [`arm64-real-byte-fpsimd-atomic-holdout:mutation:${label}`] },
  }, { btiGuardedPage: false });
}

test('G-02 real AArch64 FP/SIMD/atomic bytes traverse the shipped decoder, shared owners, and an independent oracle', { timeout: 60000 }, async t => {
  const f = await threadedNativeFixture(t, { fixture: FIXTURE });
  assert.equal(f.info.formatId, 'elf');
  assert.equal(f.manifest.schema, 'arm64-real-byte-fpsimd-atomic-holdout/v1');
  assert.equal(f.manifest.cases.length, 6);
  assert.ok(f.workerThreadId > 0, 'semantic analysis must run in the actual platform worker thread');
  assert.equal(f.capstoneVersion.major, 5, 'fixture must use the repository-shipped Capstone 5 decoder');
  assert.match(f.manifest.claim, /independent architecture contract/i);

  const binaryId = f.backend.binaryId;
  const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const { world } = worldFixture(data => {
    data.binarySet[0].binaryId = binaryId;
    data.binarySet[0].sliceId = sliceId;
    data.binarySet[0].sourceIdentity.sha256 = f.manifest.binarySha256;
  });

  const capstone = await createCapstoneArm64Session();
  t.after(() => capstone.close());

  let faddBundle, fcmpBundle, branchBundle, simdBundle, ldarBundle, stlrBundle, ldxrBundle, stxrBundle, exclusivePipeline;
  let faddDescriptor, simdDescriptorValue, ldarDescriptor, stlrDescriptor, ldxrDescriptor, stxrDescriptor;

  await t.test('scalar FP arithmetic: FADD D0,D1,D2 is exact binary64 with source/destination identity', async t => {
    const row = caseById(f, 'fp-scalar-arithmetic');
    const pipeline = await loadPipeline(t, f, world, row);
    faddBundle = bundleByMnemonic(pipeline, 'fadd');
    assert.ok(faddBundle, 'FADD must be owned by the FP family');
    faddDescriptor = fpScalarDescriptor(faddBundle);
    assertFpScalarArithContract(faddDescriptor);
    assert.equal(row.classification, 'exact');

    // Source-contract sanity: the fixture really encodes binary64 FADD, and the
    // oracle is not green for a substituted/width-changed real encoding.
    const baseline = liftRealWord(capstone, MUTATION_WORDS['fadd.d0.d1.d2'], 'baseline-fadd');
    assertFpScalarArithContract(fpScalarDescriptor(baseline));
    const fsub = liftRealWord(capstone, MUTATION_WORDS['fsub.d0.d1.d2'], 'fsub');
    assert.equal(fsub.metadata?.mnemonic, 'fsub');
    assert.throws(() => assertFpScalarArithContract(fpScalarDescriptor(fsub)), 'FADD→FSUB substitution must fail the oracle');
    const fmul = liftRealWord(capstone, MUTATION_WORDS['fmul.d0.d1.d2'], 'fmul');
    assert.equal(fmul.metadata?.mnemonic, 'fmul');
    assert.throws(() => assertFpScalarArithContract(fpScalarDescriptor(fmul)), 'FADD→FMUL substitution must fail the oracle');
    const width = liftRealWord(capstone, MUTATION_WORDS['fadd.s0.s1.s2'], 'fadd-s');
    assert.equal(fpScalarDescriptor(width).widthBits, 32);
    assert.throws(() => assertFpScalarArithContract(fpScalarDescriptor(width)), 'D→S width change must fail the oracle');
    const swapped = liftRealWord(capstone, MUTATION_WORDS['fadd.d0.d2.d1'], 'fadd-swap');
    assert.throws(() => assertFpScalarArithContract(fpScalarDescriptor(swapped)), 'source register swap must fail the oracle');
  });

  await t.test('scalar FP compare: FCMP owns exact NZCV but the generic flag binding is unrepresentable (partial, fail-closed)', async t => {
    const row = caseById(f, 'fp-compare-flags');
    const pipeline = await loadPipeline(t, f, world, row);
    fcmpBundle = bundleByMnemonic(pipeline, 'fcmp');
    branchBundle = bundleByMnemonic(pipeline, 'b.eq');
    assert.ok(fcmpBundle && branchBundle);
    assertFpCompareContract(fcmpBundle, branchBundle);
    fpCompareFailClosed(pipeline, fcmpBundle, branchBundle);
    assert.equal(row.classification, 'partial', 'FCMP→B.EQ flag binding is honestly partial, not exact');

    // Fail-closed mutation: if the FP owner were mutated to fabricate the
    // NZCV.Z flag write, the oracle must reject it.
    const fabricated = structuredClone(fcmpBundle);
    fabricated.operations.push({ kind: 'register-write', register: { kind: 'register', registerId: 'NZCV.Z', widthBits: 1 }, value: null });
    assert.throws(() => assertFpCompareContract(fabricated, branchBundle), 'fabricated NZCV flag write must fail the oracle');
  });

  await t.test('SIMD vector arithmetic: ADD V0.4S,V1.4S,V2.4S is exact four-lane 32-bit SIMD', async t => {
    const row = caseById(f, 'simd-vector-arithmetic');
    const pipeline = await loadPipeline(t, f, world, row);
    simdBundle = bundleByMnemonic(pipeline, 'add');
    assert.ok(simdBundle);
    simdDescriptorValue = simdDescriptor(simdBundle);
    assertSimdVectorAddContract(simdDescriptorValue);
    assert.equal(row.classification, 'exact');

    const lane = liftRealWord(capstone, MUTATION_WORDS['add.v0.2d.v1.2d.v2.2d'], 'add-2d');
    assert.equal(simdDescriptor(lane).arrangement, '2d');
    assert.throws(() => assertSimdVectorAddContract(simdDescriptor(lane)), 'lane-shape change .4S→.2D must fail the oracle');
    const swapped = liftRealWord(capstone, MUTATION_WORDS['add.v0.4s.v2.4s.v1.4s'], 'add-swap');
    assert.throws(() => assertSimdVectorAddContract(simdDescriptor(swapped)), 'SIMD source swap must fail the oracle');
    const destination = liftRealWord(capstone, MUTATION_WORDS['add.v3.4s.v1.4s.v2.4s'], 'add-dst');
    assert.throws(() => assertSimdVectorAddContract(simdDescriptor(destination)), 'SIMD destination change must fail the oracle');
  });

  await t.test('acquire load: LDAR X0,[X1] is exact atomic acquire with X1 provenance and X0 destination', async t => {
    const row = caseById(f, 'acquire-load');
    const pipeline = await loadPipeline(t, f, world, row);
    ldarBundle = bundleByMnemonic(pipeline, 'ldar');
    assert.ok(ldarBundle);
    ldarDescriptor = memoryDescriptor(ldarBundle);
    assertAcquireLoadContract(ldarDescriptor);
    assert.equal(row.classification, 'exact');

    const ldr = liftRealWord(capstone, MUTATION_WORDS['ldr.x0.x1'], 'ldr');
    assert.equal(memoryDescriptor(ldr).mnemonic, 'ldr');
    assert.throws(() => assertAcquireLoadContract(memoryDescriptor(ldr)), 'LDAR→LDR mutation must fail the oracle');
    const relaxed = { ...ldarDescriptor, ordering: 'relaxed', memRead: { ...ldarDescriptor.memRead, ordering: 'relaxed' } };
    assert.throws(() => assertAcquireLoadContract(relaxed), 'dropping acquire ordering must fail the oracle');
    const plain = { ...ldarDescriptor, memRead: { ...ldarDescriptor.memRead, atomic: false } };
    assert.throws(() => assertAcquireLoadContract(plain), 'removing atomicity must fail the oracle');
  });

  await t.test('release store: STLR X0,[X1] is exact atomic release with X0 source and X1 provenance', async t => {
    const row = caseById(f, 'release-store');
    const pipeline = await loadPipeline(t, f, world, row);
    stlrBundle = bundleByMnemonic(pipeline, 'stlr');
    assert.ok(stlrBundle);
    stlrDescriptor = memoryDescriptor(stlrBundle);
    assertReleaseStoreContract(stlrDescriptor);
    assert.equal(row.classification, 'exact');

    const str = liftRealWord(capstone, MUTATION_WORDS['str.x0.x1'], 'str');
    assert.equal(memoryDescriptor(str).mnemonic, 'str');
    assert.throws(() => assertReleaseStoreContract(memoryDescriptor(str)), 'STLR→STR mutation must fail the oracle');
    const relaxed = { ...stlrDescriptor, ordering: 'relaxed', memWrite: { ...stlrDescriptor.memWrite, ordering: 'relaxed' } };
    assert.throws(() => assertReleaseStoreContract(relaxed), 'dropping release ordering must fail the oracle');
    const plain = { ...stlrDescriptor, memWrite: { ...stlrDescriptor.memWrite, atomic: false } };
    assert.throws(() => assertReleaseStoreContract(plain), 'removing atomicity must fail the oracle');
  });

  await t.test('exclusive reservation: LDXR/STXR keep explicit monitor state and a guarded write (exact-with-intrinsic)', async t => {
    const row = caseById(f, 'exclusive-reservation');
    const pipeline = await loadPipeline(t, f, world, row);
    exclusivePipeline = pipeline;
    ldxrBundle = bundleByMnemonic(pipeline, 'ldxr');
    stxrBundle = bundleByMnemonic(pipeline, 'stxr');
    assert.ok(ldxrBundle && stxrBundle);
    ldxrDescriptor = exclusiveDescriptor(ldxrBundle);
    stxrDescriptor = exclusiveDescriptor(stxrBundle);
    assertExclusiveLoadContract(ldxrDescriptor);
    assertExclusiveStoreContract(stxrDescriptor);
    assertExclusiveMemorySsa(pipeline.memorySsa);
    assert.equal(row.classification, 'exact');

    // An exclusive operation misclassified as an ordinary exact memory op fails.
    const plain = liftRealWord(capstone, MUTATION_WORDS['ldr.x0.x1'], 'ldxr-as-ldr');
    assert.throws(() => assertExclusiveLoadContract(exclusiveDescriptor(plain)), 'LDXR→LDR misclassification must fail the oracle');
    const ldxr = liftRealWord(capstone, MUTATION_WORDS['ldxr.x0.x1'], 'ldxr-baseline');
    assertExclusiveLoadContract(exclusiveDescriptor(ldxr));
    const stxr = liftRealWord(capstone, MUTATION_WORDS['stxr.w2.x0.x1'], 'stxr-baseline');
    assertExclusiveStoreContract(exclusiveDescriptor(stxr));
    const unconditional = { ...stxrDescriptor, hasTopLevelMemoryWrite: true };
    assert.throws(() => assertExclusiveStoreContract(unconditional), 'an unconditional exclusive store must fail the oracle');
    const unguarded = structuredClone(stxrDescriptor);
    unguarded.intrinsics = unguarded.intrinsics.map(i => i.id === 'arm64.exclusive-store-conditional' ? { ...i, conditional: false } : i);
    assert.throws(() => assertExclusiveStoreContract(unguarded), 'a non-conditional exclusive store must fail the oracle');
  });

  assert.ok(f.counters.decodes >= 6, 'each semantic case must exercise the shipped decoder');
  assert.ok(f.counters.semantic >= 6, 'each semantic case must exercise the shared semantic worker');
  assert.deepEqual(PIPELINE_ROUTE, ['MachineEffects', 'SemanticIR', 'SSA', 'MemorySSA']);
  assert.ok(exclusivePipeline.memorySsa.canonicalAccessBindings.some(binding => binding.sourceKind === 'intrinsic'),
    'the shared MemorySSA owner must observe the exclusive intrinsic write');
});
