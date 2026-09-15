const indexCache = new WeakMap();

// #8768: canonical per-module namespace/type index. Validator and lifter used
// to re-filter the full import array per call/global/table instruction and
// enumerateMethods linearly scanned exports per function, making decode work
// O(instructions x imports) / O(functions x exports). One shared, lazily built
// frozen index makes every namespace resolution O(1) per module.
function buildWasmModuleIndex(wasmModule) {
  const imports = Array.isArray(wasmModule.imports) ? wasmModule.imports : [];
  const importedFunctionTypeIndices = [];
  const importedFunctionEntries = [];
  const importedTables = [];
  const importedMemories = [];
  const importedGlobals = [];
  for (const entry of imports) {
    const desc = entry?.desc;
    if (!desc) continue;
    if (desc.kind === 0) { importedFunctionTypeIndices.push(desc.typeIndex); importedFunctionEntries.push(entry); }
    else if (desc.kind === 1) importedTables.push(desc);
    else if (desc.kind === 2) importedMemories.push(desc);
    else if (desc.kind === 3) importedGlobals.push(desc);
  }
  const functions = Array.isArray(wasmModule.functions) ? wasmModule.functions : [];
  const tables = Array.isArray(wasmModule.tables) ? wasmModule.tables : [];
  const memories = Array.isArray(wasmModule.memories) ? wasmModule.memories : [];
  const globals = Array.isArray(wasmModule.globals) ? wasmModule.globals : [];
  const functionTypeIndices = new Array(importedFunctionTypeIndices.length + functions.length);
  for (let i = 0; i < importedFunctionTypeIndices.length; i++) functionTypeIndices[i] = importedFunctionTypeIndices[i];
  for (let i = 0; i < functions.length; i++) functionTypeIndices[importedFunctionTypeIndices.length + i] = functions[i];
  return Object.freeze({
    importedFunctionCount: importedFunctionTypeIndices.length,
    importedFunctions: Object.freeze(importedFunctionEntries),
    functionTypeIndices: Object.freeze(functionTypeIndices),
    importedTableCount: importedTables.length,
    tableCount: importedTables.length + tables.length,
    tables: Object.freeze([...importedTables, ...tables]),
    importedMemoryCount: importedMemories.length,
    memoryCount: importedMemories.length + memories.length,
    memories: Object.freeze([...importedMemories, ...memories]),
    globalCount: importedGlobals.length + globals.length,
    globals: Object.freeze([...importedGlobals, ...globals]),
  });
}

export function wasmModuleIndex(wasmModule) {
  const module = wasmModule && typeof wasmModule === 'object' ? wasmModule : {};
  // Only frozen images (canonical parsed modules) are cacheable; live views of
  // mutable caller-provided objects are rebuilt so a later mutation can never
  // be served a stale index.
  if (wasmModule && typeof wasmModule === 'object' && Object.isFrozen(wasmModule)) {
    const cached = indexCache.get(wasmModule);
    if (cached) return cached;
    const index = buildWasmModuleIndex(module);
    indexCache.set(wasmModule, index);
    return index;
  }
  return buildWasmModuleIndex(module);
}
