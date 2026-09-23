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
import { parseOperands } from '../../../../js/arm64.js';
import { analyzeSemanticFunction } from '../../../../js/analysis/semantic-function.js';
import { createCxxEvidenceProvider } from '../../../../js/analysis/cxx/project.js';
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

// Real member functions (not free `Class*` accessors): the projection seam only
// claims a member when `this` itself is proven, so these are the functions whose
// member evidence can reach a consumer.
const PIPELINE_MEMBER_FUNCTIONS = Object.freeze([
  '_ZN6Player10takeDamageEi',
  '_ZN6Entity10takeDamageEi',
  '_ZN5Actor10takeDamageEi',
  '_ZN9Component4tickEv',
  '_ZN6Entity6updateEf',
  '_ZN5Actor6updateEf',
  '_ZN6PlayerC1Ev',
  '_ZN6EntityD1Ev',
]);

function parseArgs(argv) {
  const options = { json: path.join(ROOT, 'reports/phase7/cxx-recovery/measurement.json'), iterations: 300 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') {
      const value = argv[++i];
      // A flag is not a path: `--json --iterations 5` would otherwise write to a
      // file named `--iterations` and silently drop the iteration count.
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw new TypeError('--json requires a path');
      }
      options.json = value;
    } else if (argv[i] === '--iterations') {
      const value = Number(argv[++i]);
      // A missing, zero, negative or fractional count would produce no timed
      // samples and serialize NaN metrics as null.
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError('--iterations must be a positive safe integer');
      }
      options.iterations = value;
    }
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
    classSlotTargetSets: 0,
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

  // Enumerated **class-slot** target sets: one per `(class, slot)` pair, which
  // is what a call site on that static class would consume. This loop reads the
  // vtable evidence, not a call site, so the metric is deliberately not named
  // "call-site" anything: the resolver scopes a set to a call site only when a
  // caller supplies `dynamicClassProven` plus an allow-listed closure authority,
  // and no such authority exists for an enumerated slot. These are the possible
  // targets for the pair; the call-site-scoped claim is the resolver's, and it
  // stays `closureProven: false` throughout this measurement.
  let classSlotTargetSets = 0;
  let multiCandidateTargetSets = 0;
  let singleCandidateTargetSets = 0;
  let totalTargets = 0;
  for (const record of classes) {
    for (let slotIndex = 0; slotIndex < record.slots.length; slotIndex++) {
      const set = resolveVirtualTargetSet({ classEvidence: report, receiverClass: record.className, slotIndex });
      if (!set.candidates.length) continue;
      classSlotTargetSets++;
      totalTargets += set.candidateAddresses.length;
      if (set.candidateAddresses.length > 1) multiCandidateTargetSets++;
      else singleCandidateTargetSets++;
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
    classSlotTargetSets,
    singleCandidateTargetSets,
    multiCandidateTargetSets,
    totalResolvedTargets: totalTargets,
    readBudget: report.reads,
  };
}

// ── member type evidence on real compiled functions ────────────────────────

function objdumpPath() {
  // LLVM objdump only. GNU objdump rejects an AArch64 fixture outright
  // (`can't disassemble for architecture UNKNOWN`) unless the host binutils was
  // built with that target, so accepting it would mean silently measuring
  // nothing. The version banner is what distinguishes them.
  //
  // The selector is `--disassemble-symbols=`. Verified against LLVM 14.0.0 and
  // LLVM 18.1.3: both reject `--disassemble=<symbol>` with
  // `error: unknown argument`, so the alias is not a usable substitute here.
  //
  // The versioned binary is preferred because LLVM 14 silently emits no rows for
  // a symbol that shares its address with another symbol (the C1/C2 and D1/D2
  // constructor/destructor aliases), which would drop every constructor and
  // destructor from the measurement without any error.
  const candidates = [process.env.LLVM_OBJDUMP, 'llvm-objdump-18', 'llvm-objdump'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const banner = (probe.stdout || '').split('\n')[0].trim();
    if (!/LLVM/i.test(banner)) continue;
    return { path: candidate, version: banner };
  }
  return null;
}

function parseDisassemblyRows(stdout) {
  const rows = [];
  for (const line of (stdout || '').split('\n')) {
    const match = /^\s*([0-9a-f]+):\s+([a-z][\w.]*)\s*(.*)$/.exec(line);
    if (!match) continue;
    const address = BigInt(`0x${match[1]}`);
    const mnemonic = match[2];
    const operands = match[3].replace(/\s*\/\/.*$/, '').trim();
    rows.push({ row: rows.length, address, mn: mnemonic, ops: operands });
  }
  return rows;
}

function runDisassembly(objdumpPath, args, elfPath) {
  const result = spawnSync(objdumpPath, [...args, '--no-show-raw-insn', elfPath], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return parseDisassemblyRows(result.stdout);
}

/**
 * Disassembles one function by name, falling back to its symbol-table address
 * range when the name selector yields nothing.
 *
 * The fallback is not decoration: a constructor/destructor alias cannot be
 * measured by name on LLVM 14 at all, and "no rows" is indistinguishable from a
 * function this fixture does not contain. Falling back to the declared address
 * range makes the measurement toolchain-independent instead of leaving the
 * `receiverProven` constructor path unmeasured, and it never invents a range —
 * an unknown or zero-sized symbol still yields null.
 */
function disassembleFunction(elfPath, symbol, objdumpPath, symbolInfo = null) {
  const byName = runDisassembly(objdumpPath, ['--disassemble-symbols=' + symbol], elfPath);
  if (byName.length) return byName;

  const address = symbolInfo?.address ?? null;
  const size = symbolInfo?.size ?? null;
  if (address == null || !Number.isSafeInteger(size) || size <= 0) return null;

  const start = `0x${address.toString(16)}`;
  const stop = `0x${(address + BigInt(size)).toString(16)}`;
  const byRange = runDisassembly(objdumpPath, ['--start-address=' + start, '--stop-address=' + stop], elfPath);
  return byRange.length ? byRange : null;
}

/** Address and declared size of a named symbol, or null when it is absent. */
function symbolInfoOf(probe, name) {
  const { addrs = [], names = [] } = probe.symbols ?? {};
  for (let index = 0; index < names.length; index++) {
    if (names[index] !== name) continue;
    const address = addrs[index];
    if (address == null) continue;
    const size = probe.symbolSizeOf ? probe.symbolSizeOf(address) : null;
    return { address, size: typeof size === 'number' ? size : (size == null ? null : Number(size)) };
  }
  return null;
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
    const rows = disassembleFunction(probe.artifactPath, symbol, objdump.path, symbolInfoOf(probe, symbol));
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

/**
 * Measures member evidence as the *product* sees it: the canonical analysis
 * entrypoint, driven with a provider built from the same fixture. This is the
 * number that matters after the projection seam was added, because it is the
 * only path on which member evidence reaches a consumer.
 */
async function measurePipelineMembers(probe, objdump) {
  const provider = createCxxEvidenceProvider({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    architecture: 'arm64',
    snapshotId: `fixture:${probe.name}`,
  });
  // The class index must exist before the synchronous per-function projection can
  // return anything; without this every function would report no proof, which is
  // exactly how a silently-empty measurement looks.
  await provider.build();
  const perFunction = [];
  let fields = 0;
  let typed = 0;
  let widthOnly = 0;
  let unknown = 0;

  for (const symbol of PIPELINE_MEMBER_FUNCTIONS) {
    const rows = disassembleFunction(probe.artifactPath, symbol, objdump.path, symbolInfoOf(probe, symbol));
    if (!rows) { perFunction.push({ symbol, status: 'disassembly-unavailable' }); continue; }

    const input = {
      architecture: 'arm64', platform: 'linux', abiId: 'aapcs64', mode: 'a64',
      decoderSemanticVersion: 'cxx-recovery-measurement', binaryId: 'cxx-measurement',
      sliceId: 'cxx-measurement-slice', name: symbol,
      instructions: rows.map((row, index) => ({
        address: row.address, size: 4, length: 4, mode: 'a64', mnemonic: row.mn,
        opStr: row.ops, ops: parseOperands(row.ops), instructionId: `measure-${index}`,
        origin: { instructionIds: [`measure-${index}`] },
      })),
    };

    let projection = null;
    let status = 'ok';
    try {
      analyzeSemanticFunction({ ...input, cxxEvidenceProvider: provider });
      // `lastAttempt()` is bound to the request it answered, so the evidence is
      // read only when the recorded address is this function's own start. A bare
      // "last projection" slot plus an attempt counter would report the previous
      // function's members here — exactly what a `ret`-only destructor exposed.
      const attempt = provider.lastAttempt();
      const requested = rows[0]?.address ?? null;
      if (attempt && requested != null && attempt.functionAddress === requested) {
        projection = attempt.projection;
      } else {
        status = 'attempt-not-bound-to-this-function';
      }
    } catch (error) {
      status = `analysis-failed:${error?.message || error}`;
    }
    if (status === 'ok' && !projection) status = 'no-receiver-proof';

    const members = projection?.members ?? [];
    fields += members.length;
    for (const member of members) {
      if (member.typeProven) typed++; else if (member.widthOnly) widthOnly++; else unknown++;
    }
    perFunction.push({
      symbol,
      status,
      receiverProven: Boolean(projection),
      fields: members.length,
      details: members.map((member) => ({
        offset: `0x${member.offsetBytes.toString(16)}`,
        size: member.sizeBytes,
        type: member.typeLabel,
        category: member.category,
        typeProven: member.typeProven,
        rule: member.rule,
        reason: member.reason,
      })),
    });
  }

  return { fields, typedFieldCount: typed, widthOnlyFieldCount: widthOnly, unknownFieldCount: unknown, functions: perFunction };
}

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
  console.log(objdump ? `objdump: ${objdump.version} (${objdump.path})` : 'objdump: unavailable, member measurement skipped');

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
      pipelineMemberTypes: { functions: [] },
    };
  }
  if (objdump) {
    for (const probe of probes) {
      fixtures[probe.name].memberTypes = measureMemberTypes(probe, objdump);
      fixtures[probe.name].pipelineMemberTypes = await measurePipelineMembers(probe, objdump);
    }
  }

  const performance = await measurePerformance(probes, options.iterations);
  const noEvidence = await measureNoEvidenceCost(options.iterations);

  const report = {
    schema: 'cxx-recovery-measurement/v1',
    generatedAt: new Date().toISOString(),
    toolchain: { objdump: objdump?.path || null, objdumpVersion: objdump?.version || null, node: process.version },
    fixtures,
    performance,
    noEvidenceCost: noEvidence,
    notes: [
      'BEFORE reflects main capability: findCxxClasses (symbol-only) plus readVtable with a fixed slot cap.',
      'AFTER is buildCxxClassEvidence + resolveVirtualTargetSet + recoverMemberTypeEvidence.',
      'Member types are measured on IR built from llvm-objdump disassembly of the linked fixture.',
      'pipelineMemberTypes measures the same evidence through the canonical analysis entrypoint with a provider built from the fixture, i.e. the path a consumer actually reads. It only counts functions whose receiver is proven, so a free `Class*` accessor contributes nothing.',
      'classSlotTargetSets counts one enumerated (class, slot) pair with at least one candidate; it is not observed call-site evidence, and every such set is closureProven: false.',
      'Disassembly is fetched by symbol name; a name that yields no rows is retried over the declared symbol-table address range, so constructor/destructor aliases are measured instead of silently reported as unavailable.',
      'toolchain.objdumpVersion is recorded because LLVM 14 cannot disassemble an aliased symbol by name at all; a run without the address-range fallback and without LLVM 18 under-reports members.',
    ],
  };

  fs.mkdirSync(path.dirname(options.json), { recursive: true });
  fs.writeFileSync(options.json, `${JSON.stringify(report, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);

  for (const [name, data] of Object.entries(fixtures)) {
    console.log(`\n=== ${name} (${data.bytes} bytes)`);
    console.log(`  BEFORE classes=${data.before.classesWithName} vtables=${data.before.vtablesRead} slots=${data.before.slotsEnumerated} nonMethodSlots=${data.before.slotsPointingAtTypeinfoOrVtable} typeinfo=0 inheritance=0 targetSets=0`);
    console.log(`  AFTER  rtti=${data.after.rttiPresent} classes=${data.after.classesWithName} typeinfo=${data.after.typeinfoParsed} inheritance=${data.after.inheritanceEdges} slots=${data.after.slots} aliasedSlots=${data.after.slotsWithMergedAliases} classSlotTargetSets=${data.after.classSlotTargetSets} (singleCandidate=${data.after.singleCandidateTargetSets} multiCandidate=${data.after.multiCandidateTargetSets}) targets=${data.after.totalResolvedTargets}`);
    if (data.memberTypes.functions.length) {
      console.log(`  MEMBER fields=${data.memberTypes.fields} typed=${data.memberTypes.typedFieldCount} widthOnly=${data.memberTypes.widthOnlyFieldCount} unknown=${data.memberTypes.unknownFieldCount}`);
    }
    if (data.pipelineMemberTypes.functions.length) {
      console.log(`  PIPELINE-MEMBER fields=${data.pipelineMemberTypes.fields} typed=${data.pipelineMemberTypes.typedFieldCount} widthOnly=${data.pipelineMemberTypes.widthOnlyFieldCount} unknown=${data.pipelineMemberTypes.unknownFieldCount}`);
    }
  }
  console.log(`\nPERF baseline=${performance.baselineSymbolOnly.meanMs}ms/call enabled=${performance.cxxRecoveryEnabled.meanMs}ms/call ratio=${performance.meanRatio}x`);
  console.log(`PERF no-cxx-evidence empty-table=${noEvidence.emptyTable.latency.meanMs}ms/call classes=${noEvidence.emptyTable.classesFound} reads=${noEvidence.emptyTable.reads}`);
  console.log(`PERF no-cxx-evidence ${noEvidence.largeCOrdinarySymbols.symbolCount}-c-symbols=${noEvidence.largeCOrdinarySymbols.latency.meanMs}ms/call memoryReads=${noEvidence.largeCOrdinarySymbols.reads}`);
  console.log(`\nwrote ${path.relative(ROOT, options.json)}`);
}

await main();
