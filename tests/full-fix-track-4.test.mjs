import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseDebugInfo,
} from '../js/analysis/debug/dwarf.js';

const DW_TAG = { compile_unit: 0x11, variable: 0x34 };
const DW_AT = { name: 0x03, byte_size: 0x0b, const_value: 0x1c, str_offsets_base: 0x72 };
const DW_FORM = { data4: 0x06, indirect: 0x16, sec_offset: 0x17, implicit_const: 0x21, strx1: 0x25 };
import {
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseModuleInfo,
  parseMsf,
} from '../js/analysis/debug/pdb.js';
import {
  claimsConflict,
  createHardConstraint,
  createTypeClaim,
} from '../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';
import { planAnalysisGoal } from '../js/query/planner.js';
import {
  UNBOUNDED_RANGE,
  addRange,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  createRootDescriptorSeparatedTarget,
  exactRange,
  provenSeparationAuthority,
  widenPointsTo,
} from '../js/analysis/pointsto/lattice.js';
import { deriveCanonicalAddressProof } from '../js/analysis/alias/canonical-address-v2.js';
import {
  createFormatSafeRebuildTransaction,
  inspectFormatSafeImage,
  validateFormatSafeMutation,
} from '../js/rebuild/format-safe.js';
import { materializeRebuildTransaction } from '../js/rebuild/transaction-v2.js';
import { stableDigestBytes } from '../js/core/identity/index.js';
import { loadPdbFixtures, pdbImage } from '../tools/validation/phase7/lanes/debug.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encodeUleb128(value) {
  let n = BigInt(value);
  const out = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    out.push(byte);
  } while (n !== 0n);
  return out;
}

function encodeSleb128(value) {
  let n = BigInt(value);
  const out = [];
  let more = true;
  while (more) {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function u16le(value) {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function buildDwarf5Unit(bodyBytes, abbrevOffset = 0, addressSize = 8) {
  // DWARF5 compile unit header: version(2), unit_type(1), address_size(1), abbrev_offset(4)
  const header = [...u16le(5), 0x01, addressSize, ...u32le(abbrevOffset)];
  const totalLength = header.length + bodyBytes.length;
  return Uint8Array.from([...u32le(totalLength), ...header, ...bodyBytes]);
}

function msfStreamBlocks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = view.getUint32(32, true);
  const directoryBytes = view.getUint32(44, true);
  const blockMapAddr = view.getUint32(52, true);
  const directoryBlockCount = Math.ceil(directoryBytes / blockSize);

  const directory = new Uint8Array(directoryBytes);
  let written = 0;
  for (let index = 0; index < directoryBlockCount; index += 1) {
    const blockIndex = view.getUint32(blockMapAddr * blockSize + index * 4, true);
    const take = Math.min(blockSize, directoryBytes - written);
    directory.set(bytes.subarray(blockIndex * blockSize, blockIndex * blockSize + take), written);
    written += take;
  }

  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const streamCount = directoryView.getUint32(0, true);
  const sizes = [];
  let cursor = 4;
  for (let index = 0; index < streamCount; index += 1) {
    const rawSize = directoryView.getUint32(cursor, true);
    sizes.push(rawSize === 0xffffffff ? 0 : rawSize);
    cursor += 4;
  }

  const blocks = [];
  for (const size of sizes) {
    const streamBlocks = [];
    for (let index = 0; index < Math.ceil(size / blockSize); index += 1) {
      streamBlocks.push(directoryView.getUint32(cursor, true));
      cursor += 4;
    }
    blocks.push(streamBlocks);
  }
  return { blockSize, blocks };
}

function patchMsfStreamBytes(original, streamIndex, streamOffset, patchBytes) {
  const { blockSize, blocks } = msfStreamBlocks(original);
  const streamBlocks = blocks[streamIndex];
  assert.ok(streamBlocks && streamBlocks.length > 0, `stream ${streamIndex} must have physical blocks`);
  const copy = original.slice();
  for (let i = 0; i < patchBytes.length; i += 1) {
    const pos = streamOffset + i;
    const blockIdx = streamBlocks[Math.floor(pos / blockSize)];
    assert.notEqual(blockIdx, undefined);
    copy[blockIdx * blockSize + (pos % blockSize)] = patchBytes[i];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// 1. [P1] dwarf.js — DW_FORM_indirect resolves actual form & implicit_const SLEB128
// ---------------------------------------------------------------------------
test('1. [P1] dwarf.js resolves DW_FORM_indirect actual form (including strx1 and DWARF5 implicit_const SLEB128)', () => {
  // .debug_str: "\0indirect_strx_name\0"
  const nameBytes = Array.from(Buffer.from('indirect_strx_name\0', 'utf8'));
  const debug_str = Uint8Array.from([0, ...nameBytes]);

  // DWARF5 .debug_str_offsets: initial_length(4) = 8 (version 2 + padding 2 + one 4-byte offset)
  const debug_str_offsets = Uint8Array.from([
    ...u32le(8),
    ...u16le(5), ...u16le(0),
    ...u32le(1), // index 0 -> offset 1 in .debug_str
  ]);

  // .debug_abbrev:
  // code 1: DW_TAG_compile_unit, hasChildren=1
  //   DW_AT_str_offsets_base (DW_FORM_sec_offset)
  //   DW_AT_name             (DW_FORM_indirect -> DW_FORM_strx1)
  // code 2: DW_TAG_variable, hasChildren=0
  //   DW_AT_const_value      (DW_FORM_indirect -> DW_FORM_implicit_const -> SLEB128(-42))
  //   DW_AT_byte_size        (DW_FORM_indirect -> DW_FORM_indirect -> DW_FORM_data4(16))
  const debug_abbrev = Uint8Array.from([
    // abbrev 1
    ...encodeUleb128(1), ...encodeUleb128(DW_TAG.compile_unit), 1,
    ...encodeUleb128(DW_AT.str_offsets_base), ...encodeUleb128(DW_FORM.sec_offset),
    ...encodeUleb128(DW_AT.name), ...encodeUleb128(DW_FORM.indirect),
    0, 0,
    // abbrev 2
    ...encodeUleb128(2), ...encodeUleb128(DW_TAG.variable), 0,
    ...encodeUleb128(DW_AT.const_value), ...encodeUleb128(DW_FORM.indirect),
    ...encodeUleb128(DW_AT.byte_size), ...encodeUleb128(DW_FORM.indirect),
    0, 0,
    0,
  ]);

  const cuBody = [
    // DIE 1 (CU): str_offsets_base = 8 (entriesStart), name = indirect(strx1, 0)
    ...encodeUleb128(1),
    ...u32le(8),
    ...encodeUleb128(DW_FORM.strx1), 0,
    // DIE 2 (variable): const_value = indirect(implicit_const, sleb(-42)), byte_size = indirect(indirect(data4, 16))
    ...encodeUleb128(2),
    ...encodeUleb128(DW_FORM.implicit_const), ...encodeSleb128(-42n),
    ...encodeUleb128(DW_FORM.indirect), ...encodeUleb128(DW_FORM.data4), ...u32le(16),
    // end of CU children
    0,
  ];
  const debug_info = buildDwarf5Unit(cuBody);

  const parsed = parseDebugInfo({ debug_info, debug_abbrev, debug_str, debug_str_offsets }, undefined, { endian: 'little' });
  assert.equal(parsed.complete, true, `expected complete parse, got diagnostics: ${parsed.diagnostics.join('; ')}`);

  const dies = [...parsed.dies.values()];
  assert.equal(dies.length, 2);

  const cuDie = dies[0];
  const nameAttr = cuDie.attributes.get(DW_AT.name);
  assert.equal(nameAttr.form, DW_FORM.strx1, 'attributes map must store resolved actual form');
  assert.equal(nameAttr.value, 'indirect_strx_name', 'indirect DW_FORM_strx1 must resolve through .debug_str_offsets');

  const varDie = dies[1];
  const constAttr = varDie.attributes.get(DW_AT.const_value);
  assert.equal(constAttr.form, DW_FORM.implicit_const);
  assert.equal(constAttr.value, -42n, 'DW_FORM_indirect -> DW_FORM_implicit_const must read SLEB128 from .debug_info');

  const sizeAttr = varDie.attributes.get(DW_AT.byte_size);
  assert.equal(sizeAttr.form, DW_FORM.data4, 'nested DW_FORM_indirect must resolve to final actual form');
  assert.equal(sizeAttr.value, 16n);
});

// ---------------------------------------------------------------------------
// 2. [P1] pdb.js — nil module (streamIndex === 0xffff && declaredSize === 0) stays complete
// ---------------------------------------------------------------------------
test('2. [P1] pdb.js treats streamIndex === 0xffff && declaredSize === 0 as valid complete nil module', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);

  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  const mods = parseModuleInfo(dbiBytes, dbi).modules;
  assert.ok(mods.length > 0, 'fixture must have at least one module');

  // Module 0 starts at DBI offset 64:
  //   +34: uint16 ModuleSymStream (streamIndex)
  //   +36: uint32 SymByteSize (symbolByteSize)
  const mod0Offset = 64;
  const nilZeroPatch = Uint8Array.from([0xff, 0xff, ...u32le(0)]);
  const pdbWithNilZero = patchMsfStreamBytes(original, 3, mod0Offset + 34, nilZeroPatch);

  const provider = new PdbDebugInfoProvider();
  const okResult = provider.probe({ ...pdbImage(variant), pdbBytes: pdbWithNilZero });
  assert.equal(okResult.identity.verdict, 'matched-authoritative');
  assert.equal(okResult.parsed.symbols.complete, true, 'nil module with declaredSize === 0 must not mark symbols incomplete');

  // Non-empty declared range on a nil module must still fail closed.
  const nilNonEmptyPatch = Uint8Array.from([0xff, 0xff, ...u32le(8)]);
  const pdbWithNilNonEmpty = patchMsfStreamBytes(original, 3, mod0Offset + 34, nilNonEmptyPatch);
  const badResult = provider.probe({ ...pdbImage(variant), pdbBytes: pdbWithNilNonEmpty });
  assert.equal(badResult.parsed.symbols.complete, false, 'nil module with declaredSize > 4 must mark symbols incomplete');

  // Malformed partial declaredSize (1..3) on a nil module must also fail closed.
  const nilPartialPatch = Uint8Array.from([0xff, 0xff, ...u32le(2)]);
  const pdbWithNilPartial = patchMsfStreamBytes(original, 3, mod0Offset + 34, nilPartialPatch);
  const partialResult = provider.probe({ ...pdbImage(variant), pdbBytes: pdbWithNilPartial });
  assert.equal(partialResult.parsed.symbols.complete, false, 'nil module with malformed declaredSize (2) must mark symbols incomplete');
});

// ---------------------------------------------------------------------------
// 3. [P1] constraints.js & graph.js — totalSizeBytes / sizeBytes normalization & union aggregate bound
// ---------------------------------------------------------------------------
test('3. [P1] constraints.js and graph.js normalize totalSizeBytes/sizeBytes and enforce union aggregate bounds', () => {
  const claim = (descriptor) => createTypeClaim({ layer: 'structural', entityId: 'ent:agg', descriptor });

  // Struct totalSizeBytes vs sizeBytes conflict
  assert.equal(
    claimsConflict(
      claim({ kind: 'struct', totalSizeBytes: 16 }),
      claim({ kind: 'struct', sizeBytes: 32 }),
    ),
    true,
    'struct totalSizeBytes=16 must conflict with sizeBytes=32',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'struct', totalSizeBytes: 16 }),
      claim({ kind: 'struct', totalSizeBytes: 32 }),
    ),
    true,
    'struct totalSizeBytes=16 must conflict with totalSizeBytes=32',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'struct', totalSizeBytes: 16 }),
      claim({ kind: 'struct', sizeBytes: 16 }),
    ),
    false,
    'struct totalSizeBytes=16 and sizeBytes=16 are compatible',
  );

  // Array totalSizeBytes vs sizeBytes conflict
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', totalSizeBytes: 32 }),
      claim({ kind: 'array', sizeBytes: 64 }),
    ),
    true,
    'array totalSizeBytes=32 must conflict with sizeBytes=64',
  );

  // Union explicit aggregate bound checked against field extent (both totalSizeBytes and sizeBytes)
  assert.equal(
    claimsConflict(
      claim({ kind: 'union', totalSizeBytes: 8 }),
      claim({ offset: 0, sizeBytes: 16, memberType: 'u128' }),
    ),
    true,
    'union totalSizeBytes=8 must conflict with field [0, 16)',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'union', sizeBytes: 8 }),
      claim({ offset: 0, sizeBytes: 16, memberType: 'u128' }),
    ),
    true,
    'union sizeBytes=8 must conflict with field [0, 16)',
  );

  // Graph merge: totalSizeBytes-only struct preserves explicit totalSizeBytes
  const graphOk = new TypeConstraintGraph();
  graphOk.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'struct', totalSizeBytes: 24 }),
    evidenceIds: ['ev-size'],
  }));
  graphOk.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ offset: 0, sizeBytes: 8, memberType: 'u64' }),
    evidenceIds: ['ev-field'],
  }));
  const structDecision = graphOk.solveEntity('ent:agg').layers.structural;
  assert.equal(structDecision.confidence, 'certain');
  assert.equal(structDecision.selected.descriptor.totalSizeBytes, 24);
  assert.equal(structDecision.selected.descriptor.sizeBytes, 24);

  // Graph merge: totalSizeBytes=8 + field [0, 16) must contradict, never silently grow
  const graphBad = new TypeConstraintGraph();
  graphBad.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'struct', totalSizeBytes: 8 }),
    evidenceIds: ['ev-size-8'],
  }));
  graphBad.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ offset: 0, sizeBytes: 16, memberType: 'u128' }),
    evidenceIds: ['ev-field-16'],
  }));
  const badDecision = graphBad.solveEntity('ent:agg').layers.structural;
  assert.equal(badDecision.confidence, 'unknown');
  assert.ok(badDecision.contradictions.length > 0);

  // Graph merge: union totalSizeBytes=16 vs sizeBytes=32 must contradict
  const graphUnionBad = new TypeConstraintGraph();
  graphUnionBad.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'union', totalSizeBytes: 16 }),
    evidenceIds: ['ev-u1'],
  }));
  graphUnionBad.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'union', sizeBytes: 32 }),
    evidenceIds: ['ev-u2'],
  }));
  const unionBadDecision = graphUnionBad.solveEntity('ent:agg').layers.structural;
  assert.equal(unionBadDecision.confidence, 'unknown');
  assert.ok(unionBadDecision.contradictions.length > 0);
});

// ---------------------------------------------------------------------------
// 4. [P1] constraints.js — aggregateMembersConflict partial overlap & members vs single-field conflict
// ---------------------------------------------------------------------------
test('4. [P1] constraints.js detects partial member overlap at different start offsets and members vs single-field conflicts', () => {
  const claim = (descriptor) => createTypeClaim({ layer: 'structural', entityId: 'ent:overlap', descriptor });

  // 4(a): partial overlap [0, 8) vs [4, 12) even with identical memberType
  const membersA = claim({
    kind: 'struct',
    members: [{ offset: 0, sizeBytes: 8, memberType: { kind: 'int', widthBits: 64 } }],
  });
  const membersB = claim({
    kind: 'struct',
    members: [{ offset: 4, sizeBytes: 8, memberType: { kind: 'int', widthBits: 64 } }],
  });
  assert.equal(claimsConflict(membersA, membersB), true, 'partial overlap [0,8) vs [4,12) must conflict');

  // 4(b): members array descriptor vs conflicting single-field descriptor (both orders)
  const fieldSameOffsetDiffSize = claim({ offset: 0, sizeBytes: 4, memberType: { kind: 'int', widthBits: 32 } });
  const fieldPartialOverlap = claim({ offset: 4, sizeBytes: 8, memberType: { kind: 'int', widthBits: 64 } });
  const fieldDisjoint = claim({ offset: 8, sizeBytes: 4, memberType: { kind: 'int', widthBits: 32 } });

  assert.equal(claimsConflict(membersA, fieldSameOffsetDiffSize), true);
  assert.equal(claimsConflict(fieldSameOffsetDiffSize, membersA), true);
  assert.equal(claimsConflict(membersA, fieldPartialOverlap), true);
  assert.equal(claimsConflict(fieldPartialOverlap, membersA), true);
  assert.equal(claimsConflict(membersA, fieldDisjoint), false, 'disjoint single field must remain compatible');
  assert.equal(claimsConflict(fieldDisjoint, membersA), false);
});

// ---------------------------------------------------------------------------
// 5. [P1] planner.js — sourcePoolCap overflow/drop reflected in sourceTotals & sourcePoolTruncated
// ---------------------------------------------------------------------------
test('5. [P1] planner.js accounts for sourcePoolCap overflow/eviction/drops and marks sourcePoolTruncated/incomplete', async () => {
  // With maxFunctions=4 (planner share=1), maxSearchResults=20 -> sourcePoolCap('lexical') = max(48, 8, 40) = 48.
  // Supply 4 terms x 40 distinct addresses = 160 distinct addresses (> 3 * 48 = 144, triggering staged, probation, eviction, and direct drops).
  const terms = ['alpha', 'beta', 'gamma', 'delta'];
  const termBase = { alpha: 0x10000n, beta: 0x20000n, gamma: 0x30000n, delta: 0x40000n };

  const makeTools = (perTermCount) => ({
    search_functions: async (term) => {
      const base = termBase[term] ?? 0x90000n;
      const results = [];
      for (let i = 0; i < perTermCount; i += 1) {
        results.push({ addr: base + BigInt(i * 0x10), name: `${term}_fn_${i}` });
      }
      return { results, complete: true, total: results.length, returned: results.length };
    },
    search_strings: async () => ({ results: [], complete: true, total: 0, returned: 0 }),
    get_xrefs: async () => ({ functions: [], complete: true, total: 0, returned: 0 }),
    get_callers: async () => ({ results: [], complete: true, total: 0, returned: 0 }),
    get_callees: async () => ({ results: [], complete: true, total: 0, returned: 0 }),
    get_function: async (addr) => ({ address: addr, name: `fn_${addr.toString(16)}`, cost: { disassembly: 1 } }),
    get_semantic_facts: async () => ({ results: [], complete: true, total: 0, returned: 0 }),
  });

  const query = {
    action: 'read',
    entity: { terms },
    context: { terms: [] },
    event: { terms: [] },
    confident: true,
  };

  // Overflow case: 4 * 40 = 160 distinct addresses supplied into lexical pool capped at 48
  const overflowResult = await planAnalysisGoal(query, {}, {
    tools: makeTools(40),
    maxFunctions: 4,
    maxSearchResults: 20,
    maxExpansions: 0,
  });
  assert.equal(overflowResult.candidateSources.stored.lexical, 48);
  assert.equal(overflowResult.candidateSources.supplied.lexical, 160);
  assert.equal(overflowResult.candidateSources.completeness.bySource.lexical.complete, false);
  assert.equal(overflowResult.candidateSources.completeness.complete, false);
  assert.equal(overflowResult.completeness.complete, false);
  assert.equal(overflowResult.completeness.reason, 'candidate-source-limit');
  assert.ok(overflowResult.missingEvidence.includes('candidate-source-limit'));

  // Non-overflow case: 4 * 2 = 8 distinct addresses supplied (well below cap 48)
  const okResult = await planAnalysisGoal(query, {}, {
    tools: makeTools(2),
    maxFunctions: 24,
    maxSearchResults: 20,
    maxExpansions: 0,
  });
  assert.equal(okResult.candidateSources.stored.lexical, 8);
  assert.equal(okResult.candidateSources.supplied.lexical, 8);
  assert.equal(okResult.candidateSources.completeness.bySource.lexical.complete, true);
  assert.equal(okResult.candidateSources.completeness.complete, true);
  assert.equal(okResult.missingEvidence.includes('candidate-source-limit'), false);
});

// ---------------------------------------------------------------------------
// 6. [P2] lattice.js — addRange half-bounded width/overflow & widenPointsTo prior metadata merge
// ---------------------------------------------------------------------------
test('6. [P2] lattice.js validates half-bounded addRange overflow/widthBits and preserves prior metadata in widenPointsTo', () => {
  const maxSigned64 = (1n << 63n) - 1n;
  const minSigned64 = -(1n << 63n);

  // 6(a): half-bounded addRange checks invalid widthBits and finite-end overflow
  const halfOpenUpper = createOffsetRange(0n, null);
  for (const badWidth of [null, undefined, 0, -8, 1, 513]) {
    const res = addRange(halfOpenUpper, 4n, badWidth);
    assert.equal(res.lost, 'width-overflow', `half-bounded addRange with widthBits=${String(badWidth)} must fail closed`);
    assert.equal(res.range, UNBOUNDED_RANGE);
  }

  const nearMaxHalfOpen = createOffsetRange(maxSigned64, null);
  const overflowUpper = addRange(nearMaxHalfOpen, 1n, 64);
  assert.equal(overflowUpper.lost, 'width-overflow');
  assert.equal(overflowUpper.range, UNBOUNDED_RANGE);

  const nearMinHalfOpen = createOffsetRange(null, minSigned64);
  const overflowLower = addRange(nearMinHalfOpen, -1n, 64);
  assert.equal(overflowLower.lost, 'width-overflow');
  assert.equal(overflowLower.range, UNBOUNDED_RANGE);

  const inRangeHalfOpen = addRange(createOffsetRange(8n, null), 16n, 64);
  assert.equal(inRangeHalfOpen.lost, null);
  assert.equal(inRangeHalfOpen.range.min, 24n);
  assert.equal(inRangeHalfOpen.range.max, null);

  // 6(b): widenPointsTo preserves prior evidenceIds, widthBits, ROOT_DESCRIPTOR_PROOF, canonicalRootStorageClass
  const proof = deriveCanonicalAddressProof({
    functionId: 'track4-widen-proof',
    values: [{
      id: 'v-root',
      kind: 'entry',
      variableKey: 'root-heap',
      machineType: { kind: 'address', widthBits: 64 },
      metadata: {
        canonicalRoot: {
          kind: 'heap-like',
          rootEntityId: 'alloc:1',
          baseOffset: 0,
          addressSpace: 'memory',
          linearOffsets: true,
        },
      },
    }],
    nodes: [],
    blocks: [],
  }, 'v-root', { addressSpace: 'memory' });
  assert.equal(proof.kind, 'rooted');

  const priorTarget = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'alloc:1',
    canonicalRootStorageClass: 'heap',
    offsetRange: exactRange(0n),
    widthBits: 64,
    evidenceIds: ['ev-prior'],
  }, proof);

  const nextTargetSameWidth = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity: priorTarget.rootIdentity,
    rootEntityId: 'alloc:1',
    offsetRange: createOffsetRange(0n, 8n),
    widthBits: 64,
    evidenceIds: ['ev-next'],
  });

  const widened = widenPointsTo(
    createPointsToSet({ targets: [priorTarget] }),
    createPointsToSet({ targets: [nextTargetSameWidth] }),
  );
  assert.equal(widened.targets.length, 1);
  const wt = widened.targets[0];
  assert.equal(wt.offsetRange.min, 0n);
  assert.equal(wt.offsetRange.max, null);
  assert.deepEqual([...wt.evidenceIds], ['ev-next', 'ev-prior'], 'widenPointsTo must merge prior and next evidenceIds');
  assert.equal(wt.widthBits, 64, 'widenPointsTo must preserve matching widthBits');
  assert.equal(provenSeparationAuthority(wt), 'root-descriptor', 'widenPointsTo must preserve prior ROOT_DESCRIPTOR_PROOF');
  assert.equal(wt.canonicalRootStorageClass, 'heap', 'widenPointsTo must preserve prior canonicalRootStorageClass');

  // Conflicting widthBits and conflicting canonicalRootStorageClass must conservatively drop
  const nextTargetConflict = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity: priorTarget.rootIdentity,
    rootEntityId: 'alloc:1',
    canonicalRootStorageClass: 'stack',
    offsetRange: createOffsetRange(0n, 16n),
    widthBits: 32,
    evidenceIds: ['ev-conflict'],
  });
  const widenedConflict = widenPointsTo(
    createPointsToSet({ targets: [priorTarget] }),
    createPointsToSet({ targets: [nextTargetConflict] }),
  );
  const wtc = widenedConflict.targets[0];
  assert.equal(wtc.widthBits, null, 'conflicting widthBits must degrade to null');
  assert.equal(wtc.canonicalRootStorageClass, undefined, 'conflicting canonicalRootStorageClass must be dropped');
  assert.deepEqual([...wtc.evidenceIds], ['ev-conflict', 'ev-prior']);
});

// ---------------------------------------------------------------------------
// 7. [P2] format-safe.js — elf-add-nobits-section verifies .shstrtab prefix & whole-file masked digest
// ---------------------------------------------------------------------------
test('7. [P2] format-safe.js rejects .shstrtab prefix tampering and outside-section tampering in elf-add-nobits-section', async () => {
  const manifestPath = path.join(ROOT, 'tests/phase12/rebuild/fixtures/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const elfFixture = manifest.fixtures.find((fixture) => fixture.profile === 'elf:64');
  assert.ok(elfFixture, 'elf:64 fixture must exist');

  const source = new Uint8Array(fs.readFileSync(path.join(ROOT, elfFixture.path)));
  const sourceHash = `bytes:${stableDigestBytes(source)}`;
  const transaction = createFormatSafeRebuildTransaction({
    binaryId: 'binary:elf:track4-nobits-integrity',
    source,
    sourceHash,
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'hex-loader:openBinary:v1',
    mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 16, alignment: 8 },
  });
  const materialized = await materializeRebuildTransaction(transaction, source);
  assert.equal(materialized.status, 'materialized');

  // Valid materialized output passes
  const validResult = validateFormatSafeMutation({
    transaction,
    original: source,
    output: materialized.bytes,
  });
  assert.equal(validResult.ok, true, `expected valid elf-add-nobits-section, got: ${validResult.reason}`);

  // Tamper 1: alter an existing byte inside original .shstrtab [0..sourceNames.size)
  // Find the .shstrtab section offset via the name op (offset = sourceNames.offset + sourceNames.size)
  const nameOp = transaction.operations.find((op) => op.id === 'format-safe:elf:nobits:name');
  assert.ok(nameOp, 'name operation must exist');
  const shstrtabTampered = materialized.bytes.slice();
  const originalShstrtabByteOffset = Number(nameOp.offset) - 109 + 18; // inside original .shstrtab name entry in [0..sourceNames.size)
  shstrtabTampered[originalShstrtabByteOffset] ^= 0x01;

  const shstrtabResult = validateFormatSafeMutation({
    transaction,
    original: source,
    output: shstrtabTampered,
  });
  assert.equal(shstrtabResult.ok, false, 'mutating original .shstrtab prefix bytes must fail validation');
  assert.equal(shstrtabResult.reason, 'format-safe-elf-name-table-mismatch');

  // Tamper 2: alter a byte outside any section (ELF64 header e_ident padding byte at offset 12)
  const outsideSectionTampered = materialized.bytes.slice();
  outsideSectionTampered[12] ^= 0xff;

  const outsideResult = validateFormatSafeMutation({
    transaction,
    original: source,
    output: outsideSectionTampered,
  });
  assert.equal(outsideResult.ok, false, 'mutating bytes outside sections must fail whole-file masked digest validation');
  assert.equal(outsideResult.reason, 'format-safe-elf-unchanged-bytes-differ');
});
