/**
 * HEX-C3-03 — Swift Language & Runtime Metadata Provider Adapter.
 *
 * Wraps Swift ABI metadata intelligence (types, fields, protocols, conformances,
 * vtables, witness tables) into the unified LanguageMetadataProvider boundary.
 */

import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
} from './provider.js';
import {
  buildSwiftMetadataModel,
  buildSwiftRuntimeIndex,
  demangleSwiftSymbol,
} from '../swift.js';

export const SWIFT_PROVIDER_ID = 'metadata.swift';
export const SWIFT_PROVIDER_VERSION = '1.0.0';

export class SwiftMetadataProvider extends LanguageMetadataProvider {
  constructor({
    readAt = null,
    sections = [],
    binaryIdentity = null,
    architecture = 'arm64',
    platform = 'darwin',
    options = {},
  } = {}) {
    super({ id: SWIFT_PROVIDER_ID, version: SWIFT_PROVIDER_VERSION, ecosystem: 'swift' });
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
    if (this.sections != null && !Array.isArray(this.sections) && typeof this.sections !== 'object') {
      throw new TypeError('metadata-swift-sections-must-be-array-or-object');
    }
    const sectionList = Array.isArray(this.sections) ? this.sections : Object.values(this.sections || {});
    const swiftSections = sectionList.filter((s) => {
      const name = s.section || s.name || s.sectname || '';
      return name.includes('swift5') || name.includes('sw5');
    });

    if (!swiftSections.length) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'swift',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'swift-section-probe',
          detail: 'no swift metadata sections found',
        }),
        sections: [],
        completeness: { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    if (typeof this.readAt !== 'function') {
      const reason = 'swift metadata sections found but no reader is available';
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'swift',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'swift-section-probe',
          detail: reason,
        }),
        sections: swiftSections.map((s) => s.section || s.name || String(s)),
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

    const model = await buildSwiftMetadataModel(this.readAt, this.sections, this.options);
    if (!model) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'swift',
        identity: createLanguageMetadataIdentity({
          verdict: 'malformed',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'swift-metadata-model',
          detail: 'swift metadata model could not be constructed or was cancelled',
        }),
        sections: swiftSections.map((s) => s.section || s.name || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false },
      });
    }

    this.cachedModel = model;
    this.cachedIndex = buildSwiftRuntimeIndex(model);

    const isComplete = model.complete === true;
    const identity = createLanguageMetadataIdentity({
      verdict: isComplete ? 'matched-authoritative' : 'matched-partial',
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'swift',
      toolchainVersion: 'swift-5.x',
      binaryIdentity: this.binaryIdentity,
      expected: this.binaryIdentity,
      observed: this.binaryIdentity,
      architecture: this.architecture,
      platform: this.platform,
      method: 'swift5-abi',
      detail: `Swift 5 ABI (${model.types?.length || 0} types, ${model.protocols?.length || 0} protocols)`,
      coverage: isComplete ? null : {
        recordKinds: ['type', 'vtable', 'conformance'],
        addresses: (model.types || [])
          .filter((t) => t.address != null)
          .map((t) => `0x${t.address.toString(16)}`),
      },
    });

    const counts = {
      types: model.types?.length || 0,
      protocols: model.protocols?.length || 0,
      conformances: model.conformances?.length || 0,
      vtables: model.vtables?.length || 0,
    };

    return createLanguageMetadataResult({
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'swift',
      identity,
      sections: swiftSections.map((s) => s.section || s.name || String(s)),
      counts,
      completeness: {
        present: true,
        declared: (model.completeness?.types?.declared || 0) + (model.completeness?.protocols?.declared || 0),
        scanned: (model.completeness?.types?.scanned || 0) + (model.completeness?.protocols?.scanned || 0),
        parsed: (model.types?.length || 0) + (model.protocols?.length || 0),
        complete: isComplete,
        unreadableEntries: (model.completeness?.types?.unreadableEntries || 0) + (model.completeness?.protocols?.unreadableEntries || 0),
        invalidEntries: (model.completeness?.types?.invalidEntries || 0) + (model.completeness?.protocols?.invalidEntries || 0),
        reasons: model.warnings || [],
      },
      diagnostics: model.warnings || [],
    });
  }

  types() {
    const model = this.cachedModel;
    if (!model || !model.types) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const type of model.types) {
      const addrStr = type.address != null ? `0x${type.address.toString(16)}` : null;
      records.push(
        createLanguageMetadataRecord({
          kind: 'type',
          entityId: `type@${addrStr || type.name}`,
          name: type.name,
          address: addrStr,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          buildIdentity: this.binaryIdentity,
          descriptor: {
            layer: 'nominal',
            name: type.name,
            kind: type.kind,
            generic: type.generic,
            fields: (type.fields || []).map((f) => ({
              name: f.name,
              mangledType: f.mangledType,
              indirect: f.indirect,
              var: f.var,
            })),
          },
        })
      );
    }

    return createLanguageMetadataPage({ records });
  }

  vtables() {
    const model = this.cachedModel;
    if (!model || !model.vtables) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const vtable of model.vtables) {
      const addrStr = vtable.address != null ? `0x${vtable.address.toString(16)}` : null;
      records.push(
        createLanguageMetadataRecord({
          kind: 'vtable',
          entityId: `vtable@${addrStr || vtable.typeName}`,
          name: vtable.typeName ? `${vtable.typeName}.vtable` : null,
          address: addrStr,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          buildIdentity: this.binaryIdentity,
          descriptor: {
            typeName: vtable.typeName,
            methods: vtable.methods || [],
          },
        })
      );
    }

    return createLanguageMetadataPage({ records });
  }

  conformances() {
    const model = this.cachedModel;
    if (!model || !model.conformances) return createLanguageMetadataPage({ records: [] });

    const records = [];
    for (const conf of model.conformances) {
      const addrStr = conf.address != null ? `0x${conf.address.toString(16)}` : null;
      records.push(
        createLanguageMetadataRecord({
          kind: 'conformance',
          entityId: `conf@${addrStr}`,
          address: addrStr,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'swift',
          buildIdentity: this.binaryIdentity,
          descriptor: {
            protocol: conf.protocol != null ? `0x${conf.protocol.toString(16)}` : null,
            typeRef: conf.typeRef != null ? `0x${conf.typeRef.toString(16)}` : null,
            witnessTable: conf.witnessTable != null ? `0x${conf.witnessTable.toString(16)}` : null,
          },
        })
      );
    }

    return createLanguageMetadataPage({ records });
  }
}

// Capture the lexical implementation during module evaluation. The public
// prototype remains extensible for compatibility, but Apple knowledge issuance
// never dispatches through that mutable surface.
const CANONICAL_SWIFT_PROBE = SwiftMetadataProvider.prototype.probe;
const APPLY_SWIFT_PROBE = Reflect.apply;
const CREATE_SWIFT_CONTEXT = Object.create;

export async function probeCanonicalSwiftMetadata(options = {}) {
  const provider = CREATE_SWIFT_CONTEXT(null);
  provider.id = SWIFT_PROVIDER_ID;
  provider.version = SWIFT_PROVIDER_VERSION;
  provider.ecosystem = 'swift';
  provider.readAt = options.readAt ?? null;
  provider.sections = options.sections ?? [];
  provider.binaryIdentity = options.binaryIdentity ?? null;
  provider.architecture = options.architecture ?? 'arm64';
  provider.platform = options.platform ?? 'darwin';
  provider.options = options.options ?? {};
  provider.cachedModel = null;
  provider.cachedIndex = null;
  return APPLY_SWIFT_PROBE(CANONICAL_SWIFT_PROBE, provider, []);
}
