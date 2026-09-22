/*
 * Measures C++ high-level recovery on real ARM64 C++ ELF binaries.
 *
 * Two states are compared on the same inputs:
 *   BEFORE  — the capability that already existed on main (`findCxxClasses` +
 *             `readVtable` with a slot cap), which is symbol-only and has no
 *             vtable extent, no typeinfo parse, no inheritance and no
 *             call-site-scoped target set.
 *   AFTER   — the canonical RTTI/vtable evidence producer plus the
 *             call-site-scoped virtual dispatch resolver and the member type
 *             evidence module added by this work.
 *
 * Member type evidence is measured on IR built from the *real* compiled
 * functions: the instruction stream is disassembled from the linked fixture
 * with llvm-objdump, then fed through the repository's own semantic model and
 * IR builders.
 *
 * Usage: node tools/validation/phase7/cxx/measure-cxx-recovery.mjs [--json <path>] [--iterations N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openCxxFixture } from '../../../../tests/phase7/cxx/fixtures/open.mjs';
import { buildCxxFixtures } from '../../../../tests/phase7/cxx/fixtures/build.mjs';
import { findCxxClasses, readVtable } from '../../../../js/rtti.js';
import { buildCxxClassEvidence } from '../../../../js/analysis/cxx/rtti-evidence.js';
import { resolveVirtualTargetSet } from '../../../../js/analysis/cxx/virtual-dispatch.js';
import { recoverMemberTypeEvidence } from '../../../../js/analysis/cxx/member-types.js';
import { buildIR } from '../../../../js/ir-core.js';
import { buildSemanticModel } from '../../../../js/blocks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../');
const FIXTURES = ['game-rtti-o2', 'game-rtti-o0', 'game-nortti-o2'];

// Functions whose member accesses are measured. The first parameter is the
// object pointer in every one of them (member functions and explicit
// `Class*` parameters alike).
const MEMBER_FUNCTIONS = Object.freeze({
  'game-rtti-o0': [
    '_ZN6Player10takeDamageEi',
    '_Z10readHealthP6Entity',
    '_Z9readSpeedP5Actor',
    '_Z10readTargetP6Entity',
    '_Z7isAliveP6Player',
    '_Z12readNameCharP6Playeri',
  ],
  'game-rtti-o2': ['_Z10readHealthP6Entity', '_Z9readSpeedP5Actor'],
});

function parseArgs(argv) {
  const options = { json: path.join(ROOT, 'reports/phase7/cxx-recovery/measurement.json'), iterations: 300 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') options.json = argv[++i];
    else if (argv[i] === '--iterations') options.iterations = Number(argv[++i]);
  }
  return options;
}

function readSymbolNamesAt(probe, address) {
  const out = [];
  for (let index = 0; index < probe.symbols.addrs.length; index++) {
    if (probe.symbols.addrs[index] === address) out.push(probe.symbols.names[index]);
  }
  return out;
}

async function measureBefore(probe) {
  const classes = findCxxClasses(probe.symbols);
  let vtablesRead = 0;
  let slotsEnumerated = 0;
  let slotsPointingAtTypeinfoOrVtable = 0;
  let slotsUnresolved = 0;

  for (const cls of classes) {
    if (cls.vtable == null) continue;
    const table = await readVtable(probe.read, cls.vtable, probe.symbols, 8, { pointerBits: 64 });
    if (!table || !table.slots?.length) continue;
    vtablesRead++;
    for (const slot of table.slots) {
      slotsEnumerated++;
      if (slot.addr == null) { slotsUnresolved++; continue; }
      const names = readSymbolNamesAt(probe, slot.addr);
      if (names.some((name) => /^_?_ZT[VIS]/.test(name))) slotsPointingAtTypeinfoOrVtable++;
    }
  }

  return {
    classesWithName: classes.length,
    abiImplementationClasses: classes.filter((cls) => cls.name.startsWith('__cxxabiv1::')).length,
    vtablesRead,
    slotsEnumerated,
    // Reading a fixed word count past the table end turns the neighbouring
    // object into fake slots; those are counted here as provably non-method
    // entries (typeinfo / vtable / type-name symbols).
    slotsPointingAtTypeinfoOrVtable,
    slotsUnresolved,
    inheritanceEdges: 0,
    typeinfoParsed: 0,
    virtualTargetSets: 0,
    memberTypes: 0,
  };
}

async function measureAfter(probe) {
  const report = await buildCxxClassEvidence({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    maxSlots: 64,
  });

  const classes = report.classes.filter((record) => record.className);
  const inheritanceEdges = classes.reduce((sum, record) => sum + record.resolvedBases.filter((base) => base.className).length, 0);
  const slots = classes.reduce((sum, record) => sum + record.slots.length, 0);
  const slotsWithAliases = classes.reduce((sum, record) => sum + (record.slots?.filter((slot) => slot.aliases.length > 1).length ?? 0), 0);
  const unresolvedSlots = classes.reduce((sum, record) => sum + (record.slots?.filter((slot) => slot.unresolved).length ?? 0), 0);

  // Call-site-scoped target sets: one per (class, slot) pair, which is what a
  // call site on that static class would consume.
  let targetSets = 0;
  let multiTargetSets = 0;
  let singleTargetSets = 0;
  let totalTargets = 0;
  for (const record of classes) {
    for (let slotIndex = 0; slotIndex < record.slots.length; slotIndex++) {
      const set = resolveVirtualTargetSet({ classEvidence: report, receiverClass: record.className, slotIndex });
      if (!set.candidates.length) continue;
      targetSets++;
      totalTargets += set.candidateAddresses.length;
      if (set.candidateAddresses.length > 1) multiTargetSets++;
      else singleTargetSets++;
    }
  }

  return {
    rttiPresent: report.rttiPresent,
    classesWithName: classes.length,
    classesNamedFromVtableSymbolOnly: classes.filter((record) => record.nameSource === 'vtable-symbol').length,
    typeinfoParsed: classes.filter((record) => record.typeinfoAddress != null).length,
    inheritanceEdges,
    vtables: classes.filter((record) => record.slots.length > 0).length,
    slots,
    slotsWithMergedAliases: slotsWithAliases,
    unresolvedSlots,
    virtualTargetSets: targetSets,
    singleTargetSets,
    multiTargetSets,
    totalResolvedTargets: totalTargets,
    readBudget: report.reads,
  };
}

// ── member type evidence on real compiled functions ────────────────────────

function objdumpPath() {
  const candidates = [process.env.LLVM_OBJDUMP, 'llvm-objdump', 'objdump'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function disassembleFunction(elfPath, symbol, objdump) {
  const result = spawnSync(objdump, ['--disassemble-symbols=' + symbol, '--no-show-raw-insn', elfPath], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const rows = [];
  for (const line of (result.stdout || '').split('\n')) {
    const match = /^\s*([0-9a-f]+):\s+([a-z][\w.]*)\s*(.*)$/.exec(line);
    if (!match) continue;
    const address = BigInt(`0x${match[1]}`);
    const mnemonic = match[2];
    const operands = match[3].replace(/\s*\/\/.*$/, '').trim();
    rows.push({ row: rows.length, address, mn: mnemonic, ops: operands });
  }
  return rows.length ? rows : null;
}

/**
 * Predicate: is the value the function's first parameter, a copy of it, or a
 * value reloaded from the stack slot it was spilled to?
 *
 * -O0 keeps the receiver in a stack home, so a caller that only tracks register
 * copies would see no member access at all and would misreport the module as
 * recovering nothing.
 */
function receiverPredicate(ir) {
  const arg = ir?.args?.get?.('x0') ?? null;
  if (!arg) return () => false;
  const aliases = new Set([arg.id]);
  const spill = new Map();
  for (const inst of ir.instructions || []) {
    if (inst.op !== 'store') continue;
    const loc = inst.loc ?? null;
    // A stack location reports `kind:'stack'` with the frame pointer in the
    // address operand, not in `loc.base`.
    const base = loc?.base ?? inst.addr?.base ?? null;
    const baseReg = typeof base?.reg === 'string' ? base.reg : null;
    if (baseReg !== 'sp') continue;
    const disp = loc?.disp ?? inst.addr?.disp ?? null;
    if (disp == null) continue;
    const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
    if (source?.id != null) spill.set(disp.toString(), source.id);
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const inst of ir.instructions || []) {
      if (inst.op === 'mov' || inst.op === 'un') {
        const source = inst.args?.[0]?.value ?? inst.args?.[0];
        const dst = inst.dst;
        if (source?.id == null || dst?.id == null) continue;
        if (!aliases.has(source.id) || aliases.has(dst.id)) continue;
        if (dst.bits != null && source.bits != null && dst.bits !== source.bits) continue;
        aliases.add(dst.id);
        changed = true;
        continue;
      }
      if (inst.op === 'load') {
        const loc = inst.loc ?? null;
        if (loc?.kind !== 'stack') continue;
        const base = loc.base ?? inst.addr?.base ?? null;
        const baseReg = typeof base?.reg === 'string' ? base.reg : null;
        const dst = inst.dst;
        const disp = loc.disp ?? inst.addr?.disp ?? null;
        if (baseReg !== 'sp' || disp == null || dst?.id == null) continue;
        const spilled = spill.get(disp.toString());
        if (spilled == null || !aliases.has(spilled) || aliases.has(dst.id)) continue;
        aliases.add(dst.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return (value) => value?.id != null && aliases.has(value.id);
}

function measureMemberTypes(probe, objdump) {
  const names = MEMBER_FUNCTIONS[probe.name] || [];
  const perFunction = [];
  let fields = 0;
  let typed = 0;
  let widthOnly = 0;
  let unknown = 0;

  for (const symbol of names) {
    const rows = disassembleFunction(probe.artifactPath, symbol, objdump);
    if (!rows) { perFunction.push({ symbol, status: 'disassembly-unavailable' }); continue; }
    const rowOfAddress = (address) => rows.find((row) => row.address === BigInt(address))?.row ?? null;
    let model;
    try {
      model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
    } catch (error) {
      perFunction.push({ symbol, status: `model-failed:${error?.message || error}` });
      continue;
    }
    let ir;
    try {
      const prototype = { returnType: 'uint64', returnBits: 64, returnsValue: true, args: [{ type: 'uint64', bits: 64 }] };
      ir = buildIR(model, {
        rowOfAddress,
        returnType: 'uint64',
        callPrototypeFor: () => prototype,
        semanticMigrationMode: 'semantic-v2-compat',
      });
    } catch (error) {
      perFunction.push({ symbol, status: `ir-failed:${error?.message || error}` });
      continue;
    }
    const report = recoverMemberTypeEvidence({ ir, isReceiverBase: receiverPredicate(ir) });
    fields += report.fieldCount;
    typed += report.typedFieldCount;
    widthOnly += report.widthOnlyFieldCount;
    unknown += report.fieldCount - report.typedFieldCount - report.widthOnlyFieldCount;
    perFunction.push({
      symbol,
      status: 'ok',
      fields: report.fieldCount,
      typed: report.typedFieldCount,
      widthOnly: report.widthOnlyFieldCount,
      details: report.fields.map((field) => ({
        offset: `0x${field.offset.toString(16)}`,
        size: field.size,
        type: field.typeLabel,
        category: field.category,
        rule: field.rule,
      })),
    });
  }

  return { functions: perFunction, fields, typedFieldCount: typed, widthOnlyFieldCount: widthOnly, unknownFieldCount: unknown };
}

// ── performance ────────────────────────────────────────────────────────────

async function measureLatency(iterations, fn) {
  // One warm pass so JIT/caches are not part of the first sample.
  await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { iterations, totalMs: Number(elapsedMs.toFixed(3)), meanMs: Number((elapsedMs / iterations).toFixed(4)) };
}

async function measurePerformance(probes, iterations) {
  const baseline = await measureLatency(iterations, async () => {
    for (const probe of probes) {
      const classes = findCxxClasses(probe.symbols);
      for (const cls of classes) {
        if (cls.vtable == null) continue;
        await readVtable(probe.read, cls.vtable, probe.symbols, 8, { pointerBits: 64 });
      }
    }
  });

  const enabled = await measureLatency(iterations, async () => {
    for (const probe of probes) {
      await buildCxxClassEvidence({
        symbols: probe.symbols,
        read: probe.read,
        pointerBytes: probe.pointerBytes,
        symbolSizeOf: probe.symbolSizeOf,
        sectionEndOf: probe.sectionEndOf,
        maxSlots: 64,
      });
    }
  });

  return {
    baselineSymbolOnly: baseline,
    cxxRecoveryEnabled: enabled,
    meanRatio: baseline.meanMs > 0 ? Number((enabled.meanMs / baseline.meanMs).toFixed(2)) : null,
  };
}

/**
 * Cost when the binary carries no C++ evidence at all (ordinary C binary).
 *
 * Two shapes are measured: a symbol table with no entries, and a realistic
 * large C symbol table (50k functions/variables with C names) which is the
 * case that must not regress.
 */
async function measureNoEvidenceCost(iterations) {
  const empty = { addrs: new BigUint64Array(0), names: [], nameAt: () => null, label: () => null };
  const emptyLatency = await measureLatency(iterations, async () => {
    await buildCxxClassEvidence({ symbols: empty, read: () => null, pointerBytes: 8 });
  });
  const emptyReport = await buildCxxClassEvidence({ symbols: empty, read: () => null, pointerBytes: 8 });

  const COUNT = 50000;
  const addrs = new BigUint64Array(COUNT);
  const names = new Array(COUNT);
  for (let index = 0; index < COUNT; index++) {
    addrs[index] = 0x1000000000n + BigInt(index * 16);
    names[index] = `c_function_${index}`;
  }
  const cOnly = { addrs, names, nameAt: () => null, label: () => null };
  let reads = 0;
  const largeLatency = await measureLatency(Math.max(1, Math.floor(iterations / 4)), async () => {
    const report = await buildCxxClassEvidence({ symbols: cOnly, read: () => { reads++; return null; }, pointerBytes: 8 });
    if (report.classes.length) throw new Error('a C-only symbol table must not produce classes');
  });

  return {
    emptyTable: { latency: emptyLatency, classesFound: emptyReport.classes.length, reads: emptyReport.reads },
    largeCOrdinarySymbols: { symbolCount: COUNT, latency: largeLatency, reads },
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const built = buildCxxFixtures();
  if (!built.available) {
    console.error(`cxx fixtures unavailable: ${built.reason}`);
    process.exitCode = 1;
    return;
  }
  const objdump = objdumpPath();

  const fixtures = {};
  const probes = [];
  for (const name of FIXTURES) {
    const probe = openCxxFixture(name);
    if (!probe.available) continue;
    probe.name = name;
    probe.artifactPath = built.artifacts[name].path;
    probes.push(probe);
    fixtures[name] = {
      bytes: probe.bytes.length,
      before: await measureBefore(probe),
      after: await measureAfter(probe),
      memberTypes: { functions: [] },
    };
  }
  if (objdump) {
    for (const probe of probes) fixtures[probe.name].memberTypes = measureMemberTypes(probe, objdump);
  }

  const performance = await measurePerformance(probes, options.iterations);
  const noEvidence = await measureNoEvidenceCost(options.iterations);

  const report = {
    schema: 'cxx-recovery-measurement/v1',
    generatedAt: new Date().toISOString(),
    toolchain: { objdump: objdump || null, node: process.version },
    fixtures,
    performance,
    noEvidenceCost: noEvidence,
    notes: [
      'BEFORE reflects main capability: findCxxClasses (symbol-only) plus readVtable with a fixed slot cap.',
      'AFTER is buildCxxClassEvidence + resolveVirtualTargetSet + recoverMemberTypeEvidence.',
      'Member types are measured on IR built from llvm-objdump disassembly of the linked fixture.',
      'virtualTargetSets counts one call-site-scoped target set per (class, slot) pair with at least one candidate.',
    ],
  };

  fs.mkdirSync(path.dirname(options.json), { recursive: true });
  fs.writeFileSync(options.json, `${JSON.stringify(report, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);

  for (const [name, data] of Object.entries(fixtures)) {
    console.log(`\n=== ${name} (${data.bytes} bytes)`);
    console.log(`  BEFORE classes=${data.before.classesWithName} vtables=${data.before.vtablesRead} slots=${data.before.slotsEnumerated} nonMethodSlots=${data.before.slotsPointingAtTypeinfoOrVtable} typeinfo=0 inheritance=0 targetSets=0`);
    console.log(`  AFTER  rtti=${data.after.rttiPresent} classes=${data.after.classesWithName} typeinfo=${data.after.typeinfoParsed} inheritance=${data.after.inheritanceEdges} slots=${data.after.slots} aliasedSlots=${data.after.slotsWithMergedAliases} targetSets=${data.after.virtualTargetSets} (single=${data.after.singleTargetSets} multi=${data.after.multiTargetSets}) targets=${data.after.totalResolvedTargets}`);
    if (data.memberTypes.functions.length) {
      console.log(`  MEMBER fields=${data.memberTypes.fields} typed=${data.memberTypes.typedFieldCount} widthOnly=${data.memberTypes.widthOnlyFieldCount} unknown=${data.memberTypes.unknownFieldCount}`);
    }
  }
  console.log(`\nPERF baseline=${performance.baselineSymbolOnly.meanMs}ms/call enabled=${performance.cxxRecoveryEnabled.meanMs}ms/call ratio=${performance.meanRatio}x`);
  console.log(`PERF no-cxx-evidence empty-table=${noEvidence.emptyTable.latency.meanMs}ms/call classes=${noEvidence.emptyTable.classesFound} reads=${noEvidence.emptyTable.reads}`);
  console.log(`PERF no-cxx-evidence ${noEvidence.largeCOrdinarySymbols.symbolCount}-c-symbols=${noEvidence.largeCOrdinarySymbols.latency.meanMs}ms/call memoryReads=${noEvidence.largeCOrdinarySymbols.reads}`);
  console.log(`\nwrote ${path.relative(ROOT, options.json)}`);
}

await main();
