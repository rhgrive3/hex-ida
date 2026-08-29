from pathlib import Path


def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def rep(path, old, new, count=1):
    s=read(path)
    if s.count(old) < count:
        raise SystemExit(f'expected source fragment missing in {path}: {old[:160]!r}')
    write(path, s.replace(old, new, count))

# One ABI-layout truth shared by the classic worker and the Swift runtime model.
Path('js/swift-abi-layout.js').write_text(r'''(function installSwiftAbiLayout(root) {
  'use strict';
  const PROTOCOL_REQUIREMENT_KINDS = Object.freeze([
    'base-protocol', 'method', 'init', 'getter', 'setter',
    'read-coroutine', 'modify-coroutine',
    'associated-type-access-function', 'associated-conformance-access-function',
  ]);
  const FUNCTION_REQUIREMENT_KINDS = new Set([1, 2, 3, 4, 5, 6]);

  function classDescriptorTail(flags) {
    const raw = Number(flags) >>> 0;
    const specific = (raw >>> 16) & 0xffff;
    const isGeneric = !!(raw & 0x80);
    const hasResilientSuperclass = !!(specific & (1 << 13));
    const metadataInitKind = specific & 0x3;
    const hasVTable = !!(specific & (1 << 15));
    return Object.freeze({
      specific, isGeneric, hasResilientSuperclass, metadataInitKind, hasVTable,
      canParseTail: !isGeneric && !hasResilientSuperclass && metadataInitKind === 0,
    });
  }

  function protocolDescriptor(flags) {
    const specific = ((Number(flags) >>> 0) >>> 16) & 0xffff;
    return Object.freeze({ specific, isResilient: !!(specific & 0x2) });
  }

  function protocolRequirement(flags) {
    const raw = Number(flags) >>> 0;
    const kindId = raw & 0x0f;
    const kind = PROTOCOL_REQUIREMENT_KINDS[kindId] || 'unknown';
    const isCoroutine = kindId === 5 || kindId === 6;
    const asyncBit = !!(raw & 0x20);
    const isAsync = !isCoroutine && asyncBit;
    return Object.freeze({
      flags: raw, kindId, kind, known: kindId < PROTOCOL_REQUIREMENT_KINDS.length,
      instance: !!(raw & 0x10), async: isAsync, coroutine: isCoroutine,
      extraDiscriminator: (raw >>> 16) & 0xffff,
      isFunctionImplementation: FUNCTION_REQUIREMENT_KINDS.has(kindId) && !isAsync,
    });
  }

  root.HexSwiftAbiLayout = Object.freeze({
    protocolRequirementKinds: PROTOCOL_REQUIREMENT_KINDS,
    classDescriptorTail,
    protocolDescriptor,
    protocolRequirement,
  });
})(globalThis);
''')

rep('js/worker.js',
    "importScripts('./worker-legacy.js');",
    "importScripts('./swift-abi-layout.js');\nimportScripts('./worker-legacy.js');")

rep('js/worker-legacy.js',
'''      const generic = !!(flags & 0x80);
      const specific = (flags >>> 16) & 0xffff;
      const metadataInit = specific & 0x3;
      const resilientSuperclass = kind === 16 && !!(specific & (1 << 13));
      const fixedSize = kind === 16 ? 44 : 28;''',
'''      const generic = !!(flags & 0x80);
      const classLayout = kind === 16 ? globalThis.HexSwiftAbiLayout.classDescriptorTail(flags) : null;
      const specific = classLayout?.specific ?? ((flags >>> 16) & 0xffff);
      const metadataInit = classLayout?.metadataInitKind ?? (specific & 0x3);
      const resilientSuperclass = classLayout?.hasResilientSuperclass ?? false;
      const fixedSize = kind === 16 ? 44 : 28;''')
rep('js/worker-legacy.js',
    '      const hasVTable = kind === 16 && !!(specific & (1 << 15));',
    '      const hasVTable = classLayout?.hasVTable === true;')

rep('js/swift.js',
    '/* Swift ABI metadata intelligence. */',
    "import './swift-abi-layout.js';\n\n/* Swift ABI metadata intelligence. */\nconst SwiftAbiLayout = globalThis.HexSwiftAbiLayout;\nif (!SwiftAbiLayout) throw new Error('Swift ABI layout helper unavailable');")

rep('js/swift.js',
"export async function parseSwiftProtocolDescriptor(read,address){const addr=BigInt(address),b=await exact(read,addr,24);if(!b)return null;const flags=u32(b,0);if(contextKind(flags)!=='protocol')return null;const name=await relativeString(read,addr+8n,i32(b,8));if(!name)return null;return{runtime:'swift',kind:'protocol',address:addr,flags,name,parent:rel(addr+4n,i32(b,4)),numRequirementsInSignature:u32(b,12),numRequirements:u32(b,16),associatedTypeNames:rel(addr+20n,i32(b,20)),requirements:[]};}",
r'''export async function parseSwiftProtocolDescriptor(read,address){
  const addr=BigInt(address),b=await exact(read,addr,24);if(!b)return null;
  const flags=u32(b,0);if(contextKind(flags)!=='protocol')return null;
  const name=await relativeString(read,addr+8n,i32(b,8));if(!name)return null;
  return{runtime:'swift',kind:'protocol',address:addr,flags,name,parent:rel(addr+4n,i32(b,4)),numRequirementsInSignature:u32(b,12),numRequirements:u32(b,16),associatedTypeNames:rel(addr+20n,i32(b,20)),resilient:SwiftAbiLayout.protocolDescriptor(flags).isResilient,requirements:[],requirementsComplete:false};
}

async function parseSwiftProtocolRequirements(read,protocol,budget=4096){
  const declared=Number(protocol?.numRequirements||0),limit=Math.min(normalizeBudget(budget,4096,100000),4096);
  if(protocol?.numRequirementsInSignature!==0)return{items:[],declared,scanned:0,complete:false,reason:'generic-requirement-signature-unsupported'};
  if(protocol?.resilient)return{items:[],declared,scanned:0,complete:false,reason:'resilient-protocol-layout-unsupported'};
  if(!Number.isSafeInteger(declared)||declared<0||declared>limit)return{items:[],declared,scanned:0,complete:false,reason:'protocol-requirement-budget'};
  const items=[];let scanned=0;
  for(let i=0;i<declared;i++){
    const at=protocol.address+24n+BigInt(i*8),b=await exact(read,at,8);
    if(!b)return{items,declared,scanned,complete:false,reason:'protocol-requirement-unreadable'};
    scanned++;
    const decoded=SwiftAbiLayout.protocolRequirement(u32(b,0));
    if(!decoded.known)return{items,declared,scanned,complete:false,reason:'protocol-requirement-kind-unsupported'};
    items.push({...decoded,index:i,address:at,defaultImplementation:rel(at+4n,i32(b,4))});
  }
  return{items,declared,scanned,complete:items.length===declared,reason:null};
}
''')

rep('js/swift.js',
'''function vtableShape(type){
  if(type?.kind!=='class')return{present:false,eligible:false};
  const specific=(type.flags>>>16)&0xffff,hasVTable=!!(specific&(1<<15));
  if(!hasVTable)return{present:false,eligible:false};
  return{present:true,eligible:!type.generic&&!(specific&(1<<13))&&(specific&3)===0,specific};
}''',
'''function vtableShape(type){
  if(type?.kind!=='class')return{present:false,eligible:false};
  const layout=SwiftAbiLayout.classDescriptorTail(type.flags);
  return{...layout,present:layout.hasVTable,eligible:layout.hasVTable&&layout.canParseTail};
}''')

rep('js/swift.js',
'''  const identityStatus=scanCompleteness({declared:types.length+protocols.length,scanned:types.length+protocols.length,parsed:identityResolved,invalidEntries:types.length+protocols.length-identityResolved});
  for(const t of types)if(t.fieldDescriptor!=null){try{t.fields=await parseSwiftFieldDescriptor(read,t.fieldDescriptor,Math.min(budget,4096));}catch{t.fields=[];warnings.push(`Swift fields unreadable for ${t.name||t.address}`);typeScan.status.complete=false;typeScan.status.invalidEntries=(typeScan.status.invalidEntries||0)+1;}}''',
'''  const identityStatus=scanCompleteness({declared:types.length+protocols.length,scanned:types.length+protocols.length,parsed:identityResolved,invalidEntries:types.length+protocols.length-identityResolved});
  let protocolRequirementParsed=0,protocolRequirementUnsupported=0,protocolRequirementUnreadable=0;
  for(const proto of protocols){
    const parsed=await parseSwiftProtocolRequirements(read,proto,Math.min(budget,4096));
    proto.requirements=parsed.items;proto.requirementsComplete=parsed.complete;proto.requirementsStatus=parsed;
    if(parsed.complete)protocolRequirementParsed++;
    else if(parsed.reason?.includes('unsupported')||parsed.reason?.includes('budget'))protocolRequirementUnsupported++;
    else protocolRequirementUnreadable++;
  }
  const protocolRequirementStatus=scanCompleteness({present:protocols.length>0,declared:protocols.length,scanned:protocols.length,parsed:protocolRequirementParsed,unsupported:protocolRequirementUnsupported,unreadableSlots:protocolRequirementUnreadable});
  for(const t of types)if(t.fieldDescriptor!=null){try{t.fields=await parseSwiftFieldDescriptor(read,t.fieldDescriptor,Math.min(budget,4096));}catch{t.fields=[];warnings.push(`Swift fields unreadable for ${t.name||t.address}`);typeScan.status.complete=false;typeScan.status.invalidEntries=(typeScan.status.invalidEntries||0)+1;}}''')

rep('js/swift.js',
'''    const entries=await parseSwiftWitnessTable(read,seed.address,count,budget,opts);if(entries.length!==count)witnessUnreadable++;
    const checked=[];for(const entry of entries){const proof=await executableTarget(opts,entry.target);if(entry.rawTarget!=null&&!proof.verified)witnessInvalidTargets++;checked.push({...entry,rawResolvedTarget:entry.target,target:proof.target,resolved:proof.verified});}
    witnessTables.push({...seed,entries:checked});witnessParsed++;''',
'''    const entries=await parseSwiftWitnessTable(read,seed.address,count,budget,opts);if(entries.length!==count)witnessUnreadable++;
    const requirements=Array.isArray(seed.requirements)?seed.requirements:null,checked=[];
    for(const entry of entries){
      const requirement=requirements?.[entry.index]||null,dispatchable=requirement?requirement.isFunctionImplementation===true:true;
      const proof=dispatchable?await executableTarget(opts,entry.target):{target:null,verified:false};
      if(dispatchable&&entry.rawTarget!=null&&!proof.verified)witnessInvalidTargets++;
      checked.push({...entry,requirement,dispatchable,rawResolvedTarget:entry.target,target:proof.target,resolved:dispatchable&&proof.verified});
    }
    witnessTables.push({...seed,entries:checked});witnessParsed++;''')

rep('js/swift.js',
'''    if(!type||!proto||c.conditionalRequirements!==0||c.resilientWitnesses||proto.numRequirementsInSignature!==0){witnessDeclared++;witnessUnsupported++;continue;}
    await addWitness({address:c.witnessTable,typeAddress:type.address,protocolAddress:proto.address,typeName:preferredTypeName(type),protocolName:preferredTypeName(proto)||proto.name,count:proto.numRequirements,source:'conformance-descriptor'});''',
'''    const requirements=proto?.requirements||[];
    if(!type||!proto||c.conditionalRequirements!==0||c.resilientWitnesses||proto.requirementsComplete!==true||requirements.some((r)=>r.isFunctionImplementation!==true)){witnessDeclared++;witnessUnsupported++;continue;}
    await addWitness({address:c.witnessTable,typeAddress:type.address,protocolAddress:proto.address,typeName:preferredTypeName(type),protocolName:preferredTypeName(proto)||proto.name,count:requirements.length,requirements,source:'conformance-descriptor'});''')

rep('js/swift.js',
'''  const completeness={types:typeScan.status,protocols:protoScan.status,conformances:confScan.status,identity:identityStatus,vtables:vtableStatus,witnessTables:witnessStatus};''',
'''  const completeness={types:typeScan.status,protocols:protoScan.status,protocolRequirements:protocolRequirementStatus,conformances:confScan.status,identity:identityStatus,vtables:vtableStatus,witnessTables:witnessStatus};''')

rep('js/swift.js',
'''entry=table?.entries?.find((x)=>x.index===Number(call.slot));const positive=!!entry&&entry.target!=null,complete=dispatchComplete(index,'witnessTables');''',
'''entry=table?.entries?.find((x)=>x.index===Number(call.slot));const positive=!!entry&&entry.dispatchable!==false&&entry.target!=null,complete=dispatchComplete(index,'witnessTables');''')

# Canonical executable instruction-address proof for runtime dispatch targets.
rep('js/app.js',
'''const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;

class App {''',
'''const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;

function executableInstructionAddress(app, address) {
  const addr = BigInt(address);
  if (!app.executableRegionFor(addr)) return false;
  const info = app.store?.get?.('fileInfo') || {};
  const arch = String(info.arch || info.architecture || app.backend?.arch || '').toLowerCase();
  let alignment = null;
  if (arch.includes('arm64') || arch.includes('aarch64')) alignment = 4n;
  else if (arch === 'arm' || arch.includes('armv7')) alignment = 2n;
  else if (arch.includes('x86') || arch.includes('amd64') || arch.includes('x64')) alignment = 1n;
  else if (arch.includes('riscv')) alignment = 2n;
  if (alignment == null) return false;
  return addr % alignment === 0n;
}

class App {''')
rep('js/app.js',
    'isExecutableAddress:(addr)=>!!this.executableRegionFor(addr)',
    'isExecutableAddress:(addr)=>executableInstructionAddress(this,addr)',
    2)

# Make legacy ObjC absolute IMPs use the same resolver as extended metadata.
rep('js/objc-legacy.js',
'''function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }

async function pointer(get, addr) {''',
'''function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }
async function canonicalPointer(get, value, storageAddress = null) {
  if (!value) return null;
  if (typeof get.resolvePointer === 'function') {
    try { const resolved=await get.resolvePointer(value,{address:storageAddress,imageBase:get.base}); return resolved==null?null:BigInt(resolved); }
    catch { return null; }
  }
  return cleanPointer(get,value);
}

async function pointer(get, addr) {''')
rep('js/objc-legacy.js',
'''async function validateMethodImp(get, imp) {
  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:imp != null };
  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))) }; } catch { return { known:true, valid:false }; }
}''',
'''async function validateMethodImp(get, imp, pointerProven = true) {
  if (!pointerProven) return { known:true, valid:false, reason:'pointer-resolution-unproven' };
  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:false, reason:'executable-proof-unavailable' };
  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))), reason:null }; } catch { return { known:true, valid:false, reason:'executable-proof-failed' }; }
}''')
rep('js/objc-legacy.js',
'''    } else {
      nameAddr = cleanPointer(get, u64(b, 0));
      imp = cleanPointer(get, u64(b, 16));
    }
    if (imp == null) { markLegacyPartial(completeness, 'method-imp-unresolved', 'incompleteMethodLists'); continue; }
    const rawImp = imp, impProof = await validateMethodImp(get, imp);''',
'''    } else {
      nameAddr = cleanPointer(get, u64(b, 0));
      imp = await canonicalPointer(get, u64(b, 16), entry + 16n);
    }
    if (imp == null) { markLegacyPartial(completeness, 'method-imp-unresolved', 'incompleteMethodLists'); continue; }
    const rawImp = imp, pointerProven = relative || typeof get.resolvePointer === 'function' || get.pointerFormat != null;
    const impProof = await validateMethodImp(get, imp, pointerProven);''')
rep('js/objc-legacy.js',
'''  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;
  get.isExecutableAddress = opts.isExecutableAddress || null;''',
'''  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;
  get.resolvePointer = opts.resolvePointer || null;
  get.isExecutableAddress = opts.isExecutableAddress || null;''')

# Build the resolver before parsing the legacy model so both paths share it.
rep('js/objc.js',
'''  const effectivePointerFormat = pointerFormat ?? classList?.pointerFormat ?? classList?.pointer_format ?? null;
  const isExecutableAddress = typeof runtimeSections?.isExecutableAddress === 'function' ? runtimeSections.isExecutableAddress : null;
  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, effectivePointerFormat, { isExecutableAddress });
  const binaryImage = runtimeSections?.binaryImage || null;
  let resolvePointer = typeof runtimeSections?.resolvePointer === 'function'
    ? runtimeSections.resolvePointer
    : null;''',
'''  const effectivePointerFormat = pointerFormat ?? classList?.pointerFormat ?? classList?.pointer_format ?? null;
  const isExecutableAddress = typeof runtimeSections?.isExecutableAddress === 'function' ? runtimeSections.isExecutableAddress : null;
  const binaryImage = runtimeSections?.binaryImage || null;
  let resolvePointer = typeof runtimeSections?.resolvePointer === 'function'
    ? runtimeSections.resolvePointer
    : null;''')
rep('js/objc.js',
'''  if (!resolvePointer && effectivePointerFormat != null) {
    resolvePointer = (raw, context = {}) => sanitizePointer(
      BigInt(raw),
      context.imageBase ?? imageBase ?? null,
      effectivePointerFormat,
    );
  }
  const extra = await parseObjcExtendedMetadata(read, runtimeSections, {''',
'''  if (!resolvePointer && effectivePointerFormat != null) {
    resolvePointer = (raw, context = {}) => sanitizePointer(
      BigInt(raw),
      context.imageBase ?? imageBase ?? null,
      effectivePointerFormat,
    );
  }
  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, effectivePointerFormat, { isExecutableAddress, resolvePointer });
  const extra = await parseObjcExtendedMetadata(read, runtimeSections, {''')

# Extended absolute IMPs also fail closed when no canonical pointer decoder exists.
rep('js/apple/objc-metadata.js',
'''async function validateMethodImp(get, imp) {
  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:imp != null };
  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))) }; } catch { return { known:true, valid:false }; }
}''',
'''async function validateMethodImp(get, imp, pointerProven = true) {
  if (!pointerProven) return { known:true, valid:false };
  if (imp == null || typeof get.isExecutableAddress !== 'function') return { known:false, valid:false };
  try { return { known:true, valid:!!(await get.isExecutableAddress(BigInt(imp))) }; } catch { return { known:true, valid:false }; }
}''')
rep('js/apple/objc-metadata.js',
'''    const rawImp = imp;
    const impProof = source.startsWith('protocol') ? { known:true, valid:false } : await validateMethodImp(get, imp);''',
'''    const rawImp = imp, pointerProven = relative || typeof get.resolvePointer === 'function';
    const impProof = source.startsWith('protocol') ? { known:true, valid:false } : await validateMethodImp(get, imp, pointerProven);''')

# Preserve compact-unwind sentinel ownership as the last function's safe extent.
rep('js/binary/macho-core.js',
    '  const functionAddresses = new Set();',
    '  const functionUpperBounds = new Map();')
rep('js/binary/macho-core.js',
    '      functionAddresses.add(addr);',
    '      functionUpperBounds.set(addr, imageBase + BigInt(rangeEnd));')
rep('js/binary/macho-core.js',
'''  const sortedAddresses=[...functionAddresses].sort((a,b)=>(a<b?-1:a>b?1:0));
  for(let i=0;i<sortedAddresses.length;i++){
    const start=sortedAddresses[i],end=sortedAddresses[i+1]??null,sizeBytes=end!=null?Number(end-start):null;''',
'''  const sortedAddresses=[...functionUpperBounds.keys()].sort((a,b)=>(a<b?-1:a>b?1:0));
  for(let i=0;i<sortedAddresses.length;i++){
    const start=sortedAddresses[i],next=sortedAddresses[i+1]??null,pageEnd=functionUpperBounds.get(start)??null;
    const end=next!=null&&pageEnd!=null&&next<=pageEnd?next:pageEnd,sizeBytes=end!=null?Number(end-start):null;''')

# Strengthen Swift witness and shared-layout regressions.
rep('tests/unlinked-swift-runtime.test.mjs',
"u32(0x1400,3);rel(0x1404,0x500);rel(0x1408,0x1840);u32(0x140c,0);u32(0x1410,1);i32(0x1414,0);str(0x1840,'Damageable');",
"u32(0x1400,3);rel(0x1404,0x500);rel(0x1408,0x1840);u32(0x140c,0);u32(0x1410,1);i32(0x1414,0);u32(0x1418,0x11);i32(0x141c,0);str(0x1840,'Damageable');")
rep('tests/unlinked-swift-runtime.test.mjs',
'''const model=await buildSwiftMetadataModel(read,sections,opts);assert.equal(model.complete,true);''',
'''await import('../js/swift-abi-layout.js');assert.equal(globalThis.HexSwiftAbiLayout.classDescriptorTail(0x80000000).hasVTable,true);assert.equal(globalThis.HexSwiftAbiLayout.protocolRequirement(0x11).isFunctionImplementation,true);
const model=await buildSwiftMetadataModel(read,sections,opts);assert.equal(model.complete,true);''')
rep('tests/unlinked-swift-runtime.test.mjs',
'''const partial=await buildSwiftMetadataModel(read,sections,{...opts,budget:1});assert.equal(partial.complete,false);assert.equal(resolveSwiftDispatch(buildSwiftRuntimeIndex(partial),{kind:'vtable',typeName:'ModA.Worker',slot:99}).complete,false);''',
'''u32(0x1418,7);const associated=await buildSwiftMetadataModel(read,sections,opts);assert.equal(associated.completeness.witnessTables.complete,false);assert.equal(resolveSwiftDispatch(buildSwiftRuntimeIndex(associated),{kind:'witness',typeName:'ModA.Worker',protocolName:'ModA.Damageable',slot:0}).resolved,null);
u32(0x1418,0x11);const partial=await buildSwiftMetadataModel(read,sections,{...opts,budget:1});assert.equal(partial.complete,false);assert.equal(resolveSwiftDispatch(buildSwiftRuntimeIndex(partial),{kind:'vtable',typeName:'ModA.Worker',slot:99}).complete,false);''')

# Add explicit alignment / absolute-pointer proof checks to ObjC regression.
rep('tests/unlinked-runtime-hardening.test.mjs',
'''const parsed=await parseObjcExtendedMetadata(read,{categoryList:{vmAddr:0x200n,size:8n}},{classes:[{name:'PlayerData',addr:0x2000n}],isExecutableAddress:(a)=>a!==0x3000n});assert.equal(parsed.categories[0].methods[0].imp,null);''',
'''const parsed=await parseObjcExtendedMetadata(read,{categoryList:{vmAddr:0x200n,size:8n}},{classes:[{name:'PlayerData',addr:0x2000n}],resolvePointer:(raw)=>BigInt(raw),isExecutableAddress:(a)=>a!==0x3000n&&a%4n===0n});assert.equal(parsed.categories[0].methods[0].imp,null);''')

# Compact unwind: assert sentinel-derived extent and cancellation remains incomplete.
rep('tests/unlinked-macho-compact-unwind.test.mjs',
'''const good=parseMachO(fixture());assert.equal(good.metadata.compactUnwind.complete,true);assert.equal(good.unwindEntries.length,1);assert.equal(good.functions.some((f)=>f.source==='unwind'),true);''',
'''const good=parseMachO(fixture());assert.equal(good.metadata.compactUnwind.complete,true);assert.equal(good.unwindEntries.length,1);assert.equal(good.unwindEntries[0].end,0x100000500n);assert.equal(good.functions.some((f)=>f.source==='unwind'),true);const aborted=parseMachO(fixture(),{signal:{aborted:true}});assert.equal(aborted.metadata.machoMetadata.complete,false);assert.equal(aborted.functions.some((f)=>f.source==='unwind'),false);''')
