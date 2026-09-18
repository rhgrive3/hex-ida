#!/usr/bin/env node
/**
 * function-discovery investigation / Phase 3 root-cause cluster evidence.
 *
 * Derives counts / affected cases / representative addresses from
 * classification.json, merges them with the hand-traced pipeline divergence
 * findings, validates, then atomically publishes root-cause-clusters.json.
 *
 * Read-only with respect to production code.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPORT_DIR = '/mnt/workspace/hex-agent-e/reports/investigations/function-discovery';
const classification = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'classification.json'), 'utf8'));

const byCluster = new Map();
for (const row of classification.rows) {
  if (!byCluster.has(row.cluster)) byCluster.set(row.cluster, []);
  byCluster.get(row.cluster).push(row);
}

const trace = {
  ida_synthetic_plt_resolver_stub: {
    label: 'IDA models the .plt resolver stub (PLT0) as a function start; Hex has no seed for it',
    firstDivergenceStage: 'S2_loader_base_function_starts',
    expectedEvidence: [
      'a BL/B branch targeting the address',
      'an STT_FUNC symbol at the address',
      'an .eh_frame FDE starting at the address',
      'an export, relocation target, init-array entry, or entrypoint role',
    ],
    observedEvidence: [
      'address equals the .plt section start',
      'symbol table at the address contains only the .plt SECTION symbol and the AAELF64 mapping symbol $x',
      'no STT_FUNC symbol, no FDE, no BL/B target, no relocation target, not the entrypoint',
      'the PLT0 stub body is a linker trampoline (stp x16,x30 / adrp / ldr x17 / add / br x17) and IDA names it sub_XXXX',
    ],
    lastStageWhereAddressExists: 'S1_elf_metadata (as section start + mapping symbol only)',
    firstStageWhereMissing: 'S2_loader_base_function_starts (nothing seeds it); S3 additionally scans the .plt region and yields 0 starts',
    stageTrace: {
      S1_elf_metadata: 'present (section start, $x mapping symbol, file-backed code bytes)',
      S2_loader_base_function_starts: 'absent (control: the neighbouring .init start 0x860 IS present, seeded by the real STT_FUNC symbol _init)',
      S3_discovery: 'absent (region p0_s24 = .plt @0x880+0xa0 scanned, discovered 0, reported complete:true)',
      S4_symbol_index: 'absent',
      S5_benchmark_function_list: 'absent (hexPresent:false)',
    },
    relevantSource: [
      { file: 'js/binary/elf-core-original.js', symbol: 'ELF symbol table walk', line: 842, note: 'the only ELF function-seed push, gated on STT_FUNC / STT_GNU_IFUNC; STT_NOTYPE mapping symbols and SECTION symbols never seed' },
      { file: 'js/binary/elf-aarch64-mapping.js', symbol: 'applyAarch64MappingSymbols', note: 'consumes $x/$d mapping symbols only to publish metadata and to filter existing seeds; never adds a start' },
      { file: 'js/analysis/discovery/producers.js', symbol: 'symbolTableProducer / referenceProducer', note: 'skip non-function symbol kinds; referenceProducer needs image.relocationTargets / vtableEntries / exceptionMetadata' },
      { file: 'js/worker-legacy.js', symbol: 'guessFunctions', line: 1029, note: 'starts come from bl targets, post-RET/B/Br/trap windows, prologue-after-end, metadata tables; none can fire on a region first instruction, and .plt has no ret/b/bl' },
      { file: 'js/backend.js', symbol: 'guessFunctions', line: 884, note: 'ELF/arm64 routes to the classic worker, not the generic discovery artifact' },
    ],
    searchEvidence: [
      { query: "grep -rn '\\bplt\\b' js/ --include=*.js", result: '0 matches: Hex has no PLT model, no PLT thunk naming, no PLT0 seeding, and no PLT-specific exclusion' },
    ],
    intentional: 'No explicit rejection of .plt exists anywhere; this is unmodelled rather than intentionally excluded. Declining to call a linker trampoline a function is a defensible product choice.',
    hexWrong: 'No. The real defect is second-order and confirmed: functionStartsComplete / functionDiscovery.complete remain true with reasons:[] while an executable region yields zero starts, so the omission is silent.',
    potentialGeneralizedFixSurface: [
      'generic producer for an executable region first instruction when it decodes to a real instruction and is not covered by any symbol extent (also covers bare handwritten / --section-start code regions)',
      'make functionStartsComplete / functionDiscovery.reasons reflect an executable region that produced neither a seed nor a discovered start',
    ],
    blastRadius: 'All ELF/AArch64 binaries that link a .plt (essentially every dynamically linked ELF); start-set completeness only, no effect on analysis of real functions.',
    regressionFixtureSuggestion: 'a synthetic ELF/AArch64 PIE with a .plt section produced by the standard linker, asserting either a start at the .plt section start or functionDiscovery.reasons marking the region; plus a region-level unit test that an executable region with zero starts cannot report complete:true',
  },
  ida_noreturn_split_of_enclosing_function: {
    label: 'IDA ends the caller at a call to an interprocedurally-noreturn function and starts a new function at the continuation; Hex keeps the enclosing function whole',
    firstDivergenceStage: 'S3_discovery',
    expectedEvidence: [
      'a symbol table function boundary at the address',
      'a jump-table or relocation reference to the address',
      'a BL/B branch targeting the address',
      'an FDE starting at the address',
    ],
    observedEvidence: [
      'address is strictly interior to an STT_FUNC span',
      'no symbol, no FDE, no BL/B target, no relocation target',
      'the immediately preceding instruction is a bl to a function that the IDA reference annotates __noreturn',
      'IDA s own reference emits positive sp value has been detected for all 10 rows and renders the new function as consuming the previous call return value',
    ],
    lastStageWhereAddressExists: 'S1_elf_metadata (as an interior byte offset of the enclosing symbol)',
    firstStageWhereMissing: 'S3_discovery',
    stageTrace: {
      S1_elf_metadata: 'present only as interior bytes of the enclosing STT_FUNC span',
      S2_loader_base_function_starts: 'absent as a separate start (the enclosing symbol start is present instead)',
      S3_discovery: 'absent; the pipeline contains a post-noreturn producer but both of its gates close',
      S4_symbol_index: 'absent (nearest preceding start is the enclosing function)',
      S5_benchmark_function_list: 'absent (hexPresent:false)',
    },
    gateAnalysis: [
      'gate 1: js/worker-legacy.js line 1225 sets prevWasNoreturnCall only when slice.noreturnTargets contains the call target, and noreturnTargets (line 653-657) is built solely from the fixed NORETURN_NAME regex over known noreturn import names (stack_chk_fail/objc_exception_throw/abort/assert_rtn/cxa_throw/terminate/swift_*fatal|trap/fatalError). An internal C++ function that is noreturn only by interprocedural inference does not match.',
      'gate 2: js/worker-legacy.js line 1199-1201 also requires Words.looksLikePrologue(w) at the continuation (js/words.js:604 accepts only stp ->sp, sub sp, stp/bti/paciasp/pacibsp). A continuation such as mov w1, w0 or ldr w0,[sp,#8] is rejected even if gate 1 were open.',
    ],
    relevantSource: [
      { file: 'js/worker-legacy.js', symbol: 'guessFunctions', line: 1199, note: 'postNoreturn candidate requires prevWasNoreturnCall && looksLikePrologue(w)' },
      { file: 'js/worker-legacy.js', symbol: 'guessFunctions', line: 1225, note: 'prevWasNoreturnCall = callTarget != null && noreturnTargets.has(callTarget)' },
      { file: 'js/worker-legacy.js', symbol: 'NORETURN_NAME / slice.noreturnTargets', line: 653, note: 'noreturn knowledge is a fixed known-name allowlist, not inference' },
      { file: 'js/words.js', symbol: 'looksLikePrologue', line: 604, note: 'prologue recognition accepts only 4 instruction shapes' },
      { file: 'js/analysis/summary/interprocedural.js', symbol: 'interprocedural summary join', note: 'an interprocedural noreturn lattice already exists in the semantic layer but is not consumed by discovery' },
      { file: 'js/analysis/semantic-function-base.js', symbol: 'prototypeNoreturnState', line: 275, note: 'the semantic layer already resolves callee noreturn state' },
    ],
    intentional: 'Yes, deliberate conservatism: the rule is explicitly restricted to known noreturn names and to prologue-shaped continuations as a precision guard. It is not a targeted exclusion.',
    hexWrong: 'No. The ELF symbol table declares one function spanning the address; IDA split it and its own output flags the split as possibly wrong. Hex s reading is the more faithful one, so this cluster should not be fixed for correctness.',
    potentialGeneralizedFixSurface: [
      'let discovery consume the existing interprocedural noreturn summary as corroborating post-call boundary evidence instead of the fixed name allowlist, behind a region-precision guard',
      'this is generic (any ELF/Mach-O binary with a noreturn leaf) and must not special-case any benchmark address or name',
    ],
    blastRadius: 'Any binary with an internal noreturn leaf called from the middle of a caller; affects only where function starts are drawn, and matching IDA here would move Hex away from the ELF symbol table.',
    regressionFixtureSuggestion: 'a small C/C++ fixture with a noreturn leaf called mid-function, asserting Hex either keeps the enclosing symbol span intact (current, preferred) or reports the extra split explicitly as reference-convention divergence; a golden test encoding the chosen convention so it cannot drift silently',
  },
  ida_address_taken_table_target_split: {
    label: 'IDA starts a function at an address-taken switch case body behind an indirect branch; Hex accepts the sibling case bodies after ret but not the one after br',
    firstDivergenceStage: 'S3_discovery',
    expectedEvidence: [
      'a jump table or relocation-table entry referencing the address',
      'a direct BL/B branch targeting the address',
      'a symbol table function boundary at the address',
    ],
    observedEvidence: [
      'address is an R_AARCH64_RELATIVE addend in .data.rel.ro, reached by ldr x8,[x8,w1,sxtw #3] / br x8',
      'address is strictly interior to the STT_FUNC span of the enclosing switch function',
      'no symbol, no FDE, no direct BL/B reference, not the entrypoint',
      'the three sibling case bodies that follow a ret ARE discovered by Hex at the same stage',
    ],
    lastStageWhereAddressExists: 'S1_elf_metadata (as a relocation addend)',
    firstStageWhereMissing: 'S3_discovery',
    stageTrace: {
      S1_elf_metadata: 'present (R_AARCH64_RELATIVE addend in .data.rel.ro; no symbol, no FDE, no direct branch)',
      S2_loader_base_function_starts: 'absent as a separate start',
      S3_discovery: 'absent; the candidate opens a postIndirectBranch window but fails every acceptance branch, while the sibling postRet windows are accepted',
      S4_symbol_index: 'absent (enclosing start is the switch function)',
      S5_benchmark_function_list: 'absent (hexPresent:false; the sibling case bodies are hexPresent:true)',
    },
    gateAnalysis: [
      'postIndirectBranch acceptance (js/worker-legacy.js) narrows to directTargetSafeMemArgs (LOAD prefix), virtualDispatchPrefix (LOAD/ldp prefix), globalDispatchPrefix (ADRP prefix), or the candidate itself being an unconditional b with a plausible next kind. A mov imm; ret leaf fails all of them.',
      'postRet acceptance accepts the same leaf shape via POST_RET_START_PAIRS (MOVIMM:RET) and the explicit MOVIMM+RET strong rule, which is why the three ret-preceded siblings are found. The asymmetry is exactly post-RET vs post-indirect-BR.',
      'the generic discovery layer does have a relocation-target producer (js/analysis/discovery/producers.js referenceProducer, normalized at js/analysis/discovery/artifact.js:795) but it is not on the ELF/arm64 guessFunctions route, and no ELF loader publishes image.relocationTargets (grep -rn relocationTargets js/binary/*.js -> 0 hits).',
    ],
    relevantSource: [
      { file: 'js/worker-legacy.js', symbol: 'guessFunctions postIndirectBranch loop', note: 'deliberately narrowed: Do not accept every indirect-branch fallthrough, switch tables also use br' },
      { file: 'js/worker-legacy.js', symbol: 'POST_RET_START_PAIRS / postRet loop', note: 'accepts MOVIMM:RET tiny leaves, which is why the ret-preceded siblings are found' },
      { file: 'js/analysis/discovery/producers.js', symbol: 'referenceProducer', line: 302, note: 'a relocation-target producer exists but is not on this route' },
      { file: 'js/analysis/discovery/artifact.js', symbol: 'relocationTargets normalization', line: 795, note: 'requires image.relocationTargets, which no ELF loader populates' },
    ],
    counterEvidence: 'In 1/1_clang_O2/O3/Os the same construct runs the other way: Hex reports 20-23 more starts than IDA, all exactly the R_AARCH64_RELATIVE addends of the same .data.rel.ro tables and all real FUNC LOCAL symbols in those binaries. So Hex already resolves this construct when the symbol layer wins, and the disagreement is about which evidence layer wins.',
    intentional: 'Yes, deliberately narrowed, with an explicit comment justifying the precision guard.',
    hexWrong: 'Not clearly. Keeping the case body inside the enclosing symbol span matches the ELF symbol table (the enclosing FUNC st_size covers it), so Hex is defensible and IDA is defensible.',
    potentialGeneralizedFixSurface: [
      'add a generic address-taken fallback for post-indirect-branch case bodies keyed on a relocation-table entry (never on a benchmark address or name)',
      'alternatively publish ELF relocationTargets in the loader so the existing generic referenceProducer can corroborate, which also removes the current dead-end where the ELF route cannot see relocation evidence',
    ],
    blastRadius: 'C/C++ switch tables compiled to pointer tables behind indirect branches; affects only start granularity inside an already-recognised function.',
    regressionFixtureSuggestion: 'a C switch fixture compiled so the compiler emits a jump table of code pointers behind br, asserting the chosen convention for both the first and the ret-preceded case bodies',
  },
};

const clusters = {};
for (const [key, rows] of byCluster) {
  const t = trace[key];
  if (!t) throw new Error(`no trace entry for cluster ${key}`);
  const addresses = [...new Set(rows.map((r) => r.address))].sort();
  const cases = [...new Set(rows.map((r) => r.caseId))].sort();
  const confidences = [...new Set(rows.map((r) => r.confidence))];
  clusters[key] = {
    cluster: key,
    label: t.label,
    count: rows.length,
    affectedCaseCount: cases.length,
    affectedCases: cases,
    distinctAddressCount: addresses.length,
    representativeAddresses: addresses.slice(0, 20),
    representativeRows: rows.slice(0, 5).map((r) => ({ caseId: r.caseId, address: r.address, idaName: r.idaName, section: r.evidence.section })),
    confidence: confidences.length === 1 ? confidences[0] : confidences,
    firstDivergenceStage: t.firstDivergenceStage,
    expectedEvidence: t.expectedEvidence,
    observedEvidence: t.observedEvidence,
    lastStageWhereAddressExists: t.lastStageWhereAddressExists,
    firstStageWhereMissing: t.firstStageWhereMissing,
    stageTrace: t.stageTrace,
    gateAnalysis: t.gateAnalysis ?? null,
    searchEvidence: t.searchEvidence ?? null,
    counterEvidence: t.counterEvidence ?? null,
    relevantSource: t.relevantSource,
    intentional: t.intentional,
    hexWrong: t.hexWrong,
    potentialGeneralizedFixSurface: t.potentialGeneralizedFixSurface,
    blastRadius: t.blastRadius,
    regressionFixtureSuggestion: t.regressionFixtureSuggestion,
  };
}

const doc = {
  schema: 'hex-function-discovery-investigation/root-cause-clusters/v1',
  generatedAt: new Date().toISOString(),
  baseSha: classification.baseSha,
  checkoutSha: classification.checkoutSha,
  stageModel: [
    'S1_elf_metadata',
    'S2_loader_base_function_starts',
    'S3_discovery',
    'S4_symbol_index',
    'S5_benchmark_function_list',
  ],
  routing: {
    finding: 'Backend.guessFunctions (js/backend.js:884) diverts to the platform worker only for non-legacy Mach-O architectures. ELF/arm64 uses the classic shipped worker (js/worker-legacy.js:1029) plus the worker-fixes.js and worker-data-in-code-fix.js overlays. The generic Phase-7 discovery producer/artifact pipeline (js/analysis/discovery/producers.js, artifact.js) is constructed inside js/analysis/index.js and consumed by js/rebuild/transaction-v2.js, and is NOT on the BinaryImage.functions -> SymbolIndex.funcs path used by the benchmark subject.',
    evidence: [
      'js/backend.js:884',
      'js/worker-legacy.js:1029',
      'js/analysis/index.js:290',
      'js/rebuild/transaction-v2.js:715',
      'js/analysis/query/app-adapter.js:592',
      'js/symbols.js:99',
    ],
  },
  focusedReproductions: [
    { caseId: '1/1_clang_O1_g', baseFunctionStarts: 73, finalSymbolIndexFunctions: 76, discoveryComplete: true, discoveryReasons: [], perRegionDiscovered: [0, 0, 29, 0], execRegionOrder: ['.init', '.plt', '.text', '.fini'] },
    { caseId: '5-1/5-1_clang_O0_g', baseFunctionStarts: 215, finalSymbolIndexFunctions: 215, discoveryComplete: true, discoveryReasons: [], perRegionDiscovered: [0, 0, 208, 0] },
    { caseId: '4/4_clang_O1_g', baseFunctionStarts: 78, finalSymbolIndexFunctions: 78, discoveryComplete: true, discoveryReasons: [], perRegionDiscovered: [0, 0, 46, 0] },
  ],
  totals: {
    classifiedRows: classification.rows.length,
    clusters: Object.keys(clusters).length,
    unknownRows: classification.rows.filter((r) => r.cluster === 'unknown').length,
    rowsWithRealElfFunctionSymbol: 0,
    rowsThatAreDirectBranchTargets: 0,
    rowsWithFdeAtAddress: 0,
    rowsThatAreEntrypoint: 0,
  },
  clusters,
};

const tmp = path.join(REPORT_DIR, `.root-cause-clusters.json.tmp-${process.pid}`);
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
const recheck = JSON.parse(fs.readFileSync(tmp, 'utf8'));
if (recheck.clusters.length === 0) throw new Error('empty clusters');
const summed = Object.values(recheck.clusters).reduce((n, c) => n + c.count, 0);
if (summed !== recheck.totals.classifiedRows) {
  throw new Error(`cluster row sum ${summed} != classified rows ${recheck.totals.classifiedRows}`);
}
fs.renameSync(tmp, path.join(REPORT_DIR, 'root-cause-clusters.json'));
console.log(JSON.stringify({
  clusters: Object.fromEntries(Object.entries(clusters).map(([k, c]) => [k, { count: c.count, cases: c.affectedCaseCount, addrs: c.distinctAddressCount, firstDivergenceStage: c.firstDivergenceStage }])),
  totals: doc.totals,
}, null, 2));
