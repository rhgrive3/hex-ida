#!/usr/bin/env node
/*
 * Report-only helper: attach the post-review `fixCandidateReview` block to
 * `root-cause-clusters.json`.
 *
 * Contract:
 *  - the existing root-cause data (clusters, traces, totals, routing) is copied
 *    through untouched — the 172-row classification is NOT re-derived here;
 *  - the result is parsed and validated before an atomic rename;
 *  - the same input produces the same output apart from `reviewedAt`.
 *
 *   node scripts/apply-fix-candidate-review.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..');
const TARGET = path.join(DIR, 'root-cause-clusters.json');
const CHECK = process.argv.includes('--check');

const review = {
  schema: 'hex-function-discovery-investigation/fix-candidate-review/v1',
  reviewedAt: new Date().toISOString(),
  document: '03-fix-candidate-review.md',
  evidenceArtifact: 'exec-region-and-plt-evidence.json',
  scope: 'fix candidates only; cluster assignments, first-divergence traces and the 172-row classification are unchanged',
  executableRegionEvidence: {
    q1: {
      binaries: 160,
      executableSectionNames: ['.init', '.plt', '.text', '.fini'],
      executableSections: 640,
      executableSectionsWithZeroFuncSymbols: 160,
      note: 'the 160 zero-symbol regions are exactly the .plt of each binary',
    },
    q3: {
      executableBytes: 889944,
      coveredByFuncSymbolExtent: 785656,
      uncoveredBytes: 104288,
      uncoveredBySection: { '.plt': 53056, '.text': 44192, '.init': 3840, '.fini': 3200 },
      executableSectionsWithUncoveredBytes: 640,
      note: 'every executable region carries bytes no STT_FUNC extent covers',
    },
    q2PltModel: {
      identifiedFromDynamicStructuresOnly: '160/160',
      sizeEquals16TimesJumpSlotsPlus1: '160/160',
      slot0IsAaelf64Resolver: '160/160',
      slot0MaterialisesDtPltgotPlus16: '160/160',
      slot0IsNotAnyJumpSlot: '160/160',
      slotKEncodesRelaPltkMinus1InOrder: '2996/2996',
      sectionNamesConsulted: false,
    },
    idaOracle: {
      case: '2/2_gcc_O0_g',
      idaFunctionsInPltRange: 1,
      idaFunctionAtPltStart: 'sub_6D0 @ 0x6D0 -> JUMPOUT(0)',
      idaImportThunksModelledAsFunctions: 0,
      ofImportThunksInBinary: 7,
      note: "IDA's object at the region start is a code-vs-data heuristic artifact with a degenerate body, so parity there is not evidence-driven",
    },
  },
  decisions: [
    {
      original: 'A1',
      replacement: 'A1p',
      status: 'withdrawn-and-replaced',
      originalWording: 'a non-empty executable region that yields 0 starts must not report complete: true',
      reason: [
        'region-0-starts measures symbol provenance, not code: .init/.fini are executable regions whose only start is an STT_FUNC symbol another toolchain need not emit',
        'it fires on legitimate padding: 640/640 executable regions contain uncovered bytes (.text alone 44192 bytes)',
        'it assumes region boundary == function boundary (the .plt resolver slot is 32 bytes of which only 20 are instructions)',
        'it silently redefines complete from a truncation claim (!capped, js/worker-legacy.js:1509) into a coverage claim, changing every consumer (js/app.js:784, js/app.js:146-147)',
      ],
      productionFiles: 0,
      shape: 'keep complete as-is; add discovery.coverage={executableBytes,attributedBytes,unclassified:[{start,end,class}]} with class in {stub-table,function-without-symbol,padding,veneer-pool,data-in-executable-region,slot-padding,unknown}; padding only on positive evidence',
      honestySignal: "coverage.unclassified.filter(c=>c.class==='unknown')",
      where: ['js/worker-legacy.js:1509', 'js/analysis/demand-driven-runtime.js (symbols.functionDiscovery)'],
      gate: 'none (additive)',
      blastRadius: 'additive result fields only; consumers of complete are unaffected',
    },
    {
      original: 'A2',
      replacement: 'A2p',
      status: 'withdrawn-and-replaced',
      originalWording: 'emit a start for the first instruction of an executable region when it decodes and no symbol covers it',
      reason: [
        'region boundary == function boundary is false in general (padding, slot padding, data-in-AX-region, mid-fragment section starts)',
        '+1 function per binary is a count target rather than an evidence claim',
        'IDA models none of the import thunks and its one object is JUMPOUT(0), so parity would reproduce a heuristic artifact',
      ],
      productionFiles: 0,
      shape: 'at most one synthetic stub start per dynamically-identified PLT (the resolver slot base), tagged elf-plt-structure, low confidence, kind stub; no starts for import thunks; address from the dynamic-table anchor, never region.start',
      recognition: 'DT_PLTGOT/DT_JMPREL + R_AARCH64_JUMP_SLOT structure; no sh_name/sh_type/symbol dependency; works on stripped binaries',
      failureMode: 'nothing added when the layout does not match',
      where: ['js/binary/elf-core-original.js (seed layer)', 'js/worker-legacy.js (region discovery)'],
      gate: 'recognition must be dynamic-structure-only; failure mode must be silent-no-op rather than mis-seed',
      blastRadius: 'at most one stub entry per dynamically-linked AArch64 ELF; no effect on .text/.init_array/veneers',
    },
    {
      original: 'B1',
      replacement: 'B1a',
      status: 'removed-from-candidates',
      originalWording: 'let discovery consume the existing interprocedural noreturn summary',
      cycle: {
        verdict: 'real phase cycle, self-referential',
        path: 'discovery -> entity/call-graph model -> interprocedural summary -> discovery',
        orderAnchors: [
          'js/app.js:829 ensureProgram calls ensureFunctions (discovery) before the program scan',
          'js/worker-legacy.js:1029 classic worker discovery for ELF/arm64',
          'js/analysis/index.js:290 discovery artifact built from the entity model',
          'js/analysis/summary/interprocedural.js:49 analyzer id, :1152 noreturn join',
          'js/app.js:784 cached-completeness early return',
        ],
        currentSignalIsNotSemantic: 'js/worker-legacy.js:653-656 fixed-name regex over import entries, built at slice load',
        noCycleFreeInDiscoveryVariant: 'the 10 rows call locally defined noreturn helpers, unreachable from import/dynamic metadata',
      },
      reason: [
        'the summary is computed from the model that is built from the starts discovery produced',
        'consuming it inside discovery closes the cycle and makes the summary depend on the starts it would then move',
      ],
      productionFiles: 0,
      reframedAs: {
        id: 'B1a',
        status: 'design-gated; not recommended for scheduling yet',
        shape: 'additive-only downstream refinement after the interprocedural summary exists',
        mandatoryConstraints: [
          'invalidate symbols.functionStartsComplete / symbols.functionDiscovery or js/app.js:784 serves the cached pre-refinement index',
          'append-only: never move or delete an existing start (extents feed AddressProvenance, ProgramIndex, analysis/query)',
          'idempotent and epoch-guarded like ensureFunctions',
          "splits are re-entityisations: route through js/rebuild/transaction-v2.js rather than mutating the index in place",
        ],
      },
      caveat: "IDA annotates these splits as suspect; matching them is a convention decision, not a correctness one",
    },
    {
      original: 'C1',
      replacement: 'C1',
      status: 'kept-corrobation-only',
      originalWording: 'publish ELF relocationTargets so the generic discovery artifact can corroborate address-taken case bodies',
      reason: [
        'an R_AARCH64_RELATIVE addend is a pointer-typed data word that also denotes jump-table bases, case bodies and .data/.rodata addresses',
        'promoting relocations to start authority would raise the Hex-only direction: in 1/1_clang_O2/O3/Os Hex already reports 20-23 more starts than IDA, all of them R_AARCH64_RELATIVE addends that are also real FUNC LOCAL symbols',
      ],
      productionFiles: 0,
      shape: 'publish relocation targets with provenance tag elf-relocation-target as evidence input only; never a start authority',
      where: ['js/binary/elf-* (loader relocations)'],
      gate: 'symbol/other evidence must keep outranking relocation-derived corroboration',
      blastRadius: 'enables generic corroboration on ELF; no start-set change on its own',
    },
  ],
  confirmedDefectUnchanged: {
    finding: 'the .plt omission is silent: functionStartsComplete = true and functionDiscovery.reasons = [] while an executable region produced 0 starts',
    remedyMovedTo: "A1p coverage reporting (not a redefinition of complete)",
  },
  contractSeparation: {
    startProduction: 'which addresses are functions, from loader metadata, dynamic/relocation structures and code shape',
    completenessHonesty: 'was the producer truncated (budget) and what executable code has no explanation (byte accounting)',
    invariant: 'neither implies the other; complete:true must not be read as "the function list is the whole truth"',
  },
};

const doc = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
const before = JSON.stringify({ ...doc, fixCandidateReview: undefined });
const next = { ...doc, fixCandidateReview: review };
if (review.schema.indexOf('fix-candidate-review') < 0) throw new Error('schema mismatch');
const clusterCount = Array.isArray(next.clusters) ? next.clusters.length : Object.keys(next.clusters || {}).length;
if (clusterCount === 0) throw new Error('clusters missing after merge');
if (Object.keys(doc).length + 1 !== Object.keys(next).length) throw new Error('key set changed unexpectedly');
if (JSON.stringify({ ...next, fixCandidateReview: undefined }) !== before) throw new Error('root-cause data mutated');

if (CHECK) {
  console.log('root-cause-clusters.json retains all root-cause keys; fixCandidateReview present: ' + !!doc.fixCandidateReview);
} else {
  const tmp = path.join(DIR, `.root-cause-clusters.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  const reparsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const reClusterCount = Array.isArray(reparsed.clusters) ? reparsed.clusters.length : Object.keys(reparsed.clusters || {}).length;
  if (!reparsed.fixCandidateReview || reClusterCount !== clusterCount) throw new Error('re-read validation failed');
  fs.renameSync(tmp, TARGET);
  console.log('updated ' + path.relative(process.cwd(), TARGET) + ' (' + Object.keys(reparsed).length + ' top-level keys, ' + reClusterCount + ' clusters)');
}
