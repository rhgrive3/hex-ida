import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';
import {
  DECOMPILE_DTO_SCHEMA,
  DECOMPILE_INTERNAL_FIELDS,
  DECOMPILE_PUBLIC_FIELDS,
} from '../../../js/analysis/query/app-adapter.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { decompile } from '../../../js/decompile.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { analyzeSemanticFunction } from '../../../js/analysis/semantic-function.js';

// The decompile query DTO contract:
//
//   * only the explicit presentation schema is published, so the result is
//     bounded by presentation data instead of the internal analysis graph;
//   * the internal graph (semantic IR, ctx observers, high variables, cAst,
//     phase8) is producer-owned and never crosses the query boundary;
//   * a field the schema does not know is never silently dropped as complete —
//     it fails closed when unclonable and is reported as explicit schema drift
//     otherwise;
//   * the exported schema lists are frozen arrays (not a mutable Set) so a
//     consumer cannot reclassify a field at runtime.
//
// These tests replace the previous shallow-copy/deny-list behaviour, which
// overflowed structuredClone() on large functions while leaving the graph in
// the published result.

function apiFor(value) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-decompiler-dto', gen: 1 },
    async getDecompile() { return value; },
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

async function run(value) {
  const api = apiFor(value);
  return api.decompile(await api.snapshot(), '0x1000');
}

function deepChain(depth) {
  let node = { id: 'leaf', op: 'const' };
  for (let index = 0; index < depth; index++) node = { id: `n${index}`, op: 'add', left: node, right: { id: `r${index}` } };
  return node;
}

function presentation() {
  return {
    pseudocode: 'int f(void) { return 1; }',
    lines: [{ kind: 'return', indent: 0, text: 'return 1;', row: 0, addr: 0 }],
    renderProvenance: { snapshotId: 'render-1', completeness: 'complete', reverse: { 'addr:0': ['L0:return'] }, entities: {}, ledger: [] },
  };
}

// A. Small normal result: presentation fields are preserved and immutable.
test('A. decompile query preserves presentation fields as an immutable detached snapshot', async () => {
  const producer = presentation();
  const result = await run(producer);

  assert.equal(result.completeness, 'complete');
  assert.equal(result.value.pseudocode, producer.pseudocode);
  assert.deepEqual(result.value.lines, producer.lines);
  assert.deepEqual(result.value.renderProvenance, producer.renderProvenance);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.lines), true);
  assert.equal(Object.isFrozen(result.value.renderProvenance), true);
  assert.notEqual(result.value.lines, producer.lines);
  assert.notEqual(result.value.renderProvenance, producer.renderProvenance);
});

// B. Large synthetic producer: the scale that overflows the clone envelope
// before the fix must publish a bounded presentation result afterwards.
test('B. large internal producers no longer overflow the clone envelope and publish a bounded result', async () => {
  // The published DTO must not carry the graph, so this depth only has to be
  // deep enough that structuredClone() cannot detach it directly.
  const detached = { values: deepChain(50_000) };
  assert.throws(() => structuredClone(detached), RangeError,
    'the raw producer graph is not clone-safe at this scale');

  const build = (depth) => ({
    ...presentation(),
    ir: { values: deepChain(depth), provenance: { source: 'semantic-ir/v2' }, defUse: () => new Map() },
    highVariables: { valueToGroup: new Map(), groups: [] },
    ctx: { values: { at: () => null, defAt: () => null }, rowOfAddress: () => 0, unknownInstructions: 7 },
  });

  const large = await run(build(50_000));
  assert.equal(large.value.pseudocode, presentation().pseudocode);
  assert.deepEqual(large.value.lines, presentation().lines);
  assert.equal(large.value.unknownInstructions, 7);
  for (const key of ['ir', 'highVariables', 'ctx']) assert.equal(Object.hasOwn(large.value, key), false, key);

  // Bounded: published size is a function of presentation data only, so it does
  // not grow with the internal analysis graph.
  const small = await run(build(2_000));
  const largeSize = JSON.stringify(large.value).length;
  assert.equal(largeSize, JSON.stringify(small.value).length, 'output size is independent of internal graph size');
  assert.ok(largeSize < 4096, `bounded result, got ${largeSize} bytes`);
});

// C. Unrelated callbacks stay fail-closed, and non-schema fields are not published.
test('C. unrelated unclonable metadata still fails closed', async () => {
  await assert.rejects(
    run({ pseudocode: 'int f(void) { return 1; }', metadata: { callback: () => 'must remain fail-closed' } }),
    /analysis-query-value-unclonable/,
  );
});

// C2. A cloneable field outside the schema is a projection loss, not a silent
// drop: the producer added a field the DTO does not publish, so the query must
// not hand back an apparently complete result.
test('C2. a cloneable field outside the schema is reported as explicit schema drift', async () => {
  const result = await run({ pseudocode: 'int f(void) { return 1; }', metadata: { note: 'clone-safe, not part of the schema' } });

  assert.equal(Object.hasOwn(result.value, 'metadata'), false, 'a non-schema field is never published');
  assert.equal(result.value.pseudocode, 'int f(void) { return 1; }');
  assert.equal(result.completeness, 'partial', 'schema drift must not look complete');
  assert.equal(result.status.reason, 'decompile-projection-schema-drift');
  assert.equal(result.status.projection.schema, DECOMPILE_DTO_SCHEMA);
  assert.deepEqual(result.status.projection.unexpected, ['metadata']);
  assert.deepEqual(result.status.projection.withheld, []);

  // A producer that emits only schema fields stays complete.
  const clean = await run(presentation());
  assert.equal(clean.completeness, 'complete');
  assert.equal(clean.status.projection ?? null, null);
});

// C3. The exported schema is immutable contract documentation, not a mutable
// runtime authority. `Object.freeze(new Set(...))` would still allow `.add()`.
test('C3. the exported schema cannot be mutated to reclassify a field', async () => {
  assert.equal(Object.isFrozen(DECOMPILE_PUBLIC_FIELDS), true);
  assert.equal(Object.isFrozen(DECOMPILE_INTERNAL_FIELDS), true);
  assert.equal(Array.isArray(DECOMPILE_PUBLIC_FIELDS), true);
  assert.equal(Array.isArray(DECOMPILE_INTERNAL_FIELDS), true);
  // No Set mutation surface is exported.
  assert.equal(DECOMPILE_PUBLIC_FIELDS.add, undefined);
  assert.equal(DECOMPILE_INTERNAL_FIELDS.add, undefined);
  assert.equal(DECOMPILE_INTERNAL_FIELDS.delete, undefined);

  assert.throws(() => { DECOMPILE_PUBLIC_FIELDS.push('ir'); }, TypeError);
  assert.throws(() => { DECOMPILE_INTERNAL_FIELDS.push('pseudocode'); }, TypeError);
  assert.throws(() => { DECOMPILE_PUBLIC_FIELDS[0] = 'ir'; }, TypeError);

  // The classification used at runtime is unchanged by any of that: an internal
  // field stays unpublished and a public field stays published.
  assert.equal(DECOMPILE_INTERNAL_FIELDS.includes('ir'), true);
  assert.equal(DECOMPILE_PUBLIC_FIELDS.includes('ir'), false);
  const result = await run({
    pseudocode: 'int f(void) { return 1; }',
    ir: { values: [], defUse: () => new Map() },
    semanticControlRenderHistory: { completeness:'complete', byControlId:new Map() },
  });
  assert.equal(result.completeness, 'complete');
  assert.equal(Object.hasOwn(result.value, 'ir'), false);
  assert.equal(Object.hasOwn(result.value, 'semanticControlRenderHistory'), false);
  assert.equal(result.value.pseudocode, 'int f(void) { return 1; }');
});

// D. The real legacy decompiler result keeps its navigation/provenance behaviour.
test('D. legacy decompiler results stay navigable through the query boundary', async () => {
  const rows = [{ row: 0, address: 0x1000n, mn: 'mov', ops: 'w0, #7' }, { row: 1, address: 0x1004n, mn: 'ret', ops: '' }];
  const model = buildSemanticModel(rows, { startRow: 0, endRow: 1, rowOfAddress: (address) => Number((address - 0x1000n) / 4n), name: 'return_seven' });
  const direct = decompile(model, { addr: 0x1000n, name: 'return_seven' });
  assert.ok(direct.ir && direct.ctx, 'fixture crosses the real internal result boundary');

  const api = new AnalysisQueryAPI({
    ...createAppAnalysisQueryAdapter({ getDecompile: async () => direct }),
    currentIdentity: async () => ({ binaryId: 'dto-navigation', projectRevision: 1, analysisEpoch: 1, artifactVersions: {} }),
  });
  const query = await api.decompile(await api.snapshot(), '0x1000');

  assert.equal(Object.hasOwn(query.value, 'ir'), false);
  assert.equal(Object.hasOwn(query.value, 'ctx'), false);
  assert.deepEqual(query.value.renderProvenance, direct.renderProvenance);
  assert.notEqual(query.value.renderProvenance, direct.renderProvenance);

  const navigation = createDecompilerNavigation(query, { currentSnapshot: () => api.snapshot() });
  assert.equal(navigation.available, true, navigation.reason);
  const line = query.value.lines.findIndex((entry) => /return/.test(entry.text));
  assert.ok(line >= 0, 'rendered lines are published');
  assert.equal((await navigation.selectLine(line)).state, 'ready');
});

// D2. Every field the real legacy decompiler emits is classified by the schema,
// so the projection reports no drift for a genuine producer.
test('D2. the real legacy producer result has no unclassified field', async () => {
  const rows = [{ row: 0, address: 0x1000n, mn: 'mov', ops: 'w0, #7' }, { row: 1, address: 0x1004n, mn: 'ret', ops: '' }];
  const model = buildSemanticModel(rows, { startRow: 0, endRow: 1, rowOfAddress: (address) => Number((address - 0x1000n) / 4n), name: 'return_seven' });
  const direct = decompile(model, { addr: 0x1000n, name: 'return_seven' });

  const classified = new Set([...DECOMPILE_PUBLIC_FIELDS, ...DECOMPILE_INTERNAL_FIELDS]);
  const unclassified = Object.keys(direct).filter((key) => !classified.has(key));
  assert.deepEqual(unclassified, [], 'the schema must classify every real producer field');

  const query = await run(direct);
  assert.equal(query.completeness, 'complete');
  assert.equal(query.status.projection ?? null, null);
});

/* ── semanticIR() cloneability against the canonical production IR ───────── */

function regNumber(name) { return Number(String(name).replace(/^x/, '')); }
function littleEndianWord(word) {
  return Uint8Array.from([word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]);
}
function encodeJal(rd, immediate) {
  const imm = Number(BigInt.asUintN(21, BigInt(immediate)));
  const word = (((imm >>> 20) & 1) << 31) | (((imm >>> 1) & 0x3ff) << 21) | (((imm >>> 11) & 1) << 20)
    | (((imm >>> 12) & 0xff) << 12) | (regNumber(rd) << 7) | 0x6f;
  return littleEndianWord(word >>> 0);
}
function encodeBranch(op, rs1, rs2, immediate) {
  const funct3 = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 }[op];
  const imm = Number(BigInt.asUintN(13, BigInt(immediate)));
  const word = (((imm >>> 12) & 1) << 31) | (((imm >>> 5) & 0x3f) << 25) | (regNumber(rs2) << 20)
    | (regNumber(rs1) << 15) | (funct3 << 12) | (((imm >>> 1) & 0xf) << 8) | (((imm >>> 11) & 1) << 7) | 0x63;
  return littleEndianWord(word >>> 0);
}
function riscvControl(op, fields = {}, address = 0x1000n) {
  const merged = { rd: 'x0', rs1: 'x10', rs2: 'x11', imm: 4, ...fields };
  const rawBytes = op === 'jal' ? encodeJal(merged.rd, merged.imm) : encodeBranch(op, merged.rs1, merged.rs2, merged.imm);
  return {
    contractVersion: 'riscv64-decoded-instruction/v1', instructionId: `rv-${op}@${address}`,
    origin: { instructionIds: [`rv-${op}@${address}`] }, mode: 'rv64im', address, size: 4,
    instructionAlignment: 4, rawBytes, fields: { supported: true, op, compressed: false, ...merged },
  };
}

function canonicalSemanticFunction() {
  return analyzeSemanticFunction({
    architecture: 'riscv64', platform: 'linux', abiId: 'lp64',
    binaryId: 'bin-canonical-ir', sliceId: 'bin-canonical-ir-slice',
    decoderSemanticVersion: 'capstone-5-riscv64-word-exact-v1', mode: 'rv64im',
    instructions: [riscvControl('beq', { imm: 4 }, 0x1000n), riscvControl('jal', { rd: 'x1', imm: 8 }, 0x1004n)],
    name: 'canonical_probe',
  });
}

function canonicalApi(canonical) {
  const stored = {
    architecture: 'riscv64',
    regions: [{ id: 'r0', vmAddr: 0x1000n, size: 0x100n, exec: true, read: true, write: false }],
    sliceIndex: 0,
    canDisassemble: true,
  };
  const app = {
    store: { get: (key) => stored[key] ?? null },
    backend: {
      binaryId: 'bin-canonical-ir', gen: 1,
      analyzeSemanticFunction: async () => canonical,
      platformInfo: { productDescriptor: { formatMetadata: { abi: 'lp64', bits: 64, platform: 'linux' } } },
    },
    symbols: { functionAt: () => ({ start: 0x1000n, end: 0x1008n }), nameAt: () => 'canonical_probe', functionCount: 1, funcs: [0x1000n] },
  };
  return new AnalysisQueryAPI({
    ...createAppAnalysisQueryAdapter(app),
    currentIdentity: async () => ({ binaryId: 'bin-canonical-ir', projectRevision: 1, analysisEpoch: 1, artifactVersions: {} }),
  });
}

// E. The canonical Semantic IR served by semanticIR() is the Semantic IR v2
// pipeline value, which owns no runtime observer and therefore crosses the
// clone boundary intact.
test('E. semanticIR() publishes the canonical production Semantic IR across the clone boundary', async () => {
  const canonical = canonicalSemanticFunction();
  const ir = canonical.pipeline.semanticIr;
  assert.ok(ir, 'the canonical pipeline publishes a semantic IR');
  assert.equal(ir.defUse, undefined, 'the canonical Semantic IR v2 owns no runtime defUse closure');
  assert.doesNotThrow(() => structuredClone(ir), 'the canonical Semantic IR is clone-safe');
  assert.doesNotThrow(() => structuredClone(canonical), 'the canonical semantic function result is clone-safe');

  const api = canonicalApi(canonical);
  const snapshot = await api.snapshot();
  const result = await api.semanticIR(snapshot, 0x1000n);

  assert.equal(result.completeness, 'complete');
  assert.equal(result.value.contractVersion, ir.contractVersion);
  assert.deepEqual(result.value.blocks, JSON.parse(JSON.stringify(ir.blocks)));
  assert.equal(Object.isFrozen(result.value), true, 'the published IR is immutable');
});

// F. The ARM64 legacy compatibility IR is now a detached, clone-safe value too,
// but semanticIR() still serves only the canonical Semantic IR v2 pipeline
// surface. The legacy analyzeFunction route has no `pipeline.semanticIr`, so the
// query remains explicitly unsupported instead of smuggling raw IR back through
// the decompile DTO.
test('F. the ARM64 legacy route keeps its IR clone-safe but serves no semanticIR', async () => {
  const rows = [{ row: 0, address: 0x1000n, mn: 'mov', ops: 'w0, #7' }, { row: 1, address: 0x1004n, mn: 'ret', ops: '' }];
  const model = buildSemanticModel(rows, { startRow: 0, endRow: 1, rowOfAddress: (address) => Number((address - 0x1000n) / 4n), name: 'return_seven' });
  const direct = decompile(model, { addr: 0x1000n, name: 'return_seven' });

  assert.equal(typeof direct.ir.defUse, 'undefined', 'the legacy IR must not own a runtime defUse closure');
  assert.doesNotThrow(() => structuredClone(direct.ir), 'the legacy IR must remain clone-safe');

  const api = new AnalysisQueryAPI({
    ...createAppAnalysisQueryAdapter({ analyzeFunction: async () => direct }),
    currentIdentity: async () => ({ binaryId: 'dto-legacy-ir', projectRevision: 1, analysisEpoch: 1, artifactVersions: {} }),
  });
  const result = await api.semanticIR(await api.snapshot(), 0x1000n);

  assert.equal(result.completeness, 'unsupported');
  assert.equal(result.status.reason, 'semantic-ir-v2-unavailable');
  assert.equal(result.value, null);
});
