import { functionSeedConfidence, isExactFunctionSeed } from './worker-validation.js';
import { elfLoaderEntrySectionAnalysisWindow } from '../binary/elf-mapping.js';

function provenance(source, confidence = 1) {
  return { source: source || 'binary-metadata', confidence, confirmed: true };
}

function statusReasons(value, prefix, out) {
  if (!value || typeof value !== 'object') return;
  if (value.complete === false) out.push(`${prefix}:incomplete`);
  if (value.importsComplete === false) out.push(`${prefix}:imports-incomplete`);
  if (value.symbolsComplete === false) out.push(`${prefix}:symbols-incomplete`);
  if (value.bindingSitesComplete === false) out.push(`${prefix}:binding-sites-incomplete`);
  for (const reason of [value.partialReason, value.importsPartialReason, value.symbolsPartialReason, value.bindingSitesPartialReason]) {
    if (reason) out.push(`${prefix}:${reason}`);
  }
  for (const reason of value.reasons || []) out.push(`${prefix}:${reason}`);
  for (const reason of value.bindingSiteReasons || []) out.push(`${prefix}:${reason}`);
}

function dyldBindingReasons(value, out) {
  if (!value || typeof value !== 'object') return;
  statusReasons(value, 'dyld-bindings', out);
  const streams = value.streams && typeof value.streams === 'object' ? value.streams : value;
  for (const [kind, status] of Object.entries(streams)) {
    if (kind === 'complete' || kind === 'streams') continue;
    statusReasons(status, `dyld-${kind}`, out);
  }
}

function metadataObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const MACHO_ABSENT_COMPONENT = Object.freeze({ complete: true, notPresent: true });
const MACHO_ABSENT_DYLD_BINDINGS = Object.freeze({
  complete: true,
  notPresent: true,
  streams: Object.freeze({}),
});

function dyldBindingCompleteness(value) {
  if (value == null) return { affirmative: false, unknown: false };
  if (!metadataObject(value)) return { affirmative: false, unknown: true };
  const hasStreams = Object.prototype.hasOwnProperty.call(value, 'streams');
  if (hasStreams && !metadataObject(value.streams)) return { affirmative: false, unknown: true };
  const streams = hasStreams ? value.streams : value;
  const entries = Object.entries(streams).filter(([kind]) => kind !== 'complete' && kind !== 'streams');
  const unknownStream = entries.some(([, status]) => !metadataObject(status) || status.complete !== true);
  if (value.complete === false) return { affirmative: false, unknown: true };
  if (value.complete === true) return { affirmative: true, unknown: unknownStream };
  return { affirmative: entries.length > 0 && !unknownStream, unknown: entries.length === 0 || unknownStream };
}

export function machoSymbolTruth(image) {
  if (!image || image.format !== 'macho') return null;
  const metadata = image.metadata || {};
  const reasons = [];
  // Sample authority inputs once: accessor-backed metadata must not change the
  // decision between validation and rendering of the normalized components.
  const metadataBudget = metadata.machoMetadata;
  const loadCommands = metadata.loadCommands;
  const ncmds = metadata.ncmds;
  const rawChainedFixups = metadata.chainedFixups;
  const rawExportTrie = metadata.exportTrie;
  const rawDyldBindings = metadata.dyldBindings;
  // Missing optional dyld components mean "not present" only after the Mach-O
  // loader has positively completed its load-command scan.  A caller-created
  // metadata object with one complete subcomponent must not mint parser-wide
  // completeness merely because the other components are absent (#4935).
  const parserScanComplete = metadataObject(metadataBudget)
    && metadataBudget.complete === true
    && Number.isSafeInteger(loadCommands)
    && loadCommands >= 0
    && Number.isSafeInteger(ncmds)
    && ncmds >= 0
    && loadCommands === ncmds;
  const chainedFixups = rawChainedFixups == null && parserScanComplete ? MACHO_ABSENT_COMPONENT : rawChainedFixups;
  const exportTrie = rawExportTrie == null && parserScanComplete ? MACHO_ABSENT_COMPONENT : rawExportTrie;
  const dyldBindings = rawDyldBindings == null && parserScanComplete ? MACHO_ABSENT_DYLD_BINDINGS : rawDyldBindings;
  const components = [metadataBudget, chainedFixups, exportTrie, dyldBindings];
  const componentStatuses = components.map((value, index) => index === 3
    ? dyldBindingCompleteness(value)
    : value == null
      ? { affirmative: false, unknown: false }
      : { affirmative: metadataObject(value) && value.complete === true, unknown: !metadataObject(value) || value.complete !== true });
  const allComponentsComplete = componentStatuses.every((status) => status.affirmative && !status.unknown);
  statusReasons(metadataBudget, 'metadata-budget', reasons);
  statusReasons(chainedFixups, 'chained-fixups', reasons);
  statusReasons(exportTrie, 'export-trie', reasons);
  dyldBindingReasons(dyldBindings, reasons);
  if (!allComponentsComplete && reasons.length === 0) reasons.push('symbol-metadata-unavailable');
  const unique = [...new Set(reasons)].slice(0, 64);
  return {
    source: 'BinaryImage', normalized: true, complete: allComponentsComplete && unique.length === 0, reasons: unique,
    components: {
      chainedFixups: chainedFixups || null,
      dyldBindings: dyldBindings || null,
      exportTrie: exportTrie || null,
      metadataBudget: metadataBudget || null,
    },
  };
}

function u64Address(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('analysis-address-unsafe-number');
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) throw new TypeError('analysis-address-invalid-string');
    value = text;
  } else if (typeof value !== 'bigint') {
    throw new TypeError('analysis-address-invalid');
  }
  const addr = BigInt(value);
  if (addr < 0n || addr > 0xffffffffffffffffn) throw new RangeError('analysis-address-out-of-range');
  return addr;
}

// Canonical-name ranking for same-address raw evidence.
//
// One raw image can publish several records for a single address: an AAELF64
// `$x`/`$d` mapping marker and the STT_FUNC it describes, a `symtab` entry and
// its `dynsym` twin, an export and the symbol behind it. Whichever record owns
// the canonical display/function name must be decided by published semantic
// evidence — never by the order the provider happened to emit the records in,
// which is what made `[$x, foo]` and `[foo, $x]` disagree.
//
// Every tier below is derived from parser metadata only: record kind (the st_info
// type/class the parser decoded), binding, and the published size. Name text is
// used exclusively as the last deterministic tie-break, so no `$x`-shaped string
// is ever special-cased. The raw records are left untouched: a mapping marker
// keeps its record in `image.symbols`, its code/data authority in
// `metadata.aarch64MappingSymbols`/`metadata.riscvIsa`, and its `$d` intervals in
// `image.dataInCode`. Only this naming projection changes.
//
// Deliberately absent: the parser's own record ordinals (`tableIndex`, `index`).
// They look like tie-break evidence, but they are the physical position of the
// record in the symbol table (`index: i, tableIndex: table.index` in the ELF
// reader) and `BinaryImage.finalize()` sorts symbols by address with a stable
// sort, so two records for one address arrive here in exactly their table order.
// Ranking on them would reintroduce the same defect one layer down: two
// indistinguishable aliases for one address would take their canonical name from
// how the assembler or linker happened to lay the table out. The ordinals remain
// valid — and are still used — as identity keys for relocation lookup
// (`symbolsByTable`, `${tableIndex}:${index}`), which is a different question
// from which name an address should display.
const CALLABLE_SYMBOL_KINDS = new Set(['function', 'indirect-function', 'indirect']);
const DATA_SYMBOL_KINDS = new Set(['object', 'tls', 'common']);
// Binding evidence. STB_GLOBAL, STB_WEAK and STB_GNU_UNIQUE all *define* the
// address and are ranked together on purpose:
//
//   * Weakness is a link-time rule — "a strong definition of the same name
//     overrides this one". By the time an image is being described the link is
//     over, no second definition is coming, and a surviving weak definition is a
//     definition like any other, so its weak bit says nothing about which name
//     is the canonical identity.
//   * Ordering them would let an authoring idiom pick the displayed name:
//     glibc-style `weak_alias (__printf, printf)` puts a strong `__printf` and a
//     weak `printf` at one address, and a strong/weak rank would silently demote
//     the public spelling. That is a layout/authoring artifact deciding user
//     visible names — the very class of defect this ranking removes.
//   * STB_GNU_UNIQUE is a process-wide unique definition, i.e. stronger than
//     global in preemption terms and equal in naming terms; a rule placing it
//     below or above STB_GLOBAL would have no naming basis either way.
//
// The one split that does carry naming meaning is file-scoped vs link-visible,
// and it matches the linkage notion the ELF reader already publishes
// (`externallyVisible = bind === 1 || bind === 2 || bind === STB_GNU_UNIQUE`):
// a local record (or one with no binding evidence, or an OS/processor-specific
// `bind-N`, which the reader also treats as not externally visible) is
// file-scoped, so a non-local definition of the same address owns the identity.
const LINK_VISIBLE_BINDINGS = new Set(['weak', 'global', 'gnu-unique']);

function publishedSymbolSize(record) {
  const size = record?.size;
  if (typeof size === 'bigint') return size;
  if (typeof size === 'number' && Number.isSafeInteger(size)) return BigInt(size);
  if (typeof size === 'string' && /^(?:0|[1-9][0-9]*)$/.test(size.trim())) {
    try { return BigInt(size.trim()); } catch { return 0n; }
  }
  return 0n;
}

/**
 * How much identity the parser actually declared for this record:
 *
 *   3  a callable body      (STT_FUNC / STT_GNU_IFUNC)
 *   2  a typed data object  (STT_OBJECT / STT_TLS / STT_COMMON)
 *   1  any other declared type
 *   0  no declared identity (STT_NOTYPE, or no type metadata at all)
 *
 * Every ELF psABI mapping symbol — the AArch64 `$x`/`$d` family included — is a
 * local, zero-sized STT_NOTYPE record, i.e. tier 0. A callable FUNC/IFUNC, or any
 * typed identity, therefore always outranks it without inspecting the marker's
 * name or reading an architecture-specific mapping table.
 */
function symbolIdentityRank(record) {
  const kind = record?.kind;
  if (CALLABLE_SYMBOL_KINDS.has(kind)) return 3;
  if (DATA_SYMBOL_KINDS.has(kind)) return 2;
  if (typeof kind !== 'string' || kind === 'type-0') return 0;
  return 1;
}

function symbolBindingRank(record) {
  return LINK_VISIBLE_BINDINGS.has(record?.binding) ? 1 : 0;
}

function canonicalNameEvidence(record) {
  return {
    identity: symbolIdentityRank(record),
    sized: publishedSymbolSize(record) > 0n ? 1 : 0,
    binding: symbolBindingRank(record),
    // Primitive strings only: a provider-supplied structured `source` must never
    // see its coercion hooks executed by a naming decision (#4739).
    source: typeof record?.source === 'string' ? record.source : '',
  };
}

/**
 * Total order over same-address candidates: declared identity first, then a
 * published extent, then binding linkage. Only records with equivalent semantic
 * evidence use the source bucket as a tie-break, followed by name and source.
 * This prevents a low-evidence import/export record from displacing a defined
 * callable or typed symbol solely because it was collected from a higher-priority
 * provider, while keeping provider preference for otherwise equivalent aliases.
 *
 * Every discriminator is independent of raw input order, including physical
 * symbol-table ordinals, so provider/list permutations cannot change the winner.
 */
function canonicalNameIsStronger(candidate, incumbent) {
  const a = canonicalNameEvidence(candidate.record);
  const b = canonicalNameEvidence(incumbent.record);
  if (a.identity !== b.identity) return a.identity > b.identity;
  if (a.sized !== b.sized) return a.sized > b.sized;
  if (a.binding !== b.binding) return a.binding > b.binding;
  if (candidate.priority !== incumbent.priority) return candidate.priority > incumbent.priority;
  if (candidate.name !== incumbent.name) return candidate.name < incumbent.name;
  return a.source < b.source;
}

export function analysisFromBinaryImage(image) {
  if (!image) return emptyAnalysis();
  const entries = new Map();
  const add = (address, name, kind, exported, prov, priority, record) => {
    if (address == null || typeof name !== 'string' || !name) return;
    const addr = u64Address(address), key = addr.toString();
    const next = { address: addr, name, kind, exported: !!exported, provenance: prov, priority, record };
    const current = entries.get(key);
    if (!current) { entries.set(key, next); return; }
    current.exported ||= next.exported;
    if (canonicalNameIsStronger(next, current)) {
      current.name = next.name; current.kind = next.kind; current.provenance = next.provenance;
      current.priority = next.priority; current.record = next.record;
    }
  };

  for (const symbol of image.symbols || []) {
    if (symbol?.defined !== true || symbol?.address == null || !symbol.name) continue;
    add(symbol.address, symbol.name, 0, !!symbol.exported, provenance(symbol.source || 'symbol-table', 0.99), 10, symbol);
  }
  for (const exp of image.exports || []) {
    if (exp?.address == null || !exp.name) continue;
    add(exp.address, exp.name, 0, true, provenance(exp.source || 'exports-trie', 1), 20, exp);
  }
  for (const imp of image.imports || []) {
    if (!imp?.name) continue;
    for (const site of imp.sites || []) {
      if (site?.address == null) continue;
      add(site.address, imp.name, 2, false, provenance(site.kind || imp.source || 'dyld-bind', 1), 30, imp);
    }
  }

  const sorted = [...entries.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const addrs = new BigUint64Array(sorted.length), kinds = new Uint8Array(sorted.length), flags = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].address; kinds[i] = sorted[i].kind; flags[i] = sorted[i].exported ? 1 : 0; }

  function snapshotFunctionSeed(rawSeed) {
    if (!rawSeed || typeof rawSeed !== 'object') {
      return Object.freeze({
        isValid: false,
        isExact: false,
        address: null,
        source: 'heuristic',
        effectiveConfidence: 0.5,
        extentInferred: true,
        extentConfidence: null,
        end: null,
        size: null,
      });
    }
    const rawConfidence = rawSeed.confidence;
    const rawExactStartConfidence = rawSeed.exactFunctionStartConfidence;
    const rawExtentConfidence = rawSeed.extentConfidence;
    const rawExactFunctionStart = rawSeed.exactFunctionStart;
    const rawExtentInferred = rawSeed.extentInferred;
    const rawSource = rawSeed.source;
    const rawSources = rawSeed.sources;
    const rawAddress = rawSeed.address;
    const rawEnd = rawSeed.end;
    const rawSize = rawSeed.size;
    const rawLoaderEntryContracts = rawSeed.loaderEntryContracts;

    const source = rawSource != null ? String(rawSource) : '';
    const sources = Array.isArray(rawSources) ? rawSources.map(String) : undefined;
    const exactFunctionStart = rawExactFunctionStart === true;
    const extentInferred = rawExtentInferred === true;
    const seedSources = new Set([source, ...(sources || [])]);
    const loaderEntryContracts = [...new Set((Array.isArray(rawLoaderEntryContracts) ? rawLoaderEntryContracts : [])
      .filter((value) => value === 'DT_INIT' || value === 'DT_FINI'))]
      .filter((value) => value === 'DT_INIT' ? seedSources.has('dt-init') : seedSources.has('dt-fini'))
      .sort();
    let analysisWindow = null;
    // The seed-carried window is only a transport/cache hint. Re-establish its
    // authority from the BinaryImage's canonical ELF section/PT_LOAD metadata
    // at the platform boundary so a forged or stale raw seed cannot widen the
    // decode range. DT_INIT/DT_FINI still gate the fallback; this helper proves
    // the exact section-start, executable/allocated, and file-backed bounds.
    if (image?.format === 'elf' && loaderEntryContracts.length && rawAddress != null) {
      const derived = elfLoaderEntrySectionAnalysisWindow(image, rawAddress);
      if (derived) analysisWindow = { ...derived };
    }

    const confidenceNorm = functionSeedConfidence(rawConfidence);
    const exactConfidenceNorm = rawExactStartConfidence != null ? functionSeedConfidence(rawExactStartConfidence) : null;
    const extentConfidence = functionSeedConfidence(rawExtentConfidence);

    const plainSeed = {
      source,
      sources,
      exactFunctionStart,
      exactFunctionStartConfidence: rawExactStartConfidence != null ? (exactConfidenceNorm ?? -1) : null,
      confidence: confidenceNorm ?? (rawConfidence != null ? -1 : null),
    };
    const isExact = isExactFunctionSeed(plainSeed);
    const effectiveConfidence = rawConfidence == null ? (isExact ? 1 : 0.5) : (confidenceNorm ?? (isExact ? 1 : 0.5));

    return Object.freeze({
      isValid: rawAddress != null,
      isExact,
      address: rawAddress,
      source: source || 'heuristic',
      effectiveConfidence,
      extentInferred,
      extentConfidence,
      end: rawEnd,
      size: rawSize,
      loaderEntryContracts,
      analysisWindow,
    });
  }

  const seedByAddress = new Map();
  const exactEndByAddress = new Map();
  const conflictingExactEnds = new Set();
  const seedSnapshots = (image.functions || []).map(snapshotFunctionSeed);

  // Duplicate seeds for one address must merge by evidence quality, not by
  // input order: last-write-wins let a trailing heuristic seed demote exact
  // function-start provenance (and vice versa) depending on producer order
  // (#6096). Strength = exact over non-exact, then confidence, then a
  // deterministic source-name tie-break so permutations agree. Keep the
  // normalized confidence identical to the value emitted in provenance.
  const seedIsStronger = (next, current) => {
    if (next.isExact !== current.isExact) return next.isExact;
    if (next.effectiveConfidence !== current.effectiveConfidence) return next.effectiveConfidence > current.effectiveConfidence;
    return String(next.source ?? '') < String(current.source ?? '');
  };
  for (const seed of seedSnapshots) {
    if (!seed.isValid) continue;
    let address;
    try {
      address = u64Address(seed.address);
    } catch {
      continue;
    }
    const key = address.toString();
    const existing = seedByAddress.get(key);
    if (existing == null || seedIsStronger(seed, existing)) seedByAddress.set(key, seed);
    if (!seed.isExact || seed.extentInferred === true || seed.extentConfidence == null || seed.extentConfidence < 0.9) continue;
    let end = null;
    try {
      if (seed.end != null) end = u64Address(seed.end);
      else if (seed.size != null) {
        const size = BigInt(seed.size);
        if (size > 0n && address <= 0xffffffffffffffffn - size) end = address + size;
      }
    } catch { end = null; }
    if (end == null || end <= address) continue;
    const previous = exactEndByAddress.get(key);
    if (previous != null && previous !== end) { conflictingExactEnds.add(key); exactEndByAddress.delete(key); }
    else if (!conflictingExactEnds.has(key)) exactEndByAddress.set(key, end);
  }
  const functions = [...seedByAddress.keys()].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const funcs = new BigUint64Array(functions);
  const funcEnds = new BigUint64Array(functions.length);
  for (let i = 0; i < functions.length; i++) funcEnds[i] = exactEndByAddress.get(functions[i].toString()) ?? 0n;
  const functionProvenance = functions.map((addr) => {
    const seed = seedByAddress.get(addr.toString());
    if (!seed) return { source: 'heuristic', confidence: 0.5, confirmed: false };
    const provenance = { source: seed.source, confidence: seed.effectiveConfidence, confirmed: seed.isExact };
    if (seed.loaderEntryContracts?.length) provenance.loaderEntryContracts = [...seed.loaderEntryContracts];
    if (seed.analysisWindow) provenance.analysisWindow = { ...seed.analysisWindow };
    return provenance;
  });
  const nameProvenance = sorted.map((entry) => entry.provenance);
  // This describes every raw provider seed. A heuristic duplicate must keep
  // the aggregate non-exact even when exact evidence wins deduplication.
  const allSeedsExact = functions.length > 0 && seedSnapshots.every((seed) => seed.isExact);
  const discoveryComplete = image.metadata?.functionDiscovery?.complete === true;
  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name), funcs, funcEnds, functionProvenance, nameProvenance,
    symbolCount: addrs.length, funcCount: funcs.length, capped: false,
    allSeedsExact, discoveryComplete, functionStartsExact: discoveryComplete && allSeedsExact,
    functionDiscovery: { complete: discoveryComplete, capped: false, reasons: discoveryComplete ? [] : ['platform-function-seeds-not-exhaustive'] },
    symbolTruth: machoSymbolTruth(image),
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer, funcEnds.buffer],
  };
}

export function emptyAnalysis() {
  const addrs = new BigUint64Array(0), kinds = new Uint8Array(0), flags = new Uint8Array(0), funcs = new BigUint64Array(0), funcEnds = new BigUint64Array(0);
  return {
    addrs, kinds, flags, names: [], funcs, funcEnds, symbolCount: 0, funcCount: 0, capped: false,
    allSeedsExact: false, discoveryComplete: false, functionStartsExact: false,
    functionDiscovery: { complete:false, capped:false, reasons:['platform-function-seeds-not-exhaustive'] },
    symbolTruth: null,
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer, funcEnds.buffer],
  };
}
