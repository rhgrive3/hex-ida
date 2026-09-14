import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
} from './provider.js';
import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from '../objc.js';

export const OBJC_PROVIDER_ID = 'metadata.objc';
export const OBJC_PROVIDER_VERSION = '1.1.1';

function sectionName(section) {
  for (const key of ['section', 'name', 'sectname']) {
    if (typeof section?.[key] === 'string' && section[key]) return section[key];
  }
  return '';
}

// Adapt the public BinaryImage range, without guessing or coercing a pointer.
function sectionRange(section) {
  if (!section) return null;
  return { ...section, vmAddr: section.vmAddr ?? section.address ?? section.addr };
}

export class ObjcMetadataProvider extends LanguageMetadataProvider {
  #probeGeneration = 0;
  constructor({
    readAt = null,
    sections = [],
    binaryIdentity = null,
    architecture = 'arm64',
    platform = 'darwin',
    options = {},
  } = {}) {
    super({ id: OBJC_PROVIDER_ID, version: OBJC_PROVIDER_VERSION, ecosystem: 'objc' });
    this.readAt = readAt;
    this.sections = sections;
    this.binaryIdentity = binaryIdentity;
    this.architecture = architecture;
    this.platform = platform;
    this.options = options;
    this.cachedModel = null;
    this.cachedIndex = null;
  }

  async probe() {
    const generation = ++this.#probeGeneration;
    // An absent, aborted or superseded scan must not publish previous records.
    this.cachedModel = null;
    this.cachedIndex = null;
    if (this.sections != null && !Array.isArray(this.sections) && typeof this.sections !== 'object') {
      throw new TypeError('metadata-objc-sections-must-be-array-or-object');
    }
    const sectionList = Array.isArray(this.sections) ? this.sections : Object.values(this.sections || {});
    const objcSections = sectionList.filter((s) => {
      const name = sectionName(s);
      return name.includes('objc_') || name.includes('__OBJC');
    });
    const tables = Object.fromEntries(['classList', 'categoryList', 'protocolList'].map((key, i) => {
      const name = ['__objc_classlist', '__objc_catlist', '__objc_protolist'][i];
      return [key, sectionList.filter(s => sectionName(s) === name).map(sectionRange)];
    }));
    const classList = tables.classList[0];
    const incomplete = (reason) => createLanguageMetadataResult({
      providerId: this.id, providerVersion: this.version, ecosystem: 'objc',
      identity: createLanguageMetadataIdentity({
        verdict: 'matched-partial', providerId: this.id, providerVersion: this.version,
        ecosystem: 'objc', binaryIdentity: this.binaryIdentity, architecture: this.architecture,
        platform: this.platform, method: 'objc-section-probe', detail: reason,
      }),
      sections: objcSections.map(sectionName),
      completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: [reason] },
      diagnostics: [reason],
    });

    if (!objcSections.length) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'objc',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'objc',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'objc-section-probe',
          detail: 'no objc metadata sections found',
        }),
        sections: [],
        completeness: { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    if (typeof this.readAt !== 'function') {
      const reason = 'objc metadata sections found but no reader is available';
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'objc',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'objc',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'objc-section-probe',
          detail: reason,
        }),
        sections: objcSections.map(sectionName),
        completeness: {
          present: true,
          declared: 0,
          scanned: 0,
          parsed: 0,
          complete: false,
          reasons: [reason],
        },
        diagnostics: [reason],
      });
    }

    if (!classList && !tables.categoryList.length && !tables.protocolList.length) {
      const reason = 'objc metadata sections found but objc_classlist section is missing';
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'objc',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'objc',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'objc-section-probe',
          detail: reason,
        }),
        sections: objcSections.map(sectionName),
        completeness: {
          present: true,
          declared: 0,
          scanned: 0,
          parsed: 0,
          complete: false,
          reasons: [reason],
        },
        diagnostics: [reason],
      });
    }

    for (const [kind, ranges] of Object.entries(tables)) {
      // The existing owner accepts one table per kind. Never silently discard
      // another declaration and then call that incomplete universe complete.
      if (ranges.length > 1) return incomplete(`objc-multiple-${kind}-sections`);
    }
    for (const [kind, ranges] of Object.entries(tables)) {
      const range = ranges[0];
      if (!range) continue;
      const address = range.vmAddr;
      const addressValid = (typeof address === 'bigint' && address >= 0n)
        || (typeof address === 'number' && Number.isSafeInteger(address) && address >= 0);
      const size = range.size;
      const sizeValid = (typeof size === 'bigint' && size >= 0n && size <= BigInt(Number.MAX_SAFE_INTEGER))
        || (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0);
      if (!addressValid || !sizeValid) return incomplete(`objc-${kind}-range-invalid`);
      range.vmAddr = BigInt(address);
    }
    const runtimeSections = {
      sections: this.sections,
      architecture: this.architecture,
      ...(this.options.runtimeSections || {}),
      // Actual loaded sections outrank optional hints, including null hints.
      categoryList: tables.categoryList[0] ?? this.options.runtimeSections?.categoryList,
      protocolList: tables.protocolList[0] ?? this.options.runtimeSections?.protocolList,
    };

    const model = await buildObjcRuntimeModel(
      this.readAt,
      classList,
      runtimeSections,
      this.options.onProgress,
      this.options.imageBase ?? 0n,
      this.options.pointerFormat,
      this.options
    );
    if (!model || this.options.signal?.aborted || generation !== this.#probeGeneration) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'objc',
        identity: createLanguageMetadataIdentity({
          verdict: 'malformed',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'objc',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'objc-metadata-parse',
          detail: 'objc metadata could not be parsed, was cancelled, or was superseded',
        }),
        sections: objcSections.map(sectionName),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false },
      });
    }

    this.cachedModel = model;
    this.cachedIndex = buildObjcRuntimeIndex(model);

    const isComplete = model.runtimeCompleteness?.complete === true;
    const coverage = ['classes', 'categories', 'protocols'].map(kind => ({ kind, ...model.runtimeCompleteness?.[kind] }));
    const sum = key => coverage.reduce((total, item) => total + (Number.isSafeInteger(item[key]) && item[key] >= 0 ? item[key] : 0), 0);
    const reasons = coverage.filter(item => item.complete !== true)
      .flatMap(item => [`objc-${item.kind}-metadata-incomplete`, ...(item.reasons || [])]);
    const coveredEntityIds = isComplete
      ? []
      : [...this.types().records, ...this.methods().records].map((record) => record.entityId);
    const hasIdentityBinding = this.binaryIdentity != null;
    // A pointer ABI the provider cannot decode is reported as an explicit
    // reason instead of arriving as an unexplained empty metadata set (#8280).
    const pointerAbiReason = model.pointerAbiReason
      ?? [
        ...(model.runtimeCompleteness?.classes?.reasons ?? []),
        ...(model.completeness?.protocols?.reasons ?? []),
      ].find((reason) => typeof reason === 'string' && reason.startsWith('objc-pointer-abi'))
      ?? null;
    const identity = createLanguageMetadataIdentity({
      verdict: isComplete
        ? (hasIdentityBinding ? 'matched-authoritative' : 'identity-unavailable')
        : 'matched-partial',
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'objc',
      toolchainVersion: 'objc-2.0',
      binaryIdentity: this.binaryIdentity,
      expected: this.binaryIdentity,
      observed: this.binaryIdentity,
      architecture: this.architecture,
      platform: this.platform,
      method: 'objc-2.0-runtime',
      detail: hasIdentityBinding
        ? `Objective-C 2.0 (${model.classes?.length || 0} classes, ${model.categories?.length || 0} categories, ${model.protocols?.length || 0} protocols)`
        : `Objective-C 2.0 without binary identity binding (${model.classes?.length || 0} classes, ${model.categories?.length || 0} categories, ${model.protocols?.length || 0} protocols)`,
      coverage: isComplete ? null : {
        recordKinds: ['type', 'method'],
        entityIds: coveredEntityIds,
      },
    });

    const totalMethods = [...(model.classes || []), ...(model.categories || [])]
      .reduce((acc, c) => acc + (c.methods?.length || 0) + (c.classMethods?.length || 0), 0);
    const counts = {
      types: model.classes?.length || 0,
      protocols: model.protocols?.length || 0,
      categories: model.categories?.length || 0,
      methods: totalMethods,
    };

    return createLanguageMetadataResult({
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'objc',
      identity,
      sections: objcSections.map(sectionName),
      counts,
      completeness: {
        present: true,
        declared: sum('declared'),
        scanned: sum('scanned'),
        parsed: sum('parsed'),
        capped: coverage.some(item => item.capped === true),
        complete: isComplete,
        unreadableEntries: sum('unreadableSlots'),
        invalidEntries: sum('invalidEntries'),
        reasons: [...new Set([...reasons, ...(pointerAbiReason ? [pointerAbiReason] : [])])],
        ...(pointerAbiReason ? { pointerAbi: pointerAbiReason } : {}),
      },
      diagnostics: [...new Set([...reasons, ...(pointerAbiReason ? [pointerAbiReason] : [])])],
    });
  }

  types() {
    const model = this.cachedModel;
    if (!model || !model.classes) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const cls of model.classes) {
      const address = cls.address ?? cls.addr;
      const addrStr = address != null ? `0x${address.toString(16)}` : null;
      records.push(
        createLanguageMetadataRecord({
          kind: 'type',
          entityId: `type@${addrStr || cls.name}`,
          name: cls.name,
          address: addrStr,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'objc',
          buildIdentity: this.binaryIdentity,
          descriptor: {
            layer: 'nominal',
            name: cls.name,
            superName: cls.superName || null,
            protocols: cls.protocols || [],
            ivars: (cls.ivars || []).map((iv) => ({
              name: iv.name,
              offset: iv.offset,
              type: iv.type,
            })),
          },
        })
      );
    }

    return createLanguageMetadataPage({ records });
  }

  methods() {
    const model = this.cachedModel;
    if (!model || !model.classes) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const cls of [...model.classes, ...(model.categories || [])]) {
      const category = cls.kind === 'category' ? cls : null;
      const owner = category ? (category.className || '<unknown>') : cls.name;
      const categorySuffix = category ? `(${category.name})@${category.address?.toString(16) ?? 'unknown'}` : '';
      const emitMethod = (m, isClassMethod) => {
        const methodAddress = m.addr ?? m.imp;
        const addrStr = methodAddress != null ? `0x${methodAddress.toString(16)}` : null;
        const selector = m.sel || m.selector;
        const classMethod = isClassMethod || m.kind === '+' || m.classMethod === true;
        records.push(
          createLanguageMetadataRecord({
            kind: 'method',
            entityId: `method@${owner}${categorySuffix}:${classMethod ? '+' : '-'}:${selector}`,
            name: m.name || `${classMethod ? '+' : '-'}[${owner}${category ? `(${category.name})` : ''} ${selector}]`,
            address: addrStr,
            providerId: this.id,
            providerVersion: this.version,
            ecosystem: 'objc',
            buildIdentity: this.binaryIdentity,
            descriptor: {
              selector,
              className: owner,
              ...(category ? { categoryName: category.name, source: 'category' } : {}),
              classMethod,
              types: m.types || null,
              implementationProven: m.implementationProven === true,
            },
          })
        );
      };
      for (const m of cls.methods || []) {
        emitMethod(m, false);
      }
      for (const m of cls.classMethods || []) {
        emitMethod(m, true);
      }
    }

    return createLanguageMetadataPage({ records });
  }
}
