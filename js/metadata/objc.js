import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
} from './provider.js';
import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from '../objc.js';

export const OBJC_PROVIDER_ID = 'metadata.objc';
export const OBJC_PROVIDER_VERSION = '1.0.0';

export class ObjcMetadataProvider extends LanguageMetadataProvider {
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
    const sectionList = Array.isArray(this.sections) ? this.sections : Object.values(this.sections || {});
    const objcSections = sectionList.filter((s) => {
      const name = s.section || s.name || s.sectname || '';
      return name.includes('objc_') || name.includes('__OBJC');
    });

    const classList = sectionList.find((s) => (s.section || s.name || s.sectname || '').includes('objc_classlist'));

    if (!objcSections.length || !classList || typeof this.readAt !== 'function') {
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
        sections: objcSections.map((s) => s.section || s.name || String(s)),
        completeness: { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    const runtimeSections = {
      sections: this.sections,
      architecture: this.architecture,
      ...(this.options.runtimeSections || {}),
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
    if (!model) {
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
          detail: 'objc metadata could not be parsed',
        }),
        sections: objcSections.map((s) => s.section || s.name || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false },
      });
    }

    this.cachedModel = model;
    this.cachedIndex = buildObjcRuntimeIndex(model);

    const isComplete = model.runtimeCompleteness?.complete === true;
    const identity = createLanguageMetadataIdentity({
      verdict: isComplete ? 'matched-authoritative' : 'matched-partial',
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
      detail: `Objective-C 2.0 (${model.classes?.length || 0} classes, ${model.protocols?.length || 0} protocols)`,
      coverage: isComplete ? null : {
        recordKinds: ['type', 'method'],
        addresses: (model.classes || []).map((c) => `0x${c.address?.toString(16)}`).filter(Boolean),
      },
    });

    const totalMethods = (model.classes || []).reduce((acc, c) => acc + (c.methods?.length || 0) + (c.classMethods?.length || 0), 0);
    const counts = {
      types: model.classes?.length || 0,
      protocols: model.protocols?.length || 0,
      methods: totalMethods,
    };

    return createLanguageMetadataResult({
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'objc',
      identity,
      sections: objcSections.map((s) => s.section || s.name || String(s)),
      counts,
      completeness: {
        present: true,
        declared: (model.classes?.length || 0) + (model.protocols?.length || 0),
        scanned: (model.classes?.length || 0) + (model.protocols?.length || 0),
        parsed: (model.classes?.length || 0) + (model.protocols?.length || 0),
        complete: isComplete,
        unreadableEntries: model.completeness?.unreadableEntries || 0,
        invalidEntries: model.completeness?.invalidEntries || 0,
      },
    });
  }

  types() {
    const model = this.cachedModel;
    if (!model || !model.classes) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const cls of model.classes) {
      const addrStr = cls.address != null ? `0x${cls.address.toString(16)}` : null;
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
    for (const cls of model.classes) {
      const allMethods = [...(cls.methods || []), ...(cls.classMethods || [])];
      for (const m of allMethods) {
        const addrStr = m.addr != null || m.imp != null ? `0x${(m.addr || m.imp).toString(16)}` : null;
        records.push(
          createLanguageMetadataRecord({
            kind: 'method',
            entityId: `method@${cls.name}:${m.sel}`,
            name: m.name || `${m.classMethod ? '+' : '-'}[${cls.name} ${m.sel}]`,
            address: addrStr,
            providerId: this.id,
            providerVersion: this.version,
            ecosystem: 'objc',
            buildIdentity: this.binaryIdentity,
            descriptor: {
              selector: m.sel || m.selector,
              className: cls.name,
              classMethod: !!m.classMethod,
              types: m.types || null,
              implementationProven: m.implementationProven === true,
            },
          })
      );
      }
    }

    return createLanguageMetadataPage({ records });
  }
}
