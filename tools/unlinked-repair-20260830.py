from pathlib import Path
import re

ROOT = Path('.')


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(path, old, new, label=None):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label or path}: expected exactly one match, got {count}')
    write(path, text.replace(old, new, 1))


def replace_regex(path, pattern, repl, label=None, flags=0):
    text = read(path)
    new, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label or path}: expected one regex match, got {count}')
    write(path, new)


# #2516 — reuse the selected FAT Mach-O BinaryImage between analysis and pointer resolution.
replace_once(
    'js/platform/worker.js',
    """  let selected = image;\n  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {\n    selected = await parseMachOSource(source, {\n      sliceIndex: msg.sliceIndex,\n      signal,\n      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },\n    });\n  }\n  if (signal.aborted) throw new Error('Analysis cancelled');\n  return analysisFromBinaryImage(selected);\n""",
    """  let selected = image;\n  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {\n    // Share the same demand-cached slice artifact used by pointer resolution.\n    // A selected FAT slice must not be reparsed independently by every consumer.\n    selected = await pointerImageForSlice(msg.sliceIndex, signal);\n    if (!selected) return emptyAnalysis();\n  }\n  if (signal.aborted) throw new Error('Analysis cancelled');\n  return analysisFromBinaryImage(selected);\n""",
    '#2516 platform selected-slice reuse',
)

# #2705 — authenticated exception return mnemonics are system instructions, not generic flow.
replace_once(
    'js/arm64.js',
    "'system': 'svc hvc smc brk hlt dcps1 dcps2 dcps3 nop yield wfe wfi sev sevl hint clrex dsb dmb isb sys sysl mrs msr eret drps',",
    "'system': 'svc hvc smc brk hlt dcps1 dcps2 dcps3 nop yield wfe wfi sev sevl hint clrex dsb dmb isb sys sysl mrs msr eret eretaa eretab drps',",
    '#2705 ARM64 system presentation',
)

# #2732 — runtime authority inputs are evidence identity; structured values must fail closed.
replace_once(
    'js/runtime/authority.js',
    """function capabilityList(value) {\n  if (!Array.isArray(value)) return [];\n  const out = [...new Set(value.map(String).filter(Boolean))].sort();\n  for (const capability of out) if (!DEBUG_CAPABILITY_SET.has(capability)) throw new TypeError(`runtime-capability-unknown:${capability}`);\n  return out;\n}\n""",
    """function capabilityList(value) {\n  if (!Array.isArray(value)) return [];\n  const normalized = [];\n  for (const item of value) {\n    if (typeof item !== 'string' || !item.trim()) throw new TypeError('runtime-capability-invalid');\n    normalized.push(item.trim());\n  }\n  const out = [...new Set(normalized)].sort();\n  for (const capability of out) if (!DEBUG_CAPABILITY_SET.has(capability)) throw new TypeError(`runtime-capability-unknown:${capability}`);\n  return out;\n}\n\nfunction strictIdentityText(value) {\n  return typeof value === 'string' && value.trim() ? value.trim() : null;\n}\n\nfunction strictShaText(value) {\n  const text = strictIdentityText(value);\n  if (!text) return null;\n  const normalized = text.toLowerCase();\n  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;\n}\n""",
    '#2732 strict runtime capability identities',
)
replace_once(
    'js/runtime/authority.js',
    """function profileAllowed(value) {\n  const text = String(value ?? '').trim();\n  return PROVIDER_PROFILE_PATTERNS.some((pattern) => pattern.test(text));\n}\n\nfunction targetProfileAllowed(value) {\n  const text = String(value ?? '').trim();\n  return NATIVE_TARGET_PROFILES.has(text) || MANAGED_TARGET_PROFILE.test(text);\n}\n""",
    """function profileAllowed(value) {\n  const text = strictIdentityText(value);\n  return !!text && PROVIDER_PROFILE_PATTERNS.some((pattern) => pattern.test(text));\n}\n\nfunction targetProfileAllowed(value) {\n  const text = strictIdentityText(value);\n  return !!text && (NATIVE_TARGET_PROFILES.has(text) || MANAGED_TARGET_PROFILE.test(text));\n}\n""",
    '#2732 strict runtime profile identities',
)
replace_once(
    'js/runtime/authority.js',
    """  const proofProviderProfileId = proof.providerProfileId == null ? null : String(proof.providerProfileId).trim();\n  const proofTargetProfileId = proof.targetProfileId == null ? null : String(proof.targetProfileId).trim();\n  const proofProviderIdentity = proof.providerIdentity == null ? null : String(proof.providerIdentity).trim();\n  const proofBuildIdentity = proof.buildIdentity ?? proof.runtimeBuildIdentity ?? null;\n""",
    """  const proofProviderProfileId = proof.providerProfileId == null ? null : strictIdentityText(proof.providerProfileId);\n  const proofTargetProfileId = proof.targetProfileId == null ? null : strictIdentityText(proof.targetProfileId);\n  const proofProviderIdentity = proof.providerIdentity == null ? null : strictIdentityText(proof.providerIdentity);\n  const proofBuildRaw = proof.buildIdentity ?? proof.runtimeBuildIdentity ?? null;\n  const proofBuildIdentity = proofBuildRaw == null ? null : strictIdentityText(proofBuildRaw);\n  if (proof.providerProfileId != null && proofProviderProfileId == null) return 'runtime-proof-provider-profile-invalid';\n  if (proof.targetProfileId != null && proofTargetProfileId == null) return 'runtime-proof-target-profile-invalid';\n  if (proof.providerIdentity != null && proofProviderIdentity == null) return 'runtime-proof-provider-identity-invalid';\n  if (proofBuildRaw != null && proofBuildIdentity == null) return 'runtime-proof-build-identity-invalid';\n""",
    '#2732 strict proof identities',
)
replace_once(
    'js/runtime/authority.js',
    """  if (expectedBuildIdentity != null && binding.buildIdentity !== String(expectedBuildIdentity)) return 'runtime-build-identity-mismatch';\n  if (proofBuildIdentity != null && String(proofBuildIdentity) !== binding.buildIdentity) return 'runtime-proof-build-identity-mismatch';\n""",
    """  const expectedBuild = expectedBuildIdentity == null ? null : strictIdentityText(expectedBuildIdentity);\n  if (expectedBuildIdentity != null && expectedBuild == null) return 'runtime-build-identity-invalid';\n  if (expectedBuild != null && binding.buildIdentity !== expectedBuild) return 'runtime-build-identity-mismatch';\n  if (proofBuildIdentity != null && proofBuildIdentity !== binding.buildIdentity) return 'runtime-proof-build-identity-mismatch';\n""",
    '#2732 strict build identities',
)
replace_once(
    'js/runtime/authority.js',
    """  const normalizedProviderProfileId = providerProfileId == null ? null : String(providerProfileId).trim();\n  const normalizedTargetProfileId = targetProfileId == null ? null : String(targetProfileId).trim();\n""",
    """  const normalizedProviderProfileId = providerProfileId == null ? null : strictIdentityText(providerProfileId);\n  const normalizedTargetProfileId = targetProfileId == null ? null : strictIdentityText(targetProfileId);\n""",
    '#2732 strict support profile arguments',
)
replace_regex(
    'js/runtime/authority.js',
    r"    const proofHeadSha = proof\.headSha \?\? proof\.commitSha \?\? null;\n    const proofTreeSha = proof\.treeSha \?\? null;\n    const expectedHead = expectedHeadSha \?\? proof\.expectedHeadSha \?\? null;\n    const expectedTree = expectedTreeSha \?\? proof\.expectedTreeSha \?\? null;\n    if \(canonical\.commitSha == null \|\| canonical\.treeSha == null \|\| proofHeadSha == null \|\| proofTreeSha == null\) reason = 'runtime-proof-exact-identity-required';\n    else if \(String\(proofHeadSha\)\.toLowerCase\(\) !== canonical\.commitSha\) reason = 'runtime-proof-stale-head';\n    else if \(String\(proofTreeSha\)\.toLowerCase\(\) !== canonical\.treeSha\) reason = 'runtime-proof-stale-tree';\n    else if \(expectedHead != null && \(canonical\.commitSha !== String\(expectedHead\)\.toLowerCase\(\) \|\| String\(proofHeadSha\)\.toLowerCase\(\) !== String\(expectedHead\)\.toLowerCase\(\)\)\) reason = 'runtime-proof-stale-head';\n    else if \(expectedTree != null && \(canonical\.treeSha !== String\(expectedTree\)\.toLowerCase\(\) \|\| String\(proofTreeSha\)\.toLowerCase\(\) !== String\(expectedTree\)\.toLowerCase\(\)\)\) reason = 'runtime-proof-stale-tree';",
    """    const proofHeadRaw = proof.headSha ?? proof.commitSha ?? null;\n    const proofTreeRaw = proof.treeSha ?? null;\n    const expectedHeadRaw = expectedHeadSha ?? proof.expectedHeadSha ?? null;\n    const expectedTreeRaw = expectedTreeSha ?? proof.expectedTreeSha ?? null;\n    const proofHeadSha = strictShaText(proofHeadRaw);\n    const proofTreeSha = strictShaText(proofTreeRaw);\n    const expectedHead = expectedHeadRaw == null ? null : strictShaText(expectedHeadRaw);\n    const expectedTree = expectedTreeRaw == null ? null : strictShaText(expectedTreeRaw);\n    if (canonical.commitSha == null || canonical.treeSha == null || proofHeadSha == null || proofTreeSha == null\n        || (expectedHeadRaw != null && expectedHead == null) || (expectedTreeRaw != null && expectedTree == null)) reason = 'runtime-proof-exact-identity-required';\n    else if (proofHeadSha !== canonical.commitSha) reason = 'runtime-proof-stale-head';\n    else if (proofTreeSha !== canonical.treeSha) reason = 'runtime-proof-stale-tree';\n    else if (expectedHead != null && (canonical.commitSha !== expectedHead || proofHeadSha !== expectedHead)) reason = 'runtime-proof-stale-head';\n    else if (expectedTree != null && (canonical.treeSha !== expectedTree || proofTreeSha !== expectedTree)) reason = 'runtime-proof-stale-tree';""",
    '#2732 strict proof SHA values',
)

# #2744 — strict seed scalars in local runtime adapter.
replace_once(
    'js/adapters/index.js',
    """function boundedInteger(value, fallback, min, max) {\n  const n = Number(value);\n  if (!Number.isSafeInteger(n)) return fallback;\n  return Math.max(min, Math.min(max, n));\n}\n""",
    """function boundedInteger(value, fallback, min, max) {\n  const n = Number(value);\n  if (!Number.isSafeInteger(n)) return fallback;\n  return Math.max(min, Math.min(max, n));\n}\n\nfunction exactSeedSize(value) {\n  if (value == null) return 8;\n  if (typeof value !== 'number' || !Number.isSafeInteger(value) || ![1, 2, 4, 8].includes(value)) {\n    throw new DebugAdapterError('invalid-memory-size', 'runtime seed size must be one of 1, 2, 4, 8');\n  }\n  return value;\n}\n\nfunction exactSeedValue(value) {\n  if (value == null) return 0n;\n  if (typeof value === 'bigint') return value;\n  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);\n  if (typeof value === 'string' && /^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);\n  throw new DebugAdapterError('invalid-memory-value', 'runtime seed value must be an exact integer scalar');\n}\n""",
    '#2744 strict seed helpers',
)
replace_once(
    'js/adapters/index.js',
    """    for (const item of spec.heap || []) await emu.store(asAddress(item.address), Number(item.size ?? 8), BigInt(item.value || 0));\n    for (const item of spec.globalValues || []) await emu.store(asAddress(item.address), Number(item.size ?? 8), BigInt(item.value || 0));\n""",
    """    for (const item of spec.heap || []) await emu.store(asAddress(item.address), exactSeedSize(item.size), exactSeedValue(item.value));\n    for (const item of spec.globalValues || []) await emu.store(asAddress(item.address), exactSeedSize(item.size), exactSeedValue(item.value));\n""",
    '#2744 strict seed stores',
)

# #2769 — reject malformed Objective-C metadata ranges instead of coercing them.
replace_once(
    'js/apple/objc-metadata.js',
    """async function pointerTable(reader, range, kind, options = {}) {\n  if (!range || range.vmAddr == null || range.size == null || Number(range.size) === 0) {\n    return Object.assign([], { completeness:{ kind, present:false, complete:true, declaredBytes:0, parsedBytes:0, parsedEntries:0, misalignedBytes:0 } });\n  }\n  const size = Number(range.size);\n  const aligned = Number.isSafeInteger(size) && size > 0 && size % PTR_SIZE === 0;\n""",
    """async function pointerTable(reader, range, kind, options = {}) {\n  if (!range || range.vmAddr == null || range.size == null) {\n    return Object.assign([], { completeness:{ kind, present:false, complete:true, declaredBytes:0, parsedBytes:0, parsedEntries:0, misalignedBytes:0 } });\n  }\n  const exactNonnegative = (value) => {\n    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;\n    if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;\n    return null;\n  };\n  const size = exactNonnegative(range.size);\n  const vmAddrNumber = exactNonnegative(range.vmAddr);\n  if (size == null || vmAddrNumber == null) {\n    return Object.assign([], { completeness:{ kind, present:true, complete:false, declaredBytes:0, parsedBytes:0, parsedEntries:0, misalignedBytes:null, reason:'invalid-range-scalar' } });\n  }\n  if (size === 0) {\n    return Object.assign([], { completeness:{ kind, present:false, complete:true, declaredBytes:0, parsedBytes:0, parsedEntries:0, misalignedBytes:0 } });\n  }\n  const vmAddr = BigInt(vmAddrNumber);\n  const aligned = size % PTR_SIZE === 0;\n""",
    '#2769 strict objc metadata range',
)
replace_once(
    'js/apple/objc-metadata.js',
    "const slot = BigInt(range.vmAddr) + BigInt(offset);",
    "const slot = vmAddr + BigInt(offset);",
    '#2769 normalized objc metadata address',
)

# #2770 — Objective-C class/protocol identities must be actual strings.
replace_once(
    'js/apple/objc-runtime.js',
    """function cleanClassName(name) {\n  if (!name) return null;\n  return String(name)\n    .replace(/^OBJC_CLASS_\\$_/, '')\n    .replace(/^_OBJC_CLASS_\\$_/, '')\n    .replace(/^\\$s/, '$s');\n}\n""",
    """function cleanClassName(name) {\n  if (typeof name !== 'string' || !name) return null;\n  return name\n    .replace(/^OBJC_CLASS_\\$_/, '')\n    .replace(/^_OBJC_CLASS_\\$_/, '')\n    .replace(/^\\$s/, '$s');\n}\n""",
    '#2770 strict objc identity',
)
replace_once(
    'js/apple/objc-runtime.js',
    """    const info = {\n      name: cleanClassName(c.name),\n""",
    """    const info = {\n      name: cleanClassName(c.name),\n""",
    '#2770 class info anchor',
)
# Insert fail-closed checks after the two identity-bearing info objects are created.
text = read('js/apple/objc-runtime.js')
anchor = """      ambiguousMethods: new Map(),\n    };\n    for (const m of [...(c.instanceMethods || []), ...(c.classMethods || [])]) {\n"""
if anchor not in text:
    raise SystemExit('#2770 class insertion anchor missing')
text = text.replace(anchor, """      ambiguousMethods: new Map(),\n    };\n    if (!info.name) continue;\n    for (const m of [...(c.instanceMethods || []), ...(c.classMethods || [])]) {\n""", 1)
# Protocol construction uses the same object field shape later; guard protocol identity before insertion.
proto_anchor = """    const info = { name:cleanClassName(p.name), methods:new Map(), protocols:protocolSet(p.protocols), raw:p };\n    for (const m of [...(p.instanceMethods || []), ...(p.classMethods || [])]) {\n"""
if proto_anchor in text:
    text = text.replace(proto_anchor, """    const info = { name:cleanClassName(p.name), methods:new Map(), protocols:protocolSet(p.protocols), raw:p };\n    if (!info.name) continue;\n    for (const m of [...(p.instanceMethods || []), ...(p.classMethods || [])]) {\n""", 1)
write('js/apple/objc-runtime.js', text)

# #2518/#2569 — one worker-side exact content identity producer, reused by BinaryId/Notes/Workspace.
replace_once('js/backend.js', "import { sha256BlobHex } from './cache/content-identity.js';\n", '', '#2518 remove main-realm blob SHA')
replace_once(
    'js/backend.js',
    """    this.contentHash = null;\n    this.binaryId = null;\n    this._binaryIdPromise = null;\n""",
    """    this.contentHash = null;\n    this._contentHashPromise = null;\n    this.binaryId = null;\n    this._binaryIdPromise = null;\n""",
    '#2518 constructor content identity single-flight',
)
# There is a second reset block in open().
text = read('js/backend.js')
old_reset = """    this.contentHash=null;\n    this.binaryId=null;\n    this._binaryIdPromise=null;\n"""
if old_reset not in text:
    old_reset = """    this.contentHash = null;\n    this.binaryId = null;\n    this._binaryIdPromise = null;\n"""
if old_reset not in text:
    raise SystemExit('#2518 open reset anchor missing')
new_reset = old_reset.replace('    this.binaryId', '    this._contentHashPromise = null;\n    this.binaryId', 1)
text = text.replace(old_reset, new_reset, 1)
write('js/backend.js', text)
replace_regex(
    'js/backend.js',
    r"  async ensureBinaryId\(options = \{\}\) \{.*?\n  \}\n\n  async _analyzeArtifactPublic",
    """  async ensureBinaryId(options = {}) {\n    if (this.binaryId) return this.binaryId;\n    if (!this.file) throw new Error('binary-id-file-unavailable');\n    const file = this.file;\n    if (!this._binaryIdPromise) {\n      this._binaryIdPromise = this.ensureContentHash(options.onProgress, options.signal ?? null)\n        .then((hex) => {\n          if (this.file !== file) throw new StaleRequestError();\n          const binaryId = createBinaryIdFromDigest(hex);\n          this.binaryId = binaryId;\n          return binaryId;\n        })\n        .catch((error) => { this._binaryIdPromise = null; throw error; });\n    }\n    return this._binaryIdPromise;\n  }\n\n  async _analyzeArtifactPublic""",
    '#2518 worker-side BinaryId', flags=re.S,
)
replace_once(
    'js/backend.js',
    """  async ensureContentHash(onProgress, signal = null) {\n    if (this.contentHash) return this.contentHash;\n    const result = await awaitCancellableProducer(this._callTo('platform', 'hash', {}, null, onProgress), signal);\n    this.contentHash = result.hash;\n    return this.contentHash;\n  }\n""",
    """  async ensureContentHash(onProgress, signal = null) {\n    if (this.contentHash) return this.contentHash;\n    const file = this.file;\n    if (!file) throw new Error('content-hash-file-unavailable');\n    if (!this._contentHashPromise) {\n      const producer = this._callTo('platform', 'hash', { priority:'background' }, null, onProgress);\n      // The shared promise intentionally has no cancel() method: cancelling one\n      // waiter must not tear down the identity producer for Workspace/Artifacts.\n      this._contentHashPromise = Promise.resolve(producer).then((result) => {\n        if (this.file !== file) throw new StaleRequestError();\n        this.contentHash = result.hash;\n        return this.contentHash;\n      }).catch((error) => { this._contentHashPromise = null; throw error; });\n    }\n    return awaitCancellableProducer(this._contentHashPromise, signal);\n  }\n""",
    '#2518/#2569 shared content hash',
)

# #2569 — v4 Note identity binds exact BinaryId + slice metadata; v3 is only computed for one-time migration.
replace_once(
    'js/names.js',
    "const NOTE_KEY_CACHE = new WeakMap(); // File/ByteSource -> resolved slice identities\n",
    "const NOTE_KEY_CACHE = new WeakMap(); // File/ByteSource -> resolved slice identities\n\nexport function noteStoreExists(id) {\n  if (!id || typeof localStorage === 'undefined') return false;\n  try { return localStorage.getItem(PREFIX + id) != null; } catch { return false; }\n}\n",
    '#2569 current note-store existence',
)
# Insert v4 fast path after slice bounds are known, before v3 identity is built.
replace_once(
    'js/names.js',
    """  const identity = [\n    'v3', source.size.toString(),\n    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',\n    sliceOffset == null ? '' : sliceOffset.toString(),\n    sliceSize == null ? '' : sliceSize.toString(),\n  ].join('|');\n""",
    """  const identityParts = [\n    source.size.toString(), info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',\n    sliceOffset == null ? '' : sliceOffset.toString(), sliceSize == null ? '' : sliceSize.toString(),\n  ];\n  if (options.binaryId != null) {\n    if (typeof options.binaryId !== 'string' || !options.binaryId.trim()) throw new TypeError('note-binary-id-required');\n    const identity = ['v4', options.binaryId.trim(), ...identityParts].join('|');\n    const cacheable = (typeof file === 'object' && file !== null) || typeof file === 'function';\n    let cache = cacheable ? NOTE_KEY_CACHE.get(file) : null;\n    if (cache?.has(identity)) return cache.get(identity);\n    if (cacheable) { if (!cache) { cache=new Map(); NOTE_KEY_CACHE.set(file,cache); } cache.set(identity, identity); }\n    return identity;\n  }\n  const identity = ['v3', ...identityParts].join('|');\n""",
    '#2569 Note v4 identity',
)
# Add a cheap legacy-v3 candidate probe without reading file bytes.
insert_marker = "export async function noteKeyFor(file, fileInfo, sliceIndex, options = {}) {"
text = read('js/names.js')
idx = text.find(insert_marker)
if idx < 0:
    raise SystemExit('#2569 noteKeyFor marker missing')
helper = """export function hasLegacyV3NoteCandidate(file, fileInfo, sliceIndex) {\n  if (!file || typeof localStorage === 'undefined') return false;\n  const slices = fileInfo && fileInfo.slices || [];\n  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;\n  const info = slice && slice.info;\n  let sliceOffset = null, sliceSize = null;\n  try {\n    if (slice?.offset != null && slice?.size != null) {\n      const off=BigInt(slice.offset), size=BigInt(slice.size), total=BigInt(file.size ?? 0);\n      if (off >= 0n && size >= 0n && off <= total && size <= total - off) { sliceOffset=off; sliceSize=size; }\n    }\n  } catch { sliceOffset=null; sliceSize=null; }\n  const identity = ['v3', String(file.size ?? 0), info?.uuid || '', info?.cpu || '', info?.cpuSub || '',\n    sliceOffset == null ? '' : sliceOffset.toString(), sliceSize == null ? '' : sliceSize.toString()].join('|');\n  const prefix = PREFIX + identity + '|';\n  try { for (let i=0;i<localStorage.length;i++) if (localStorage.key(i)?.startsWith(prefix)) return true; } catch { return false; }\n  return false;\n}\n\n"""
text = text[:idx] + helper + text[idx:]
write('js/names.js', text)

# #2504/#2569 wiring in App: remove eager recognition and use canonical BinaryId for Notes.
replace_once(
    'js/app.js',
    "import { NoteStore, noteKeyFor, legacyV2NoteKeyFor, legacyNoteKeyForSlice, EMPTY_NOTES } from './names.js';",
    "import { NoteStore, noteKeyFor, noteStoreExists, hasLegacyV3NoteCandidate, legacyV2NoteKeyFor, legacyNoteKeyForSlice, EMPTY_NOTES } from './names.js';",
    '#2569 app note imports',
)
replace_once(
    'js/app.js',
    """        return Promise.allSettled([\n          this.ensureSwift(),\n          this.ensureRecognition({ maxFunctions: 350000 }),\n        ]);\n""",
    """        // Swift metadata remains a bounded background warmup. Recognition is\n        // demand-driven by Investigation/Results and must not compete with first paint.\n        return Promise.allSettled([this.ensureSwift()]);\n""",
    '#2504 remove eager recognition',
)
replace_regex(
    'js/app.js',
    r"      const \[id, legacyV2\] = await Promise\.all\(\[\n        noteKeyFor\(file,info,sliceIndex,\{signal:controller\.signal\}\),\n        legacyV2NoteKeyFor\(file,info,sliceIndex\),\n      \]\);\n      if \(controller\.signal\.aborted \|\| epoch !== this\.backend\.gen \|\| this\.store\.get\('file'\) !== file \|\| this\.store\.get\('sliceIndex'\) !== sliceIndex\) return null;\n      const notes=new NoteStore\(id,\[legacyV2,legacyNoteKeyForSlice\(file,info,sliceIndex\)\]\);",
    """      const binaryId = await this.backend.ensureBinaryId({ signal:controller.signal });\n      const id = await noteKeyFor(file,info,sliceIndex,{signal:controller.signal,binaryId});\n      const legacyV2 = await legacyV2NoteKeyFor(file,info,sliceIndex);\n      let legacyV3 = null;\n      if (!noteStoreExists(id) && hasLegacyV3NoteCandidate(file,info,sliceIndex)) {\n        legacyV3 = await noteKeyFor(file,info,sliceIndex,{signal:controller.signal});\n      }\n      if (controller.signal.aborted || epoch !== this.backend.gen || this.store.get('file') !== file || this.store.get('sliceIndex') !== sliceIndex) return null;\n      const notes=new NoteStore(id,[legacyV3,legacyV2,legacyNoteKeyForSlice(file,info,sliceIndex)]);\n      if (legacyV3 && notes.legacyCandidate?.sourceId === legacyV3) notes.importLegacyCandidate({save:true});""",
    '#2569 app Note v4 migration',
)

# #2622 — Panels are optional UI: do not put the full panel graph on App startup.
replace_regex(
    'js/app.js',
    r"import \{\n  showFileInfo, showSections, showJump, showSearch, showDetail, showSettings,\n  instructionMenu, showFunctions, showStrings, showStructure, showHelp,\n  showLearn, showGlossary, showWelcome, showSampleGuide, showFunctionSummary,\n  showFeatures, showInvestigate, showOverview, showFunctionReport, showAccuracyNotes,\n\} from './panels\.js';",
    """let panelsModulePromise = null;\nconst loadPanels = () => (panelsModulePromise ||= import('./panels.js'));\nconst lazyPanel = (name) => (...args) => loadPanels().then((mod) => mod[name](...args));\nconst showFileInfo=lazyPanel('showFileInfo'), showSections=lazyPanel('showSections'), showJump=lazyPanel('showJump');\nconst showSearch=lazyPanel('showSearch'), showDetail=lazyPanel('showDetail'), showSettings=lazyPanel('showSettings');\nconst instructionMenu=lazyPanel('instructionMenu'), showFunctions=lazyPanel('showFunctions'), showStrings=lazyPanel('showStrings');\nconst showStructure=lazyPanel('showStructure'), showHelp=lazyPanel('showHelp'), showLearn=lazyPanel('showLearn');\nconst showGlossary=lazyPanel('showGlossary'), showWelcome=lazyPanel('showWelcome'), showSampleGuide=lazyPanel('showSampleGuide');\nconst showFunctionSummary=lazyPanel('showFunctionSummary'), showFeatures=lazyPanel('showFeatures'), showInvestigate=lazyPanel('showInvestigate');\nconst showOverview=lazyPanel('showOverview'), showFunctionReport=lazyPanel('showFunctionReport'), showAccuracyNotes=lazyPanel('showAccuracyNotes');""",
    '#2622 lazy panels', flags=re.S,
)

# #2507/#2515/#2522 — legacy Find/Overview surfaces consume the canonical InvestigationService.
replace_once(
    'js/panels-base.js',
    "import { productDescriptor } from './platform/product-descriptor.js';\n",
    "import { productDescriptor } from './platform/product-descriptor.js';\nimport { investigationServiceFor } from './analysis/investigation-service.js';\n",
    '#2515 investigation service import',
)
# Overview: replace the old prepare->recognition->autoAnalyze chain with service.overview.
replace_regex(
    'js/panels-base.js',
    r"    prepare\(app, box\)\.then\(async \(\{ strings, program, shapes \}\) => \{.*?      renderAutoReport\(app, sheet, later, report, region\);\n    \}\)\.catch\(\(err\) => \{",
    """    investigationServiceFor(app).overview({\n      signal:runController.signal,\n      priority:'user-visible',\n      onProgress:(p) => {\n        if (p?.all) box.set({ done:p.done || 0, all:p.all });\n        if (p?.phase) box.say(autoPhaseText(p.phase));\n      },\n    }).then(({ report }) => {\n      box.done();\n      if (cancelled || !sheet.root.isConnected) return;\n      app.autoReport = { report, key: region ? region.id : null, gen: app.symbols.gen };\n      renderAutoReport(app, sheet, later, report, region);\n    }).catch((err) => {""",
    '#2507/#2522 canonical overview service', flags=re.S,
)
# Candidates: canonical producer returns context/ranked/pin; keep presentation unchanged.
replace_regex(
    'js/panels-base.js',
    r"  prepare\(app, box\)\.then\(async \(\{ strings, program, shapes \}\) => \{\n    if \(!sheet\.root\.isConnected\) \{ box\.done\(\); return; \}\n    const region = app\.codeRegion\(\);\n\n    /\*.*?\*/\n    const ranked = rankCandidates\(\{\n      goal, strings, program, symbols: app\.symbols, region, limit: 40,\n      vendors: vendorsOf\(app\.fields\),\n    \}\);\n    const pin = await pinnedFor\(app, goal, \{\n      strings, program, shapes, region, box, ranked: ranked\.candidates,\n      signal: controller\.signal,\n    \}\);\n    box\.done\(\);",
    """  investigationServiceFor(app).investigate(goal, {\n    signal:controller.signal,\n    priority:'user-blocking',\n    limit:40,\n    onProgress:(p) => { if (p?.all) box.set({done:p.done || 0,all:p.all}); if (p?.phase) box.say(autoPhaseText(p.phase)); },\n  }).then(async ({ context, ranked, pin }) => {\n    if (!sheet.root.isConnected) { box.done(); return; }\n    const { strings, program, shapes } = context;\n    const region = context.region || app.codeRegion();\n    box.done();""",
    '#2515 canonical candidates service', flags=re.S,
)

# #2549 — local function story paints before whole-program relationship enrichment.
replace_regex(
    'js/panels-base.js',
    r"  Promise\.all\(\[\n    analyzeFunctionCached\(app\.backend, region, startRow, endRow, sym, \(p\) => box\.set\(\{ done: p, all: 1 \}\)\),\n    app\.ensureProgram\(\),\n  \]\)\.then\(\(\[res, program\]\) => \{\n    box\.done\(\);\n    if \(!sheet\.root\.isConnected\) return;\n    applySemantic\(app, region, res\);\n    const report = buildFunctionReport\(\{\n      model: res\.model, region, symbols: sym, program, goal, name,",
    """  const reportController = new AbortController();\n  sheet.onClose = () => reportController.abort('function-report-closed');\n  analyzeFunctionCached(app.backend, region, startRow, endRow, sym, (p) => box.set({ done: p, all: 1 }))\n  .then((res) => {\n    box.done();\n    if (!sheet.root.isConnected || reportController.signal.aborted) return;\n    applySemantic(app, region, res);\n    const report = buildFunctionReport({\n      model: res.model, region, symbols: sym, program:null, goal, name,""",
    '#2549 local-first report', flags=re.S,
)
# After base render, start cancellable shared Program enrichment and update only call relationship DOM when it arrives.
replace_once(
    'js/panels-base.js',
    """    report.role = roleFromReport(report, { apis: res.model.facts.apis });\n    renderFunctionReport(app, sheet, later, report, res, region, goal);\n  }).catch((err) => {\n""",
    """    report.role = roleFromReport(report, { apis: res.model.facts.apis });\n    renderFunctionReport(app, sheet, later, report, res, region, goal);\n    // Relationship enrichment is deliberately outside the first-paint critical path.\n    investigationServiceFor(app).buildProgram({ signal:reportController.signal, priority:'background' })\n      .then((program) => {\n        if (!program || reportController.signal.aborted || !sheet.root.isConnected) return;\n        const enriched = buildFunctionReport({ model:res.model, region, symbols:sym, program, goal, name, fields:app.fields, owner:app.ownerOf(start) });\n        const callBlock = body.querySelector('[data-function-relationships]');\n        if (callBlock) renderFunctionRelationships(app, sheet, callBlock, enriched, goal);\n      }).catch(() => {});\n  }).catch((err) => {\n""",
    '#2549 relationship enrichment task',
)
# Extract relationship renderer and mark its block so enrichment can replace it without repainting local report.
replace_once(
    'js/panels-base.js',
    """  /* 6. 呼び出し関係 */\n  const callBlk = block(pick('呼び出し関係', 'Call relationships'));\n  const cul = list();\n""",
    """  /* 6. 呼び出し関係 */\n  const callBlk = block(pick('呼び出し関係', 'Call relationships'));\n  callBlk.dataset.functionRelationships = 'true';\n  renderFunctionRelationships(app, sheet, callBlk, report, goal);\n  body.append(callBlk);\n\n  /* 7. 処理の流れ（制御フロー） */\n""",
    '#2549 relationship block delegation',
)
# Remove the old inline relationship block through the duplicated next-section marker.
replace_regex(
    'js/panels-base.js',
    r"  cul\.append\(groupRow\(pick\('この関数を呼んでいる .*?  body\.append\(callBlk\);\n\n  /\* 7\. 処理の流れ（制御フロー） \*/\n",
    "",
    '#2549 remove old inline relationship body', flags=re.S,
)
# Insert shared relationship renderer immediately before renderFunctionReport.
marker = "function renderFunctionReport(app, sheet, body, report, res, region, goal) {"
text = read('js/panels-base.js')
idx = text.find(marker)
if idx < 0:
    raise SystemExit('#2549 renderFunctionReport marker missing')
helper = r'''function renderFunctionRelationships(app, sheet, callBlk, report, goal) {
  callBlk.replaceChildren();
  callBlk.append(el('div', 'blk-title', pick('呼び出し関係', 'Call relationships')));
  const cul = list();
  const complete = report?.completeness?.callsComplete === true || report?.callsComplete === true;
  cul.append(groupRow(pick('この関数を呼んでいる (' + report.callers.length + ')', 'Callers (' + report.callers.length + ')')));
  if (!report.callers.length) cul.append(tapRow(complete ? pick('呼び出し元はありません。', 'No callers.') : pick('まだ全体の呼び出し関係を確認中です。', 'Call relationships are still incomplete.'), { disabled:true }));
  for (const c of report.callers.slice(0, 12)) cul.append(tapRow(c.name || (c.addr != null ? 'sub_' + c.addr.toString(16).toUpperCase() : addrHex(c.site)), { sub:addrHex(c.site), onTap:()=>{sheet.close();showFunctionReport(app,c.addr != null ? c.addr : c.site,goal);} }));
  cul.append(groupRow(pick('この関数が呼んでいる (' + report.callees.length + ')', 'Callees (' + report.callees.length + ')')));
  if (!report.callees.length) cul.append(tapRow(complete ? pick('ほかの処理は呼んでいません。', 'It calls nothing else.') : pick('呼び出し先はまだ確認中です。', 'Callees are still incomplete.'), { disabled:true }));
  for (const c of report.callees.slice(0, 12)) cul.append(tapRow(c.name || 'sub_' + c.addr.toString(16).toUpperCase(), { sub:addrHex(c.addr), onTap:()=>{sheet.close();showFunctionReport(app,c.addr,goal);} }));
  callBlk.append(cul);
}

'''
text = text[:idx] + helper + text[idx:]
write('js/panels-base.js', text)

# #2519/#2502 — canonical query owns evidence projection and targeted relations.
# Evidence query projects symbol provenance inside the query boundary, so UI never re-reads live state after query completion.
replace_once(
    'js/analysis/query/app-adapter.js',
    """      const rows = [];\n      const deep = app?.autoReport?.report?.deep || [];\n""",
    """      const rows = [];\n      if (targetAddress != null) {\n        const boundaryEvidence = app?.symbols?.functionEvidence?.(targetAddress) ?? null;\n        const nameEvidence = app?.symbols?.nameEvidence?.(targetAddress) ?? null;\n        rows.push({ kind:'function-boundary', address:targetAddress, detail:boundaryEvidence?.source || 'unknown-source', evidence:boundaryEvidence, verdict:boundaryEvidence?.confirmed === true ? 'confirmed' : 'unverified' });\n        rows.push({ kind:'function-name', address:targetAddress, detail:app?.symbols?.nameAt?.(targetAddress) || 'no-symbol-name', evidence:nameEvidence, verdict:nameEvidence?.confirmed === true ? 'confirmed' : 'unverified' });\n      }\n      const deep = app?.autoReport?.report?.deep || [];\n""",
    '#2519 evidence projection ownership',
)
# Replace whole-program relation query methods with targeted xrefs/local-function producers.
replace_regex(
    'js/analysis/query/app-adapter.js',
    r"    async callers\(_snapshot, id, page = \{\}, options = \{\}\) \{.*?\n    async types\(_snapshot, scope, _page = \{\}, options = \{\}\) \{",
    r'''    async callers(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.backend?.xrefs !== 'function') return unsupported(id, 'targeted-xref-unavailable');
      const regions = (storeValue(app, 'regions') || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
      const rows = [], reasons = [];
      for (const region of regions) {
        if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('AbortError'), {name:'AbortError'});
        const request = app.backend.xrefs({ regionId:region.id, target:address, limit:MAX_PAGE }, options.onProgress);
        if (options.signal) options.signal.addEventListener('abort', () => request.cancel?.(), {once:true});
        let result;
        try { result = await request; } catch (error) { if (options.signal?.aborted) throw error; reasons.push(`${region.id}:xref-failed`); continue; }
        if (result?.unsupported) { reasons.push(`${region.id}:xref-unsupported`); continue; }
        if (result?.capped || result?.cancelled || result?.complete === false) reasons.push(`${region.id}:${result?.truncationReason || 'xref-partial'}`);
        for (const hit of result?.results || []) {
          const site = BigInt(hit.addr ?? hit.address ?? hit.site);
          const fn = app?.symbols?.functionAt?.(site);
          rows.push({ addr:fn?.start ?? site, site, target:address, kind:hit.kind ?? 'reference', regionId:region.id });
        }
      }
      const dedup = [...new Map(rows.map((row) => [`${row.addr}:${row.site}`, row])).values()];
      const completeness = reasons.length === 0 && app?.symbols?.functionStartsComplete === true ? 'complete' : 'partial';
      return paged(dedup, page, completeness, { reason:reasons[0] || (app?.symbols?.functionStartsComplete === true ? null : 'function-discovery-incomplete') });
    },

    async callees(_snapshot, id, page = {}, options = {}) {
      const result = await loadFunction(id, options);
      if (!result?.value) return unsupported(id, result?.status?.reason || 'function-producer-unavailable');
      const calls = result.value?.calls || result.value?.semanticFacts?.calls || result.value?.model?.facts?.calls || [];
      const rows = [];
      for (const call of calls) {
        const target = addressOf(call?.target ?? call?.address ?? call?.callee);
        if (target != null) rows.push({ addr:target, site:addressOf(call?.site ?? call?.from ?? call?.address) ?? null, name:call?.name ?? null });
      }
      return paged(rows, page, result.status?.completeness ?? 'partial', { reason:result.status?.reason ?? null });
    },

    async xrefs(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.backend?.xrefs !== 'function') return unsupported(id, 'targeted-xref-unavailable');
      const regions = (storeValue(app, 'regions') || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
      const rows = [], reasons = [];
      for (const region of regions) {
        if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('AbortError'), {name:'AbortError'});
        const request = app.backend.xrefs({ regionId:region.id, target:address, limit:MAX_PAGE }, options.onProgress);
        if (options.signal) options.signal.addEventListener('abort', () => request.cancel?.(), {once:true});
        let result;
        try { result = await request; } catch (error) { if (options.signal?.aborted) throw error; reasons.push(`${region.id}:xref-failed`); continue; }
        if (result?.unsupported) { reasons.push(`${region.id}:xref-unsupported`); continue; }
        if (result?.capped || result?.cancelled || result?.complete === false) reasons.push(`${region.id}:${result?.truncationReason || 'xref-partial'}`);
        for (const hit of result?.results || []) rows.push({ kind:hit.kind ?? 'reference', site:BigInt(hit.addr ?? hit.address ?? hit.site), target:address, regionId:region.id });
      }
      rows.sort((a,b)=>a.site<b.site?-1:a.site>b.site?1:0);
      return paged(rows, page, reasons.length ? 'partial' : 'complete', { reason:reasons[0] || null });
    },

    async types(_snapshot, scope, _page = {}, options = {}) {''',
    '#2502 targeted relation queries', flags=re.S,
)

# Product Evidence tab renders only canonical query rows, not live symbol state after the query resolves.
replace_regex(
    'js/ui/product.js',
    r"        const stack = h\('div', 'ui-evidence-stack'\);\n        const name = app\.symbols\?\.nameAt\?\.\(addr\);.*?        const items = Array\.isArray\(res\.value\) \? res\.value : \[\];",
    """        const stack = h('div', 'ui-evidence-stack');\n        const items = Array.isArray(res.value) ? res.value : [];""",
    '#2519 UI evidence snapshot ownership', flags=re.S,
)

# #2552/#2558/#2559 — sandbox lifecycle + canonical Script query boundary.
replace_once(
    'js/sandbox.js',
    """          const allowed = api && typeof m.method === 'string' && Object.prototype.hasOwnProperty.call(api, m.method);\n          const fn = allowed ? api[m.method] : null;\n          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);\n          // All host APIs receive a final execution context. Existing JS APIs\n          // harmlessly ignore the extra argument; long-running adapters can\n          // observe signal and cancel backend/worker work immediately.\n          value = await fn(...(m.args || []), { signal: runController.signal });\n""",
    """          const allowed = api && typeof m.method === 'string' && !m.method.startsWith('__') && Object.prototype.hasOwnProperty.call(api, m.method);\n          const fn = allowed ? api[m.method] : null;\n          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);\n          const context = { signal:runController.signal };\n          value = typeof api.__hexInvoke === 'function'\n            ? await api.__hexInvoke(m.method, m.args || [], context)\n            : await fn(...(m.args || []));\n""",
    '#2552 explicit sandbox invocation context',
)
replace_once(
    'js/script.js',
    "import { runInSandbox } from './sandbox.js';\n",
    "import { runInSandbox } from './sandbox.js';\nimport { investigationServiceFor } from './analysis/investigation-service.js';\n",
    '#2552 script investigation import',
)
# Add query helpers before api object.
replace_once(
    'js/script.js',
    """  const boundedSteps = (n) => Math.max(1, Math.min(MAX_EMULATOR_STEPS, Math.trunc(Number(n) || 20000)));\n\n  const api = {\n""",
    """  const boundedSteps = (n) => Math.max(1, Math.min(MAX_EMULATOR_STEPS, Math.trunc(Number(n) || 20000)));\n  const completenessOf = (result) => result?.completeness ?? result?.status?.completeness ?? 'partial';\n  const decoratePage = (rows, result) => {\n    rows.complete = completenessOf(result) === 'complete';\n    rows.reason = result?.reason ?? result?.status?.reason ?? null;\n    rows.next = result?.page?.next ?? null;\n    rows.total = result?.page?.total ?? null;\n    return rows;\n  };\n  const snapshotFor = (signal) => app.analysisQueries.snapshot({ signal });\n  const queryFunctions = async (query = {}, page = {}, context = {}) => {\n    const snapshot = await snapshotFor(context.signal);\n    return app.analysisQueries.functions(snapshot, query, page, { signal:context.signal });\n  };\n  const allFunctions = async (limit = 100000, context = {}) => {\n    const max = Math.max(1, Math.min(350000, Number.isSafeInteger(Number(limit)) ? Number(limit) : 100000));\n    const rows = []; let offset = 0, final = null;\n    while (rows.length < max) {\n      const result = await queryFunctions({}, { offset, limit:Math.min(5000, max - rows.length) }, context);\n      final = result;\n      for (const item of result?.value || []) rows.push({ addr:BigInt(item.address), name:item.name || null, size:item.size ?? null });\n      if (result?.page?.next == null) break;\n      offset = result.page.next;\n    }\n    decoratePage(rows, final);\n    if (rows.length >= max && final?.page?.next != null) { rows.complete=false; rows.reason='script-function-limit'; rows.next=final.page.next; }\n    return rows;\n  };\n  const relation = async (method, addr, limit, context = {}) => {\n    const snapshot = await snapshotFor(context.signal);\n    const result = await app.analysisQueries[method](snapshot, BigInt(addr), { offset:0, limit:Math.max(1,Math.min(5000,Number(limit)||200)) }, { signal:context.signal });\n    return decoratePage(Array.from(result?.value || []), result);\n  };\n\n  const api = {\n""",
    '#2558 script query helpers',
)
# Existing synchronous functions() remains for trusted direct callers; sandbox invocation routes it canonically.
# Replace relation methods with canonical direct-call implementations too.
replace_regex(
    'js/script.js',
    r"    /\* ── 参照関係 ─+ \*/\n\n    /\*\* そのアドレスを呼んでいる場所。 \*/\n    async xrefsTo\(addr, limit = 200\) \{.*?    async mostCalled\(limit = 20\) \{.*?    \},",
    """    /* ── 参照関係 ─────────────────────────────────────── */\n\n    /** そのアドレスを呼んでいる場所。 */\n    async xrefsTo(addr, limit = 200) { return relation('xrefs', addr, limit); },\n\n    /** その関数が呼んでいる先。 */\n    async xrefsFrom(addr, limit = 200) { return relation('callees', addr, limit); },\n\n    /** よく呼ばれている関数の順位。 */\n    async mostCalled(limit = 20) {\n      const program = await investigationServiceFor(app).buildProgram({ priority:'user-visible' });\n      const rows = program?.mostCalled ? Array.from(program.mostCalled(limit)) : [];\n      rows.complete = program?.graphCompleteness?.complete === true && program?.callsCapped !== true;\n      rows.reason = rows.complete ? null : (program?.queryIncompleteReason || 'program-partial');\n      return rows;\n    },""",
    '#2559 canonical script relations', flags=re.S,
)
# Add explicit invocation adapter before returning API.
replace_once(
    'js/script.js',
    """  return { api, print };\n}\n""",
    """  Object.defineProperty(api, '__hexInvoke', { enumerable:false, value:async (method, args, context = {}) => {\n    switch (method) {\n      case 'functions': return allFunctions(args[0], context);\n      case 'queryFunctions': return queryFunctions(args[0] || {}, args[1] || {}, context);\n      case 'xrefsTo': return relation('xrefs', args[0], args[1], context);\n      case 'xrefsFrom': return relation('callees', args[0], args[1], context);\n      case 'loadStrings': return investigationServiceFor(app).collectStrings({ signal:context.signal, priority:'user-visible' });\n      case 'decompile': return api.decompile(args[0], context);\n      case 'types': return api.types(args[0], context);\n      case 'struct': return api.struct(args[0], args[1], context);\n      case 'run': {\n        const emu=makeEmulator(app); emu.setup(BigInt(args[0]), (args[1] || []).map((v)=>BigInt(v)));\n        await emu.run(boundedSteps(args[2]), null, { signal:context.signal });\n        return { x0:emu.x[0], steps:emu.steps, stopped:emu.stopped, log:emu.log.slice(-256), regs:emu.registerList() };\n      }\n      case 'emulatorRun': {\n        const emu=emulatorOf(args[0]); const result=await emu.run(boundedSteps(args[1]), null, {signal:context.signal}); return {result,state:emulatorState(emu)};\n      }\n      default: return api[method](...(args || []));\n    }\n  }});\n  api.queryFunctions = (query = {}, page = {}) => queryFunctions(query, page);\n  return { api, print };\n}\n""",
    '#2552 host invocation adapter',
)
# Pass signal through function analysis methods.
replace_once('js/script.js', '    async decompile(addr) {', '    async decompile(addr, options = {}) {', '#2552 decompile signal signature')
replace_once('js/script.js', '      const res = await app.analyzeFunctionAt(a);', '      const res = await app.analyzeFunctionAt(a, { signal:options.signal });', '#2552 decompile signal')
replace_once('js/script.js', '    async types(addr) {\n      const res = await app.analyzeFunctionAt(BigInt(addr));', '    async types(addr, options = {}) {\n      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:options.signal });', '#2552 types signal')
replace_once('js/script.js', '    async struct(addr, reg) {\n      const res = await app.analyzeFunctionAt(BigInt(addr));', '    async struct(addr, reg, options = {}) {\n      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:options.signal });', '#2552 struct signal')
replace_once(
    'js/script.js',
    """export async function runScript(code, app, out) {\n  const { api, print } = createApi(app, out);\n  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args) });\n}\n""",
    """export async function runScript(code, app, out, options = {}) {\n  const { api, print } = createApi(app, out);\n  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args), signal:options.signal ?? null });\n}\n""",
    '#2552 runScript signal',
)

# #2622 + #2552 plugin: optional sandbox code is lazy and execution accepts lifecycle signal.
replace_once('js/plugins.js', "import { createApi } from './script.js';\nimport { runInSandbox } from './sandbox.js';\n", '', '#2622 lazy plugin sandbox imports')
replace_once(
    'js/plugins.js',
    """    const discovered = await runInSandbox({\n      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,\n    });\n""",
    """    const { runInSandbox } = await import('./sandbox.js');\n    const discovered = await runInSandbox({\n      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000, signal:opts.signal ?? null,\n    });\n""",
    '#2622 lazy plugin discovery sandbox',
)
replace_once(
    'js/plugins.js',
    """  async run(id, out) {\n    const p = this.plugins.find((x) => x.id === id);\n    if (!p) return { error: 'そのプラグインが見つかりません。' };\n    const { api, print } = createApi(this.app, out);\n    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,\n      out: (...args) => print(...args) });\n  }\n""",
    """  async run(id, out, options = {}) {\n    const p = this.plugins.find((x) => x.id === id);\n    if (!p) return { error: 'そのプラグインが見つかりません。' };\n    const [{ createApi }, { runInSandbox }] = await Promise.all([import('./script.js'), import('./sandbox.js')]);\n    const { api, print } = createApi(this.app, out);\n    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,\n      out: (...args) => print(...args), signal:options.signal ?? null });\n  }\n""",
    '#2552 plugin signal/lazy runtime',
)

# Script and Plugin sheet lifecycle owns active sandbox runs.
replace_once(
    'js/tools-base.js',
    """export function showScript(app) {\n  const sheet = new Sheet('スクリプト');\n""",
    """export function showScript(app) {\n  let activeRun = null;\n  const abortActive = () => { activeRun?.abort('script-sheet-closed'); activeRun=null; };\n  const sheet = new Sheet('スクリプト', { onClose:abortActive });\n""",
    '#2552 Script sheet lifecycle',
)
replace_once(
    'js/tools-base.js',
    """  async function run() {\n    out.replaceChildren();\n""",
    """  async function run() {\n    activeRun?.abort('script-rerun');\n    const controller = new AbortController();\n    activeRun = controller;\n    out.replaceChildren();\n""",
    '#2552 Script rerun cancellation',
)
replace_once(
    'js/tools-base.js',
    """    const res = await runScript(ta.value, app, write);\n    if (res.error) {\n""",
    """    const res = await runScript(ta.value, app, write, { signal:controller.signal });\n    if (controller.signal.aborted || !sheet.root.isConnected || activeRun !== controller) return;\n    activeRun = null;\n    if (res.error) {\n""",
    '#2552 Script signal propagation',
)
replace_once(
    'js/tools-base.js',
    """export function showPlugins(app) {\n  const sheet = new Sheet('プラグイン');\n""",
    """export function showPlugins(app) {\n  let activePluginRun = null;\n  const abortPluginRun = () => { activePluginRun?.abort('plugin-sheet-closed'); activePluginRun=null; };\n  const sheet = new Sheet('プラグイン', { onClose:abortPluginRun });\n""",
    '#2552 Plugin parent lifecycle',
)
replace_once(
    'js/tools-base.js',
    """  function runPlugin(p) {\n    const s = new Sheet(p.name);\n    const out = el('div', 'codeview small');\n""",
    """  function runPlugin(p) {\n    activePluginRun?.abort('plugin-rerun');\n    const controller = new AbortController();\n    activePluginRun = controller;\n    const s = new Sheet(p.name, { onClose:() => controller.abort('plugin-run-sheet-closed') });\n    const out = el('div', 'codeview small');\n""",
    '#2552 Plugin run lifecycle',
)
replace_once(
    'js/tools-base.js',
    """    app.plugins.run(p.id, write).then((res) => {\n      if (res.error) write('⚠ ' + res.error);\n      else write('— おわり —');\n    });\n""",
    """    app.plugins.run(p.id, write, { signal:controller.signal }).then((res) => {\n      if (controller.signal.aborted || !s.root.isConnected || activePluginRun !== controller) return;\n      activePluginRun = null;\n      if (res.error) write('⚠ ' + res.error);\n      else write('— おわり —');\n    });\n""",
    '#2552 Plugin signal propagation',
)

# Regression test: semantic/wiring checks for repaired and already-fixed open issues (#2688/#2773 included).
Path('tests/unlinked-current-regressions.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRuntimeAuthorityBinding, runtimeProfileSupport } from '../js/runtime/authority.js';
import { arm64DecodedEncodingWord } from '../js/targets/architecture/arm64/encoding-word.js';

const source = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// #2773: contradictory encoding sources fail closed.
assert.equal(arm64DecodedEncodingWord({ word:0xd65f03c0, rawBytes:Uint8Array.of(0,0,0,0) }), null);
assert.equal(arm64DecodedEncodingWord({ rawBytes:[192,3,95,214] }), 0xd65f03c0);
assert.equal(arm64DecodedEncodingWord({ rawBytes:[256,3,95,214] }), null);

// #2732: object/array profile identities may not stringify into authority.
const binding = createRuntimeAuthorityBinding({
  providerIdentity:'p', providerProfileId:'native:remote-debug-v1:qemu-lldb', runtimeInstanceIdentity:'r',
  targetIdentity:'t', targetProfileId:'arm64:a64', binaryIdentity:'b', buildIdentity:'build', moduleIdentity:'m',
  loadMappingIdentity:'map', sessionIdentity:'s', capabilityVersion:'1', commitSha:'a'.repeat(40), treeSha:'b'.repeat(40), epoch:0,
});
const malformed = runtimeProfileSupport({ binding, providerProfileId:['native:remote-debug-v1:qemu-lldb'], targetProfileId:'arm64:a64', requiredCapabilities:['readMemory'], providerCapabilities:{readMemory:true} });
assert.notEqual(malformed.status, 'supported-for-exact-provider-profile');

// #2516/#2518/#2569: selected slice + identity paths are shared/canonical.
assert.match(source('js/platform/worker.js'), /selected = await pointerImageForSlice\(msg\.sliceIndex, signal\)/);
assert.doesNotMatch(source('js/backend.js'), /sha256BlobHex/);
assert.match(source('js/backend.js'), /this\.ensureContentHash\(options\.onProgress, options\.signal/);
assert.match(source('js/names.js'), /'v4', options\.binaryId\.trim\(\)/);

// #2504/#2507/#2515/#2522: recognition is demand-driven and UI uses InvestigationService.
assert.doesNotMatch(source('js/app.js'), /this\.ensureRecognition\(\{ maxFunctions: 350000 \}\)/);
assert.match(source('js/panels-base.js'), /investigationServiceFor\(app\)\.overview/);
assert.match(source('js/panels-base.js'), /investigationServiceFor\(app\)\.investigate/);

// #2502/#2519: query boundary owns relations/evidence.
assert.match(source('js/analysis/query/app-adapter.js'), /targeted-xref-unavailable/);
assert.doesNotMatch(source('js/ui/product.js'), /const boundaryEvidence = app\.symbols\?\.functionEvidence/);

// #2552/#2558/#2559: Script/Plugin cancellation and canonical query routing.
assert.match(source('js/script.js'), /case 'functions': return allFunctions/);
assert.match(source('js/script.js'), /case 'xrefsTo': return relation\('xrefs'/);
assert.match(source('js/tools-base.js'), /script-sheet-closed/);
assert.match(source('js/plugins.js'), /signal:options\.signal/);

// #2622: heavy panels and sandbox/plugin runtime are no longer eager startup imports.
assert.doesNotMatch(source('js/app.js'), /from '\.\/panels\.js'/);
assert.doesNotMatch(source('js/plugins.js'), /^import .*\.\/script\.js/m);
assert.doesNotMatch(source('js/plugins.js'), /^import .*\.\/sandbox\.js/m);

// #2688 already fixed on main: namespace EvidenceStore writers are detected.
assert.match(source('tools/validation/legacy-evidence-writers.mjs'), /namespaceImportRegex/);

// #2705/#2744/#2769/#2770 strictness wiring.
assert.match(source('js/arm64.js'), /eret eretaa eretab/);
assert.match(source('js/adapters/index.js'), /exactSeedValue/);
assert.match(source('js/apple/objc-metadata.js'), /invalid-range-scalar/);
assert.match(source('js/apple/objc-runtime.js'), /typeof name !== 'string'/);

console.log('unlinked-current-regressions: ok');
''')

print('unlinked repair patch applied')
