import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveCanonicalAddressProof,
  sameCanonicalAddressProof,
} from '../js/analysis/alias/canonical-address-v2-core.js';
import {
  aliasMemoryRegions,
  effectSummaryAliasRelation,
} from '../js/analysis/alias/legacy-safety-floor.js';
import { pointsToAlias } from '../js/analysis/pointsto/alias.js';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../js/analysis/pointsto/lattice.js';
import { analyzeLocalPointsTo } from '../js/analysis/pointsto/local.js';
import { createAnalysisStatus } from '../js/analysis/status.js';
import {
  createFunctionSummary,
} from '../js/analysis/summary/contract.js';
import { createEscapeRecord } from '../js/analysis/summary/escape.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';
import { claimsConflict, createTypeClaim } from '../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';
import { queryScopedAbiPlacement } from '../js/analysis/types/scoped-abi.js';
import { DwarfDebugInfoProvider } from '../js/analysis/debug/dwarf.js';
import { parseTpiStream } from '../js/analysis/debug/pdb.js';
import { fixture } from './phase7/helpers/fixtures.mjs';
import { fixture as scpaFixture, workFor } from './scpa/helpers.mjs';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';

const completeStatus = (snapshotId = 'wave2-area-g') => createAnalysisStatus({
  snapshotId,
  analyzerId: 'wave2.test',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

// ---------------------------------------------------------------------------
// 1. [P0] canonical-address-v2-core.js: signed displacement & wrap checks
// ---------------------------------------------------------------------------
test('1. [P0] canonical-address-v2-core treats 64-bit/32-bit unsigned wrap constants as signed displacements', () => {
  const rootDesc = {
    kind: 'stack-like',
    baseOffset: 0,
    linearOffsets: true,
    addressSpace: 'memory',
  };
  const makeIr = (constVal, widthBits = 64) => ({
    functionId: 'fn_wrap',
    values: [
      { id: 'sp', kind: 'entry', variableKey: 'state:sp', machineType: { kind: 'address', widthBits } },
      { id: 'c', definitionNodeId: 'n_c', machineType: { kind: 'bitvector', widthBits } },
      { id: 'p', definitionNodeId: 'n_add', machineType: { kind: 'address', widthBits } },
    ],
    nodes: [
      { id: 'n_c', kind: 'const', inputs: [], outputs: ['c'], attributes: { constant: { kind: 'bitvector', value: constVal, widthBits } } },
      { id: 'n_add', kind: 'binary', operator: 'add', inputs: ['sp', 'c'], outputs: ['p'], attributes: { widthBits } },
    ],
    blocks: [{ id: 'entry', nodeIds: ['n_c', 'n_add'] }],
  });

  const wrapped64 = deriveCanonicalAddressProof(makeIr('0xfffffffffffffff0', 64), 'p', {
    rootDescriptors: { 'state:sp': rootDesc },
  });
  assert.equal(wrapped64.kind, 'stack-like');
  assert.equal(wrapped64.offset, -16n);

  const sub16Ir = {
    ...makeIr('16', 64),
    nodes: [
      { id: 'n_c', kind: 'const', inputs: [], outputs: ['c'], attributes: { constant: { kind: 'bitvector', value: '16', widthBits: 64 } } },
      { id: 'n_add', kind: 'binary', operator: 'sub', inputs: ['sp', 'c'], outputs: ['p'], attributes: { widthBits: 64 } },
    ],
  };
  const sub16 = deriveCanonicalAddressProof(sub16Ir, 'p', {
    rootDescriptors: { 'state:sp': rootDesc },
  });
  assert.equal(sameCanonicalAddressProof(wrapped64, sub16), true);

  // 32-bit unsigned wrap constant 0xfffffff0 -> -16n
  const wrapped32 = deriveCanonicalAddressProof(makeIr('0xfffffff0', 32), 'p', {
    rootDescriptors: { 'state:sp': rootDesc },
  });
  assert.equal(wrapped32.kind, 'stack-like');
  assert.equal(wrapped32.offset, -16n);

  // Wrap-incompatible: 32-bit constant 0xfffffff0 added to 64-bit root
  const mismatchIr = {
    functionId: 'fn_mismatch',
    values: [
      { id: 'sp', kind: 'entry', variableKey: 'state:sp', machineType: { kind: 'address', widthBits: 64 } },
      { id: 'c', definitionNodeId: 'n_c', machineType: { kind: 'bitvector', widthBits: 32 } },
      { id: 'p', definitionNodeId: 'n_add', machineType: { kind: 'address', widthBits: 64 } },
    ],
    nodes: [
      { id: 'n_c', kind: 'const', inputs: [], outputs: ['c'], attributes: { constant: { kind: 'bitvector', value: '0xfffffff0', widthBits: 32 } } },
      { id: 'n_add', kind: 'binary', operator: 'add', inputs: ['sp', 'c'], outputs: ['p'], attributes: { widthBits: 64 } },
    ],
    blocks: [{ id: 'entry', nodeIds: ['n_c', 'n_add'] }],
  };
  const mismatch = deriveCanonicalAddressProof(mismatchIr, 'p', {
    rootDescriptors: { 'state:sp': rootDesc },
  });
  assert.equal(mismatch.kind, 'unknown');
});

// ---------------------------------------------------------------------------
// 2. [P1] legacy-safety-floor.js: 'unknown' addressSpace does not prove NoAlias
// ---------------------------------------------------------------------------
test('2. [P1] legacy-safety-floor treats unknown addressSpace as unproven (may), never NoAlias', () => {
  const unknownRegion = {
    kind: 'rooted-offset',
    rootEntityId: 'root_1',
    offset: '0',
    widthBits: 64,
    addressSpace: 'unknown',
    origin: { instructionIds: ['i1'] },
  };
  const tlsRegion = {
    kind: 'rooted-offset',
    rootEntityId: 'root_1',
    offset: '0',
    widthBits: 64,
    addressSpace: 'tls',
    origin: { instructionIds: ['i2'] },
  };
  const memRegion = {
    kind: 'rooted-offset',
    rootEntityId: 'root_1',
    offset: '64',
    widthBits: 64,
    addressSpace: 'memory',
    origin: { instructionIds: ['i3'] },
  };

  assert.equal(aliasMemoryRegions(unknownRegion, tlsRegion), 'may');
  assert.equal(aliasMemoryRegions(unknownRegion, memRegion), 'may');
  assert.equal(aliasMemoryRegions(memRegion, tlsRegion), 'no');

  assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['tls'] }, unknownRegion), 'may');
  assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['memory'] }, unknownRegion), 'may');
  assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['tls'] }, memRegion), 'no');
});

// ---------------------------------------------------------------------------
// 3. [P1] pointsto/alias.js: unproven space on absolute targets returns may
// ---------------------------------------------------------------------------
test('3. [P1] pointsto/alias returns may for absolute targets with unproven addressSpace', () => {
  const status = completeStatus();
  const abs = (address, addressSpace) => createPointsToSet({
    targets: [createPointsToTarget({
      rootKind: 'absolute',
      address,
      addressSpace,
      widthBits: 64,
      offsetRange: exactRange(0n),
    })],
  });

  const disjointUnknown = pointsToAlias(abs('0x1000', 'unknown'), abs('0x2000', 'unknown'), {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(disjointUnknown.relation, 'may');

  const mixedUnknown = pointsToAlias(abs('0x1000', 'unknown'), abs('0x2000', 'memory'), {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(mixedUnknown.relation, 'may');

  // Same address but unproven space vs memory must not claim MustAlias
  const sameAddrUnknown = pointsToAlias(abs('0x1000', 'unknown'), abs('0x1000', 'memory'), {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(sameAddrUnknown.relation, 'may');

  // Proven memory spaces still separate on disjoint intervals
  const disjointMemory = pointsToAlias(abs('0x1000', 'memory'), abs('0x2000', 'memory'), {
    status,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(disjointMemory.relation, 'no');
});

// ---------------------------------------------------------------------------
// 4 & 5. [P1] summary/interprocedural.js: mergeEscapes & allocations/frees
// ---------------------------------------------------------------------------
test('4 & 5. [P1] interprocedural preserves distinct EscapeRecords and propagates allocations/frees', () => {
  const status = completeStatus('snap_interproc');
  const esc1 = createEscapeRecord({
    rootKey: 'root_a',
    rootOrigin: 'local-allocation',
    reason: 'returned',
    boundary: 'return',
    siteId: 'ret_1',
    evidenceIds: ['ev_1'],
  });
  const esc2 = createEscapeRecord({
    rootKey: 'root_b',
    rootOrigin: 'incoming-argument',
    reason: 'stored-to-global',
    boundary: 'global',
    siteId: 'st_2',
    evidenceIds: ['ev_2'],
  });
  const esc1Dup = createEscapeRecord({
    rootKey: 'root_a',
    rootOrigin: 'local-allocation',
    reason: 'returned',
    boundary: 'return',
    siteId: 'ret_1',
    evidenceIds: ['ev_3'],
  });

  const callee = createFunctionSummary({
    functionId: 'fn_callee',
    escapes: [esc1, esc2],
    allocations: ['alloc_callee'],
    frees: ['free_callee'],
    status,
  });
  const caller = createFunctionSummary({
    functionId: 'fn_caller',
    escapes: [esc1Dup],
    allocations: ['alloc_caller'],
    frees: ['free_caller'],
    directCalls: [{
      callSiteId: 'call_1',
      targetEntityIds: ['fn_callee'],
      effectSource: 'proven-summary',
    }],
    status,
  });

  const solved = solveInterproceduralSummaries({
    snapshotId: 'snap_interproc',
    roots: ['fn_caller'],
    localSummaries: new Map([
      ['fn_caller', caller],
      ['fn_callee', callee],
    ]),
  });

  const solvedCaller = solved.summaries.get('fn_caller');
  assert.ok(solvedCaller);
  // 4. Both distinct EscapeRecords survive (not collapsed to "[null,null]"), while duplicate esc1 merges evidenceIds
  assert.equal(solvedCaller.escapes.length, 2);
  const mergedA = solvedCaller.escapes.find((e) => e.rootKey === 'root_a');
  assert.deepEqual(mergedA.evidenceIds, ['ev_1', 'ev_3']);
  assert.ok(solvedCaller.escapes.some((e) => e.rootKey === 'root_b'));

  // 5. allocations & frees are propagated from callee to caller
  assert.deepEqual(solvedCaller.allocations, ['alloc_callee', 'alloc_caller']);
  assert.deepEqual(solvedCaller.frees, ['free_callee', 'free_caller']);
});

// ---------------------------------------------------------------------------
// 6. [P1] types/constraints.js: structural partial overlap at different offsets
// ---------------------------------------------------------------------------
test('6. [P1] claimsConflict detects partial byte-range overlap at different offsets as conflict', () => {
  const claimA = createTypeClaim({
    layer: 'structural',
    entityId: 'ent_s',
    key: 'left',
    descriptor: { offset: 0, sizeBytes: 8, memberType: { kind: 'integer', widthBits: 64 } },
  });
  const claimB = createTypeClaim({
    layer: 'structural',
    entityId: 'ent_s',
    key: 'right',
    descriptor: { offset: 4, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } },
  });
  assert.equal(claimsConflict(claimA, claimB), true);

  const claimC = createTypeClaim({
    layer: 'structural',
    entityId: 'ent_s',
    key: 'no_mt_left',
    descriptor: { offset: 0, sizeBytes: 8 },
  });
  const claimD = createTypeClaim({
    layer: 'structural',
    entityId: 'ent_s',
    key: 'no_mt_right',
    descriptor: { offset: 4, sizeBytes: 4 },
  });
  assert.equal(claimsConflict(claimC, claimD), true);

  // Disjoint adjacent fields do not conflict
  const adjacent = createTypeClaim({
    layer: 'structural',
    entityId: 'ent_s',
    key: 'adj',
    descriptor: { offset: 8, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } },
  });
  assert.equal(claimsConflict(claimA, adjacent), false);
});

// ---------------------------------------------------------------------------
// 7. [P1] debug/dwarf.js: types() die.complete, byte_size validation, attributeName(die, dies)
// ---------------------------------------------------------------------------
function encodeUleb(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function buildDwarfUnit({ abbrevs, diesBytes, addrSize = 8 }) {
  // abbrevs: array of { code, tag, hasChildren, attrs: [[attr, form], ...] }
  const abbrevOut = [];
  for (const a of abbrevs) {
    abbrevOut.push(...encodeUleb(a.code), ...encodeUleb(a.tag), a.hasChildren ? 1 : 0);
    for (const [attr, form] of a.attrs) {
      abbrevOut.push(...encodeUleb(attr), ...encodeUleb(form));
    }
    abbrevOut.push(0, 0);
  }
  abbrevOut.push(0);

  // DWARF4 CU header: unit_length (4), version=4 (2), abbrev_offset=0 (4), addr_size (1) = 11 bytes
  const unitLength = 7 + diesBytes.length;
  const info = new Uint8Array(4 + unitLength);
  const dv = new DataView(info.buffer);
  dv.setUint32(0, unitLength, true);
  dv.setUint16(4, 4, true);
  dv.setUint32(6, 0, true);
  dv.setUint8(10, addrSize);
  info.set(diesBytes, 11);
  return { debug_info: info, debug_abbrev: new Uint8Array(abbrevOut) };
}

test('7. [P1] dwarf.js validates DW_AT_byte_size, passes dies to attributeName, and checks die.complete in types()', async () => {
  // Tags: compile_unit=0x11, base_type=0x24, typedef=0x16, variable=0x34, structure_type=0x13
  // Attrs: name=0x03, byte_size=0x0b, encoding=0x3e, type=0x49, specification=0x47
  // Forms: string=0x08, data1=0x0b, sdata=0x0d, ref4=0x13
  const abbrevs = [
    { code: 1, tag: 0x11, hasChildren: true, attrs: [] },
    // base_type with sdata byte_size
    { code: 2, tag: 0x24, hasChildren: false, attrs: [[0x03, 0x08], [0x0b, 0x0d], [0x3e, 0x0b]] },
    // declaration struct with name
    { code: 3, tag: 0x13, hasChildren: false, attrs: [[0x03, 0x08]] },
    // defining struct inheriting name via specification
    { code: 4, tag: 0x13, hasChildren: false, attrs: [[0x47, 0x13], [0x0b, 0x0b]] },
    // variable pointing to type
    { code: 5, tag: 0x34, hasChildren: false, attrs: [[0x03, 0x08], [0x49, 0x13]] },
    // variable with unresolved strx1 (0x1a) -> die.complete = false
    { code: 6, tag: 0x34, hasChildren: false, attrs: [[0x03, 0x08], [0x49, 0x13], [0x02, 0x1a]] },
  ];

  // Build DIE stream starting at offset 11:
  const dies = [];
  const pushStr = (s) => { for (const c of s) dies.push(c.charCodeAt(0)); dies.push(0); };
  const pushU32 = (v) => dies.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);

  // DIE 1 (offset 11): compile_unit
  dies.push(...encodeUleb(1));
  // DIE 2 (offset 12): base_type "neg_int" with byte_size = -1 (sdata 0x7f), encoding = 5 (signed)
  const baseOff = 11 + dies.length;
  dies.push(...encodeUleb(2));
  pushStr('neg_int');
  dies.push(0x7f, 0x05);
  // DIE 3: decl struct "Foo"
  const declOff = 11 + dies.length;
  dies.push(...encodeUleb(3));
  pushStr('Foo');
  // DIE 4: def struct with specification=declOff, byte_size=16
  const defOff = 11 + dies.length;
  dies.push(...encodeUleb(4));
  pushU32(declOff);
  dies.push(16);
  // DIE 5: variable "v_neg" -> baseOff
  dies.push(...encodeUleb(5));
  pushStr('v_neg');
  pushU32(baseOff);
  // DIE 6: variable "v_struct" -> defOff
  dies.push(...encodeUleb(5));
  pushStr('v_struct');
  pushU32(defOff);
  // DIE 7: incomplete variable "v_bad" -> defOff (has unresolved strx1 index 0)
  dies.push(...encodeUleb(6));
  pushStr('v_bad');
  pushU32(defOff);
  dies.push(0);
  dies.push(0); // end children of CU

  const sections = buildDwarfUnit({ abbrevs, diesBytes: new Uint8Array(dies) });
  const provider = new DwarfDebugInfoProvider();
  const probe = await provider.probe({ debugSections: sections, architecture: 'x86_64' });
  const page = await provider.types(probe, { pageSize: 20 });

  const vNeg = page.records.find((r) => r.name === 'v_neg');
  assert.ok(vNeg);
  assert.equal(vNeg.descriptor.machine, null, 'negative DW_AT_byte_size must not produce widthBits');
  assert.equal(vNeg.descriptor.complete, false);

  const vStruct = page.records.find((r) => r.name === 'v_struct');
  assert.ok(vStruct);
  assert.equal(vStruct.descriptor.claim.name, 'struct Foo', 'describeType must resolve inherited name via dies');
  assert.equal(vStruct.descriptor.complete, true);

  const vBad = page.records.find((r) => r.name === 'v_bad');
  assert.ok(vBad);
  assert.equal(vBad.descriptor.complete, false, 'incomplete DIE must not publish complete: true in types()');
});

// ---------------------------------------------------------------------------
// 8. [P2] pointsto/local.js: BOTTOM_POINTS_TO not prematurely promoted to TOP
// ---------------------------------------------------------------------------
test('8. [P2] pointsto/local does not prematurely promote BOTTOM_POINTS_TO operands to TOP', () => {
  // Build an IR where a binary add and a call return provenance are ordered BEFORE
  // the state-read / copy that defines their operands, forcing fixed-point iteration
  // where operands are initially BOTTOM_POINTS_TO.
  const f = fixture('fn_bottom_fp');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const idx = f.stateRead('idx', 'state:x1');
  const spCopy = f.cast('sp_copy', 'copy', sp);
  const sum = f.binary('sum', 'add', idx, spCopy);
  const spCopy2 = f.cast('sp_copy2', 'copy', sp);
  f.ret('r');
  const built = f.build({});

  const callRet = 'call_ret';
  const callNode = {
    id: 'node_call_ret',
    kind: 'call',
    blockId: 'entry',
    inputs: [spCopy2],
    outputs: [callRet],
    call: { targetEntityIds: ['fn_id'], exhaustive: true, arguments: [spCopy2] },
    origin: { instructionIds: ['inst_call'] },
  };
  const callValue = {
    id: callRet,
    definitionNodeId: 'node_call_ret',
    machineType: { kind: 'address', widthBits: 64 },
    origin: { instructionIds: ['inst_call'] },
  };
  // Reorder nodes/values so sum & call_ret are evaluated before sp_copy / sp_copy2
  const ir = {
    ...built.ir,
    values: [callValue, ...built.ir.values].reverse(),
    nodes: [...built.ir.nodes, callNode].reverse(),
    blocks: built.ir.blocks.map((b) => ({
      ...b,
      nodeIds: [...b.nodeIds, 'node_call_ret'].reverse(),
    })),
  };

  const calleeSummary = createFunctionSummary({
    functionId: 'fn_id',
    returnProvenance: [{ kind: 'arg', argIndex: 0, offset: 8n, returnIndex: 0 }],
    status: completeStatus(),
  });

  const result = analyzeLocalPointsTo(ir, built.cfg, built.ssa, {
    snapshotId: completeStatus().snapshotId,
    summaries: new Map([['fn_id', calleeSummary]]),
  });

  const sumSet = result.pointsTo.get(sum);
  assert.equal(sumSet.top, false, 'binary add with initially-BOTTOM operand must converge without sticky TOP');
  assert.ok(sumSet.targets.length >= 1);

  const callSet = result.pointsTo.get(callRet);
  assert.equal(callSet.top, false, 'call with initially-BOTTOM arg must converge without sticky TOP');
  assert.equal(callSet.targets.length, 1);
  assert.equal(callSet.targets[0].offsetRange.min, 8n);
});

// ---------------------------------------------------------------------------
// 9. [P2] debug/pdb.js: LF_STRUCTURE/LF_ARRAY/LF_MEMBER validate non-negative safe integer
// ---------------------------------------------------------------------------
function makeTpiStream(records) {
  // records: array of { leaf, payload: number[] }
  const recBytes = [];
  for (const r of records) {
    const len = 2 + r.payload.length;
    recBytes.push(len & 0xff, (len >> 8) & 0xff, r.leaf & 0xff, (r.leaf >> 8) & 0xff, ...r.payload);
  }
  const headerSize = 56;
  const out = new Uint8Array(headerSize + recBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 20040203, true); // TPI version
  dv.setUint32(4, headerSize, true);
  dv.setUint32(8, 0x1000, true); // typeIndexBegin
  dv.setUint32(12, 0x1000 + records.length, true); // typeIndexEnd
  dv.setUint32(16, recBytes.length, true); // typeRecordBytes
  out.set(recBytes, headerSize);
  return out;
}

test('9. [P2] pdb.js rejects negative/non-integer readNumeric in LF_STRUCTURE, LF_ARRAY, LF_MEMBER', () => {
  // LF_STRUCTURE = 0x1505, LF_ARRAY = 0x1503, LF_FIELDLIST = 0x1203, LF_MEMBER = 0x150d
  // Negative LF_CHAR (0x8000, -1 = 0xff)
  const negStructPayload = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 bytes fixed fields
    0x00, 0x80, 0xff, // LF_CHAR = -1
    0x42, 0x61, 0x64, 0x00, // "Bad\0"
  ];
  const structRes = parseTpiStream(makeTpiStream([{ leaf: 0x1505, payload: negStructPayload }]));
  assert.equal(structRes.complete, false);
  assert.equal(structRes.types.size, 0);

  // LF_ARRAY with LF_REAL32 (0x8005, 1.5f)
  const floatArrayPayload = [
    0x74, 0x00, 0x00, 0x00, // elementType
    0x74, 0x00, 0x00, 0x00, // indexType
    0x05, 0x80, 0x00, 0x00, 0xc0, 0x3f, // LF_REAL32 = 1.5
    0x00, // name
  ];
  const arrayRes = parseTpiStream(makeTpiStream([{ leaf: 0x1503, payload: floatArrayPayload }]));
  assert.equal(arrayRes.complete, false);
  assert.equal(arrayRes.types.size, 0);

  // LF_FIELDLIST with LF_MEMBER having negative offset (LF_CHAR = -1)
  const memberPayload = [
    0x0d, 0x15, // LF_MEMBER
    0x03, 0x00, // attributes
    0x74, 0x00, 0x00, 0x00, // typeIndex
    0x00, 0x80, 0xff, // LF_CHAR = -1
    0x66, 0x00, // "f\0"
  ];
  // parseTpiStream subtracts 2 for leaf in record header; for LF_FIELDLIST payload starts right at body
  const flRes = parseTpiStream(makeTpiStream([{ leaf: 0x1203, payload: memberPayload }]));
  assert.equal(flRes.complete, false);
  assert.equal(flRes.types.get(0x1000).complete, false);
  assert.equal(flRes.types.get(0x1000).members.length, 0);
});

// ---------------------------------------------------------------------------
// 10. [P2] types/scoped-abi.js: deterministic string buildIdentity
// ---------------------------------------------------------------------------
test('10. [P2] scoped-abi passes a deterministic string buildIdentity, not an object', async (t) => {
  const f = scpaFixture((d) => { d.profile.abiRevision = AAPCS64_ABI.semanticVersion; });
  const snapshotId = 'snap_1';
  const functionId = 'fn_1';
  const adapter = semanticAbiAdapter(AAPCS64_ABI, {
    architecture: 'arm64',
    platform: 'linux',
    binaryId: 'binary-scpa-test',
    sliceId: 'slice-arm64',
    functionId,
    snapshotId,
  });
  const original = adapter.classifyArguments({
    functionPrototype: { parameters: [{ type: 'uint64', bits: 64 }] },
  });
  original.arguments[0].bytes = 8;
  const context = {
    binding: {
      worldId: f.world.id,
      assumptionsId: f.assumptions.id,
      snapshotId,
      binaryId: 'binary-scpa-test',
      functionId,
      kind: 'arguments',
      callSiteId: null,
      producerArtifactId: 'native-abi',
      ownerRevision: 'one',
    },
    result: original,
    isCurrent: () => true,
  };

  const originalAdd = TypeConstraintGraph.prototype.addHardConstraint;
  const captured = [];
  TypeConstraintGraph.prototype.addHardConstraint = function patched(constraint) {
    captured.push(constraint);
    return originalAdd.call(this, constraint);
  };
  try {
    await queryScopedAbiPlacement(
      { functionId, kind: 'arguments' },
      { ...f, snapshotId, work: workFor(t), getContext: () => context },
    );
    await queryScopedAbiPlacement(
      { functionId, kind: 'arguments' },
      { ...f, snapshotId, work: workFor(t), getContext: () => context },
    );
  } finally {
    TypeConstraintGraph.prototype.addHardConstraint = originalAdd;
  }

  assert.equal(captured.length, 2);
  assert.equal(typeof captured[0].buildIdentity, 'string');
  assert.ok(captured[0].buildIdentity.length > 0);
  assert.notEqual(captured[0].buildIdentity, '[object Object]');
  assert.equal(captured[0].buildIdentity, captured[1].buildIdentity);
});
