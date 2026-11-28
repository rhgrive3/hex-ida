import { BinaryImage } from '../binary/model.js';

const WASM_SECTION_NAMES = Object.freeze({
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'datacount',
});

const WASM_ENTITY_KINDS = Object.freeze({
  0: 'function',
  1: 'table',
  2: 'memory',
  3: 'global',
});

function populateWasmImage(image, managedImage) {
  const sections = Array.isArray(managedImage.sections) ? managedImage.sections : [];
  let customIdx = 0;
  const customSections = Array.isArray(managedImage.customSections) ? managedImage.customSections : [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const baseName = WASM_SECTION_NAMES[sec.id] || `section_${sec.id}`;
    const customName = sec.id === 0 ? customSections[customIdx++]?.name : null;
    const name = customName ? `custom.${customName}` : baseName;
    const offset = BigInt(sec.offset ?? 0);
    const size = BigInt(sec.size ?? 0);
    image.addSection({
      name,
      address: offset,
      size,
      fileOffset: offset,
      fileSize: size,
      perms: {
        read: true,
        write: sec.id === 11,
        execute: sec.id === 10,
      },
      type: baseName,
      index: i,
      source: 'wasm',
    });
  }

  const rawImports = Array.isArray(managedImage.imports) ? managedImage.imports : [];
  const rawFunctions = Array.isArray(managedImage.functions) ? managedImage.functions : [];
  const rawCodeBodies = Array.isArray(managedImage.codeBodies) ? managedImage.codeBodies : [];
  const rawExports = Array.isArray(managedImage.exports) ? managedImage.exports : [];

  const libraries = new Set();
  let importedFunctionCount = 0;
  for (let i = 0; i < rawImports.length; i++) {
    const imp = rawImports[i];
    if (imp?.module) libraries.add(imp.module);
    const kindCode = imp?.desc?.kind;
    const isFunc = kindCode === 0;
    const funcIndex = isFunc ? importedFunctionCount++ : null;
    image.imports.push({
      library: imp?.module || '',
      name: imp?.field || '',
      kind: WASM_ENTITY_KINDS[kindCode] || 'unknown',
      funcIndex,
      typeIndex: imp?.desc?.typeIndex ?? null,
      sites: [],
      source: 'wasm-import',
    });
  }
  image.libraries = [...libraries];

  const functionExportNames = new Map();
  for (const exp of rawExports) {
    if (exp?.kind === 0 && !functionExportNames.has(exp.index)) {
      functionExportNames.set(exp.index, exp.name);
    }
  }

  const bodyAddressForFuncIndex = (funcIndex) => {
    if (funcIndex < importedFunctionCount) return null;
    const body = rawCodeBodies[funcIndex - importedFunctionCount];
    return body?.bodyOffset != null ? BigInt(body.bodyOffset) : null;
  };

  for (const exp of rawExports) {
    const address = exp?.kind === 0 ? bodyAddressForFuncIndex(exp.index) : null;
    image.exports.push({
      name: exp?.name || '',
      kind: WASM_ENTITY_KINDS[exp?.kind] || 'unknown',
      index: exp?.index ?? null,
      address,
      source: 'wasm-export',
    });
  }

  for (let i = 0; i < rawFunctions.length; i++) {
    const funcIndex = importedFunctionCount + i;
    const body = rawCodeBodies[i] || null;
    const address = BigInt(body?.bodyOffset ?? 0);
    const size = BigInt(body?.bodySize ?? 0);
    const end = size > 0n ? address + size : null;
    const exportedName = functionExportNames.get(funcIndex) || null;
    const name = exportedName || `func_${funcIndex}`;
    const source = exportedName ? 'export' : 'wasm-code';

    image.functions.push({
      address,
      end,
      size: size > 0n ? size : null,
      name,
      funcIndex,
      typeIndex: rawFunctions[i],
      source,
      exactFunctionStart: true,
      confidence: 1,
      extentConfidence: size > 0n ? 1 : null,
      extentInferred: false,
    });

    image.symbols.push({
      name,
      address,
      size,
      defined: true,
      exported: exportedName != null,
      type: 'function',
      source: exportedName ? 'wasm-export' : 'wasm-code',
    });
  }

  if (managedImage.startFunction != null) {
    const entryAddr = bodyAddressForFuncIndex(managedImage.startFunction);
    if (entryAddr != null) image.entrypoint = entryAddr;
  }
}

function populateDexImage(image, managedImage) {
  const dataSec = managedImage.dataSection;
  if (dataSec && Number(dataSec.size) > 0) {
    const offset = BigInt(dataSec.offset ?? 0);
    const size = BigInt(dataSec.size ?? 0);
    image.addSection({
      name: 'dex.data',
      address: offset,
      size,
      fileOffset: offset,
      fileSize: size,
      perms: { read: true, write: false, execute: true },
      type: 'dex-data',
      index: 0,
      source: 'dex',
    });
  }

  const methods = Array.isArray(managedImage.methods) ? managedImage.methods : [];
  const classes = Array.isArray(managedImage.classes) ? managedImage.classes : [];
  const seenCodeOffsets = new Set();

  for (const cls of classes) {
    const allDefs = [
      ...(Array.isArray(cls?.directMethods) ? cls.directMethods : []),
      ...(Array.isArray(cls?.virtualMethods) ? cls.virtualMethods : []),
    ];
    for (const def of allDefs) {
      const meth = methods[def.methodIdx];
      const name = meth ? `${meth.classType}->${meth.name}` : `method_${def.methodIdx}`;
      const isPublic = ((def.accessFlags || 0) & 0x1) !== 0;
      if (def.codeOff && def.codeOff > 0) {
        const address = BigInt(def.codeOff);
        if (!seenCodeOffsets.has(address)) {
          seenCodeOffsets.add(address);
          image.functions.push({
            address,
            end: null,
            size: null,
            name,
            methodIdx: def.methodIdx,
            source: 'dex-class-data',
            exactFunctionStart: true,
            confidence: 1,
            extentConfidence: null,
            extentInferred: false,
          });
        }
        image.symbols.push({
          name,
          address,
          size: 0n,
          defined: true,
          exported: isPublic,
          type: 'function',
          source: 'dex-class-data',
        });
        if (isPublic) {
          image.exports.push({
            name,
            kind: 'method',
            index: def.methodIdx,
            address,
            source: 'dex-class-data',
          });
        }
      } else {
        image.imports.push({
          library: meth?.classType || cls?.classType || '',
          name: meth?.name || name,
          kind: 'method',
          sites: [],
          source: 'dex-method',
        });
      }
    }
  }
}

export function adaptManagedImage(managedImage, {
  frontendId,
  bytes = null,
  source = null,
  fileSize = null,
} = {}) {
  const id = String(frontendId || '').toLowerCase();
  if (!id) throw new TypeError('managed-adapter-frontend-id-required');
  const rawBytes = bytes instanceof Uint8Array
    ? bytes
    : (managedImage?.rawBytes instanceof Uint8Array ? managedImage.rawBytes : new Uint8Array(0));
  const resolvedFileSize = fileSize != null
    ? BigInt(fileSize)
    : BigInt(rawBytes.byteLength || Number(source?.size ?? 0n));

  const arch = id === 'wasm' ? 'wasm32' : (id === 'dex' ? 'dalvik' : id);
  const bits = id === 'wasm' && (managedImage?.memories || []).some((m) => m?.addressType === 'i64') ? 64 : 32;
  const platform = id === 'wasm' ? 'wasm' : (id === 'dex' ? 'android' : id);

  const image = new BinaryImage(rawBytes, {
    source,
    format: id,
    arch,
    bits,
    endian: 'little',
    platform,
    fileSize: resolvedFileSize,
    metadata: {
      managed: true,
      managedFrontend: id,
      formatVersion: managedImage?.formatVersion ?? null,
      vmSpecEdition: managedImage?.vmSpecEdition ?? null,
      imageId: managedImage?.imageId ?? null,
      moduleId: managedImage?.moduleId ?? null,
      sourceBacked: !!source,
      functionDiscovery: { complete: true },
    },
  });

  image.managedFrontend = id;
  image.managedImage = managedImage;

  if (id === 'wasm') {
    populateWasmImage(image, managedImage);
  } else if (id === 'dex') {
    populateDexImage(image, managedImage);
  }

  image.finalize();
  return image;
}
