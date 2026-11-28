/**
 * Unified facade for the 8 C++20/WASM static structural analysis engines.
 * Provides direct exports for every engine plus `runWasmStructuralAnalysis`
 * for whole-binary / call-graph structural scans.
 */
import { scanArm64RmwFields } from './wasm-rmw-scanner.js';
import { scanVtables, mergeVtableRuns } from './wasm-vtable-scanner.js';
import {
  fingerprintArm64Func,
  simhashHamming64,
  matchFingerprints,
} from './wasm-func-fingerprint.js';
import { scanArm64JumpTables } from './wasm-jumptable-scanner.js';
import { inferArm64Abi, ABI_RET_KIND } from './wasm-abi-scanner.js';
import { scanConstTables } from './wasm-const-table-scanner.js';
import { analyzeCallGraphMetrics, CALLGRAPH_ROLE } from './wasm-callgraph-metrics.js';
import { classifyArm64Behavior, BEHAVIOR_CATEGORY } from './wasm-behavior-classifier.js';
import { scanX86_64RmwFields, classifyX86_64Behavior } from './wasm-x86-64-rmw-scanner.js';
import {
  scanObjcPtrList,
  scanSwift5Rel32List,
  scanSwift5FieldMd,
  scanObjcSwiftMetadataFromImage,
} from './wasm-objc-swift-scanner.js';
import { linkWasmStructuralHints, normalizeFunctions } from './wasm-xref-linker.js';
import { resolveStrippedCxxRtti } from './cxx/stripped-rtti-resolver.js';
import { resolveVtableRefOwners } from './cxx/vtable-ref-resolver.js';
import { resolveStrippedObjcMethods } from './apple/objc-method-resolver.js';
import { normalizeUnifiedMetadata } from './apple/unified-metadata-normalizer.js';
import { buildVirtualFolderTree } from './virtual-tree.js';
import { buildSemanticNames } from './semantic-namer.js';
import { aggregateClassFields } from './cxx/class-field-aggregator.js';

export {
  scanArm64RmwFields,
  scanVtables,
  mergeVtableRuns,
  fingerprintArm64Func,
  simhashHamming64,
  matchFingerprints,
  scanArm64JumpTables,
  inferArm64Abi,
  ABI_RET_KIND,
  scanConstTables,
  analyzeCallGraphMetrics,
  CALLGRAPH_ROLE,
  classifyArm64Behavior,
  BEHAVIOR_CATEGORY,
  scanX86_64RmwFields,
  classifyX86_64Behavior,
  scanObjcPtrList,
  scanSwift5Rel32List,
  scanSwift5FieldMd,
  scanObjcSwiftMetadataFromImage,
  linkWasmStructuralHints,
  normalizeFunctions,
  resolveStrippedCxxRtti,
  resolveVtableRefOwners,
  resolveStrippedObjcMethods,
  normalizeUnifiedMetadata,
  buildVirtualFolderTree,
  buildSemanticNames,
  aggregateClassFields,
};

function toBigIntOrNull(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { return BigInt(s); } catch { return null; }
  }
  return null;
}

function extractCallGraphFromProgram(program, symbols) {
  if (!program || typeof program.calleesOf !== 'function') return null;
  const limit = 262144;
  const funcAddrs = [];

  if (symbols && symbols.funcs && typeof symbols.funcs.length === 'number') {
    // Production SymbolIndex stores sorted function addresses in BigUint64Array `symbols.funcs`.
    const n = Math.min(symbols.funcs.length, limit);
    for (let i = 0; i < n; i++) {
      const a = toBigIntOrNull(symbols.funcs[i]);
      if (a != null) funcAddrs.push(a);
    }
  } else if (symbols && typeof symbols.functionList === 'function') {
    const list = symbols.functionList(null, limit) || [];
    for (let i = 0; i < list.length && funcAddrs.length < limit; i++) {
      const f = list[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (symbols && typeof symbols.functions === 'function') {
    for (const f of symbols.functions()) {
      if (funcAddrs.length >= limit) break;
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (Array.isArray(symbols?.functions)) {
    for (let i = 0; i < symbols.functions.length && funcAddrs.length < limit; i++) {
      const f = symbols.functions[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (Array.isArray(program.functions)) {
    for (let i = 0; i < program.functions.length && funcAddrs.length < limit; i++) {
      const f = program.functions[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  }
  if (!funcAddrs.length) return null;

  // Deduplicate and sort ascending so adjacent function starts bound unknown ends accurately.
  const uniqueSet = new Set(funcAddrs);
  const nodes = Array.from(uniqueSet);
  nodes.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
  const addrToIdx = new Map();
  for (let i = 0; i < nodes.length; i++) addrToIdx.set(nodes[i], i);

  const srcList = [];
  const dstList = [];
  for (let u = 0; u < nodes.length; u++) {
    const range = typeof program.functionRange === 'function' ? program.functionRange(nodes[u]) : null;
    let end = toBigIntOrNull(range?.end);
    const regStart = toBigIntOrNull(range?.region?.vmAddr);
    const regSize = toBigIntOrNull(range?.region?.size);
    const regEnd = regStart != null && regSize != null && regSize > 0n ? regStart + regSize : null;
    if (end == null || end <= nodes[u]) {
      const nextStart = u + 1 < nodes.length ? nodes[u + 1] : null;
      if (nextStart != null && (regEnd == null || nextStart <= regEnd)) {
        end = nextStart;
      } else if (regEnd != null && regEnd > nodes[u]) {
        end = regEnd;
      }
    }
    // ProgramIndex.calleesOf(start, end) scans to EOF if end == null; skip when end is unknown.
    if (end == null || end <= nodes[u]) continue;
    const callees = program.calleesOf(nodes[u], end);
    if (!callees || !callees.length) continue;
    for (let j = 0; j < callees.length; j++) {
      const raw = callees[j];
      const ca = toBigIntOrNull(typeof raw === 'bigint' || typeof raw === 'number' ? raw : (raw?.addr ?? raw?.target ?? raw?.to));
      if (ca == null) continue;
      const v = addrToIdx.get(ca);
      if (v !== undefined) {
        srcList.push(u);
        dstList.push(v);
      }
    }
  }
  return {
    numNodes: nodes.length,
    nodes,
    edgeSrc: Uint32Array.from(srcList),
    edgeDst: Uint32Array.from(dstList),
  };
}

/**
 * Run whole-binary / call-graph WASM structural analysis on whatever inputs are
 * available (`codeBytes`, `dataBytes`, `textConstBytes`, `dataSections`,
 * `program`/`symbols`, or explicit `callgraph`).
 *
 * @param {object} [opts]
 * @returns {object}
 */
export function runWasmStructuralAnalysis(opts = {}) {
  const o = opts || {};
  const arch = o.arch || 'arm64';
  const engineOpt = o.engine ? { engine: o.engine } : {};
  const wasmOpt = o.wasmExports ? { wasmExports: o.wasmExports } : {};
  const common = { ...engineOpt, ...wasmOpt };

  const stringsByFunc = o.stringsByFunc ?? null;
  const apisByFunc = o.apisByFunc ?? null;
  const cryptoHints = o.cryptoHints ?? null;
  const objcModel = o.objcModel ?? null;
  const swiftModel = o.swiftModel ?? null;

  const out = {
    rmw: null,
    x86Rmw: null,
    vtables: null,
    jumpTables: null,
    constTables: null,
    callgraph: null,
    objcSwift: null,
    xrefLinks: null,
    cxxRtti: null,
    vtableRefOwners: null,
    objcMethods: null,
    unifiedMetadata: null,
    virtualTree: null,
    semanticNames: null,
    classFields: null,
  };

  const archLower = String(arch || '').toLowerCase();
  const isX86_64 = archLower === 'x86_64' || archLower === 'x64' || archLower === 'amd64';
  if (o.codeBytes instanceof Uint8Array && o.codeBytes.length >= 1) {
    if (o.codeBytes.length >= 4) {
      out.rmw = scanArm64RmwFields(o.codeBytes, { ...common, arch, maxOut: o.rmwMaxOut });
      const textVa = toBigIntOrNull(o.textVa) ?? toBigIntOrNull(o.baseVa) ?? 0n;
      out.jumpTables = scanArm64JumpTables(o.codeBytes, {
        ...common,
        arch,
        textVa,
        maxOut: o.jumpTableMaxOut,
      });
    }
    if (isX86_64) {
      out.x86Rmw = scanX86_64RmwFields(o.codeBytes, {
        ...common,
        arch,
        maxOut: o.rmwMaxOut,
      });
    }
  }

  const textLo = toBigIntOrNull(o.textLo);
  const textHi = toBigIntOrNull(o.textHi);
  const imageBase = toBigIntOrNull(o.imageBase);
  const hasExplicitSections = Array.isArray(o.dataSections) && o.dataSections.length > 0;
  const hasTextConst = o.textConstBytes instanceof Uint8Array;

  let scannedSections = null;

  if (!hasExplicitSections && !hasTextConst) {
    if (o.dataBytes instanceof Uint8Array && o.dataBytes.length >= 16) {
      if (textLo != null && textHi != null && textHi > textLo) {
        out.vtables = scanVtables(o.dataBytes, {
          ...common,
          textLo,
          textHi,
          ptrSize: o.ptrSize ?? 8,
          stripPac: o.stripPac !== false,
          imageBase,
          dataVa: toBigIntOrNull(o.dataVa),
          maxOut: o.vtableMaxOut,
        });
      }
      out.constTables = scanConstTables(o.dataBytes, {
        ...common,
        maxOut: o.constTableMaxOut,
      });
    }
  } else {
    const sections = [];
    if (hasExplicitSections) {
      for (let i = 0; i < o.dataSections.length; i++) {
        const sec = o.dataSections[i];
        if (sec && sec.bytes instanceof Uint8Array && sec.bytes.length >= 12) {
          sections.push(sec);
        }
      }
    } else {
      if (o.dataBytes instanceof Uint8Array && o.dataBytes.length >= 12) {
        sections.push({
          name: o.dataName || 'data',
          bytes: o.dataBytes,
          va: o.dataVa ?? null,
        });
      }
      if (
        o.textConstBytes instanceof Uint8Array
        && o.textConstBytes !== o.dataBytes
        && o.textConstBytes.length >= 12
      ) {
        sections.push({
          name: o.textConstName || '__TEXT.__const',
          bytes: o.textConstBytes,
          va: o.textConstVa ?? null,
        });
      }
    }

    const aggConstTables = [];
    const constBySection = [];
    let allConstWasm = true;
    let anyConstTruncated = false;

    const aggVtables = [];
    const vtBySection = [];
    let allVtWasm = true;
    let anyVtTruncated = false;

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const secName = sec.name || 'data';
      const secVa = toBigIntOrNull(sec.va);

      if (sec.scanConstTables !== false && sec.bytes.length >= 16) {
        const ct = scanConstTables(sec.bytes, {
          ...common,
          maxOut: o.constTableMaxOut,
        });
        if (ct.engine !== 'wasm') allConstWasm = false;
        if (ct.truncated) anyConstTruncated = true;
        constBySection.push({
          section: secName,
          count: ct.tables.length,
          engine: ct.engine,
          truncated: Boolean(ct.truncated),
        });
        for (let j = 0; j < ct.tables.length; j++) {
          const t = ct.tables[j];
          aggConstTables.push({
            ...t,
            section: secName,
            va: secVa != null ? secVa + BigInt(t.startOff) : null,
          });
        }
      }

      if (sec.scanVtables !== false && textLo != null && textHi != null && textHi > textLo) {
        const vt = scanVtables(sec.bytes, {
          ...common,
          textLo,
          textHi,
          ptrSize: o.ptrSize ?? 8,
          stripPac: o.stripPac !== false,
          imageBase,
          dataVa: secVa,
          maxOut: o.vtableMaxOut,
        });
        if (vt.engine !== 'wasm') allVtWasm = false;
        if (vt.truncated) anyVtTruncated = true;
        vtBySection.push({
          section: secName,
          count: vt.vtables.length,
          engine: vt.engine,
          truncated: Boolean(vt.truncated),
        });
        for (let j = 0; j < vt.vtables.length; j++) {
          const v = vt.vtables[j];
          aggVtables.push({
            ...v,
            section: secName,
            va: secVa != null ? secVa + BigInt(v.vtableOff) : null,
          });
        }
      }
    }

    if (constBySection.length > 0) {
      out.constTables = {
        tables: aggConstTables,
        engine: allConstWasm ? 'wasm' : 'js',
        truncated: anyConstTruncated,
        bySection: constBySection,
      };
    }
    scannedSections = sections;
    if (vtBySection.length > 0) {
      out.vtables = {
        vtables: aggVtables,
        engine: allVtWasm ? 'wasm' : 'js',
        truncated: anyVtTruncated,
        bySection: vtBySection,
      };
    }
  }

  let cgEdges = null;
  if (o.callgraph && typeof o.callgraph.numNodes === 'number' && o.callgraph.edgeSrc && o.callgraph.edgeDst) {
    const metrics = analyzeCallGraphMetrics(
      o.callgraph.numNodes,
      o.callgraph.edgeSrc,
      o.callgraph.edgeDst,
      common,
    );
    cgEdges = {
      nodes: o.callgraph.nodes ?? null,
      edgeSrc: o.callgraph.edgeSrc,
      edgeDst: o.callgraph.edgeDst,
    };
    out.callgraph = {
      ...metrics,
      ...(o.callgraph.nodes ? { nodes: o.callgraph.nodes } : {}),
      edgeSrc: o.callgraph.edgeSrc,
      edgeDst: o.callgraph.edgeDst,
    };
  } else if (o.program) {
    const cg = extractCallGraphFromProgram(o.program, o.symbols);
    if (cg && cg.numNodes > 0) {
      const metrics = analyzeCallGraphMetrics(cg.numNodes, cg.edgeSrc, cg.edgeDst, common);
      let recursiveCount = 0;
      let dispatcherCount = 0;
      let utilityHubCount = 0;
      let leafCount = 0;
      for (let i = 0; i < metrics.role.length; i++) {
        const r = metrics.role[i];
        if (r === CALLGRAPH_ROLE.RECURSIVE_SCC) recursiveCount++;
        else if (r === CALLGRAPH_ROLE.DISPATCHER) dispatcherCount++;
        else if (r === CALLGRAPH_ROLE.UTILITY_HUB) utilityHubCount++;
        else if (r === CALLGRAPH_ROLE.LEAF_COMPUTE) leafCount++;
      }
      cgEdges = {
        nodes: cg.nodes,
        edgeSrc: cg.edgeSrc,
        edgeDst: cg.edgeDst,
      };
      out.callgraph = {
        ...metrics,
        numNodes: cg.numNodes,
        numEdges: cg.edgeSrc.length,
        nodes: cg.nodes,
        edgeSrc: cg.edgeSrc,
        edgeDst: cg.edgeDst,
        summary: {
          recursiveCount,
          dispatcherCount,
          utilityHubCount,
          leafCount,
        },
      };
    }
  }

  const objcSwiftImg = o.image || o.objcSwiftImage || null;
  if (objcSwiftImg && Array.isArray(objcSwiftImg.sections) && objcSwiftImg.bytes instanceof Uint8Array) {
    const meta = scanObjcSwiftMetadataFromImage(objcSwiftImg, {
      ...common,
      imageBase: imageBase != null ? imageBase : undefined,
      stripPac: o.stripPac !== false,
    });
    if (meta && meta.sectionsScanned && meta.sectionsScanned.length > 0) {
      out.objcSwift = meta;
    }
  }

  if (out.vtables && Array.isArray(out.vtables.vtables) && out.vtables.vtables.length > 0) {
    try {
      const rtti = resolveStrippedCxxRtti({
        vtables: out.vtables,
        image: objcSwiftImg,
        sections: scannedSections,
        dataBytes: o.dataBytes instanceof Uint8Array ? o.dataBytes : null,
        dataVa: toBigIntOrNull(o.dataVa),
        imageBase: imageBase ?? 0n,
        textLo: textLo ?? 0n,
        textHi: textHi ?? 0n,
        ptrSize: o.ptrSize ?? 8,
        pointerFormat: o.pointerFormat ?? null,
        stripPac: o.stripPac !== false,
        resolveBindSymbol: typeof o.resolveBindSymbol === 'function' ? o.resolveBindSymbol : null,
        symbols: o.symbols ?? null,
        ...(o.rttiMaxClasses != null ? { maxClasses: o.rttiMaxClasses } : {}),
        ...(o.rttiMaxSlotsPerVtable != null ? { maxSlotsPerVtable: o.rttiMaxSlotsPerVtable } : {}),
      });
      if (rtti && (rtti.classes?.length > 0 || rtti.byFunction?.size > 0 || rtti.stats?.vtablesInput > 0)) {
        out.cxxRtti = rtti;
      }
    } catch (err) {
      out.cxxRtti = null;
      if (typeof o.onError === 'function') o.onError('cxxRtti', err);
    }
  }

  const fnSource = o.functions ?? o.symbols ?? o.program ?? null;
  const xrefTextVa = toBigIntOrNull(o.textVa) ?? toBigIntOrNull(o.baseVa) ?? textLo;
  const derivedTextHi = textHi ?? (
    xrefTextVa != null && o.codeBytes instanceof Uint8Array && o.codeBytes.length > 0
      ? xrefTextVa + BigInt(o.codeBytes.length)
      : null
  );
  const normalizedFns = fnSource ? normalizeFunctions(fnSource, derivedTextHi) : [];

  if (
    out.cxxRtti
    && Array.isArray(out.cxxRtti.classes)
    && out.cxxRtti.classes.length > 0
    && normalizedFns.length > 0
    && (o.codeBytes instanceof Uint8Array || objcSwiftImg)
  ) {
    try {
      const vtRef = resolveVtableRefOwners({
        cxxRtti: out.cxxRtti,
        codeBytes: o.codeBytes instanceof Uint8Array ? o.codeBytes : null,
        image: objcSwiftImg,
        textVa: xrefTextVa,
        textLo,
        functions: normalizedFns,
        arch,
      });
      if (vtRef && vtRef.addedByFunction && vtRef.addedByFunction.size > 0) {
        out.vtableRefOwners = vtRef;
        if (out.cxxRtti.byFunction instanceof Map && typeof out.cxxRtti.byFunction.set === 'function') {
          for (const [fnVa, link] of vtRef.addedByFunction.entries()) {
            if (!out.cxxRtti.byFunction.has(fnVa)) {
              out.cxxRtti.byFunction.set(fnVa, link);
            }
          }
          if (out.cxxRtti.stats && typeof out.cxxRtti.stats.linkedFunctions === 'number') {
            out.cxxRtti.stats.linkedFunctions = out.cxxRtti.byFunction.size;
          }
        }
      }
    } catch (err) {
      out.vtableRefOwners = null;
      if (typeof o.onError === 'function') o.onError('vtableRefOwners', err);
    }
  }

  let effectiveObjcModel = objcModel;
  if (!effectiveObjcModel && objcSwiftImg && Array.isArray(objcSwiftImg.sections) && objcSwiftImg.bytes instanceof Uint8Array) {
    try {
      const objcRes = resolveStrippedObjcMethods({
        image: objcSwiftImg,
        imageBase: imageBase ?? 0n,
        textLo: textLo ?? 0n,
        textHi: derivedTextHi ?? 0n,
        ptrSize: o.ptrSize ?? 8,
        pointerFormat: o.pointerFormat ?? null,
        stripPac: o.stripPac !== false,
      });
      if (objcRes && (objcRes.classes.length > 0 || objcRes.methodsByIMP.size > 0)) {
        out.objcMethods = objcRes;
        effectiveObjcModel = objcRes;
      }
    } catch (err) {
      out.objcMethods = null;
      if (typeof o.onError === 'function') o.onError('objcMethods', err);
    }
  }

  if (out.cxxRtti || out.objcSwift || effectiveObjcModel || swiftModel) {
    try {
      const unified = normalizeUnifiedMetadata({
        cxxRtti: out.cxxRtti,
        objcSwift: out.objcSwift,
        objcModel: effectiveObjcModel,
        swiftModel,
        symbols: o.symbols ?? null,
      });
      if (unified) {
        out.unifiedMetadata = unified;
      }
    } catch (err) {
      out.unifiedMetadata = null;
      if (typeof o.onError === 'function') o.onError('unifiedMetadata', err);
    }
  }

  if (fnSource && (out.vtables || out.constTables || out.cxxRtti)) {
    try {
      const links = linkWasmStructuralHints({
        codeBytes: o.codeBytes instanceof Uint8Array ? o.codeBytes : null,
        textVa: xrefTextVa,
        functions: fnSource,
        vtables: out.vtables,
        constTables: out.constTables,
        cxxRtti: out.cxxRtti,
        dataVa: toBigIntOrNull(o.dataVa),
        arch,
        maxInsns: o.xrefMaxInsns,
      });
      if (links && links.stats && links.stats.functionsInput > 0) {
        out.xrefLinks = links;
      }
    } catch (err) {
      out.xrefLinks = null;
      if (typeof o.onError === 'function') o.onError('xrefLinks', err);
    }
  }

  const hasTreeInputs = Boolean(
    (out.unifiedMetadata && out.unifiedMetadata.classes?.length > 0)
    || (out.cxxRtti && (out.cxxRtti.classes?.length > 0 || out.cxxRtti.byFunction?.size > 0))
    || (out.objcSwift && out.objcSwift.counts?.total > 0)
    || normalizedFns.length > 0
    || stringsByFunc
    || apisByFunc,
  );
  if (hasTreeInputs) {
    try {
      const tree = buildVirtualFolderTree({
        unifiedMetadata: out.unifiedMetadata,
        cxxRtti: out.cxxRtti,
        objcSwift: out.objcSwift,
        functions: normalizedFns,
        stringsByFunc,
        apisByFunc,
        callgraph: cgEdges,
        symbols: o.symbols ?? null,
      });
      if (tree) {
        out.virtualTree = tree;
      }
    } catch (err) {
      out.virtualTree = null;
      if (typeof o.onError === 'function') o.onError('virtualTree', err);
    }
  }

  const hasSemanticInputs = Boolean(
    out.virtualTree
    || out.unifiedMetadata
    || out.cxxRtti
    || out.xrefLinks
    || stringsByFunc
    || apisByFunc
    || cryptoHints,
  );
  if (hasSemanticInputs) {
    try {
      const names = buildSemanticNames({
        virtualTree: out.virtualTree,
        unifiedMetadata: out.unifiedMetadata,
        cxxRtti: out.cxxRtti,
        xrefLinks: out.xrefLinks,
        stringsByFunc,
        apisByFunc,
        callgraph: cgEdges,
        rmw: out.rmw,
        x86Rmw: out.x86Rmw,
        textVa: xrefTextVa ?? 0n,
        cryptoHints,
        functions: normalizedFns,
      });
      if (names) {
        out.semanticNames = names;
      }
    } catch (err) {
      out.semanticNames = null;
      if (typeof o.onError === 'function') o.onError('semanticNames', err);
    }
  }

  const hasFieldInputs = Boolean(
    out.cxxRtti
    && (out.cxxRtti.classes?.length > 0 || out.cxxRtti.byFunction?.size > 0)
    && (out.rmw || out.x86Rmw || o.accessesByFunc),
  );
  if (hasFieldInputs) {
    try {
      const fields = aggregateClassFields({
        cxxRtti: out.cxxRtti,
        accessesByFunc: o.accessesByFunc ?? null,
        rmw: out.rmw,
        x86Rmw: out.x86Rmw,
        textVa: xrefTextVa ?? 0n,
        functions: normalizedFns,
      });
      if (fields) {
        out.classFields = fields;
      }
    } catch (err) {
      out.classFields = null;
      if (typeof o.onError === 'function') o.onError('classFields', err);
    }
  }

  return out;
}
