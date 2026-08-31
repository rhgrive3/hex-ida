/**
 * HEX-C3-03 — Unified Language & Runtime Metadata Module.
 *
 * Central registry, dispatch, and aggregation for Go, Rust, Swift, and Objective-C
 * metadata providers.
 */

import {
  METADATA_PROVIDER_CONTRACT_VERSION,
  METADATA_PROVIDER_SCHEMA_VERSION,
  METADATA_IDENTITY_VERDICTS,
  METADATA_RECORD_KINDS,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  LanguageMetadataProvider,
  isAuthoritative,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
} from './provider.js';

import { GoMetadataProvider, GO_PROVIDER_ID, GO_PCLNTAB_MAGICS } from './go.js';
import { RustMetadataProvider, RUST_PROVIDER_ID, demangleRustSymbol, isRustLayoutStable } from './rust.js';
import { SwiftMetadataProvider, SWIFT_PROVIDER_ID } from './swift.js';
import { ObjcMetadataProvider, OBJC_PROVIDER_ID } from './objc.js';

export {
  METADATA_PROVIDER_CONTRACT_VERSION,
  METADATA_PROVIDER_SCHEMA_VERSION,
  METADATA_IDENTITY_VERDICTS,
  METADATA_RECORD_KINDS,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  LanguageMetadataProvider,
  isAuthoritative,
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
  GoMetadataProvider,
  GO_PROVIDER_ID,
  GO_PCLNTAB_MAGICS,
  RustMetadataProvider,
  RUST_PROVIDER_ID,
  demangleRustSymbol,
  isRustLayoutStable,
  SwiftMetadataProvider,
  SWIFT_PROVIDER_ID,
  ObjcMetadataProvider,
  OBJC_PROVIDER_ID,
};

/**
 * Universal runtime call classifier spanning Go, Rust, Swift, and ObjC.
 */
export function classifyLanguageRuntimeCall(name) {
  const symbol = typeof name === 'string' ? name : '';
  if (!symbol) return null;

  // ObjC
  if (/^[+-]\[/.test(symbol) || /^_?objc_/.test(symbol) || /objc_msgSend/.test(symbol)) {
    const noise = /^_?objc_(retain|release|autorelease|storeStrong|loadWeak|destroyWeak)\b/.test(symbol);
    return { runtime: 'objc', noise, category: 'runtime', name: symbol };
  }

  // Swift
  if (/^_?\$[sS]/.test(symbol) || /^_?swift_/.test(symbol)) {
    const noise = /^_?swift_(retain|release|bridgeObjectRetain|bridgeObjectRelease)\b/.test(symbol);
    return { runtime: 'swift', noise, category: 'runtime', name: symbol };
  }

  // Go
  if (/^runtime\./.test(symbol) || /^go:/.test(symbol)) {
    const noise = /^runtime\.(morestack|gcWriteBarrier|newobject|mallocgc|panicIndex|slicebytetostring)\b/.test(symbol);
    return { runtime: 'go', noise, category: 'runtime', name: symbol };
  }

  // Rust
  if (/^core::/.test(symbol) || /^alloc::/.test(symbol) || /^std::/.test(symbol) || /^_?rust_/.test(symbol)) {
    const noise = /_rust_alloc|_rust_dealloc|core::panicking|alloc::raw_vec/.test(symbol);
    return { runtime: 'rust', noise, category: 'runtime', name: symbol };
  }

  return null;
}

/**
 * Parses and aggregates language metadata across all detected ecosystems.
 */
export async function parseUnifiedLanguageMetadata(context = {}, options = {}) {
  const providers = [];

  // 1. Go
  if (context.pclntabBuffer || (context.sections || []).some((s) => (s.name || s.section || '').includes('gopclntab'))) {
    providers.push(new GoMetadataProvider({
      pclntabBuffer: context.pclntabBuffer,
      rodataBuffer: context.rodataBuffer,
      sections: context.sections || [],
      binaryIdentity: context.binaryIdentity,
      architecture: context.architecture,
      platform: context.platform,
      options,
    }));
  }

  // 2. Rust
  if ((context.symbols || []).some((s) => (s.name || s.symbol || '').startsWith('_R') || (s.name || s.symbol || '').startsWith('_ZN')) || context.commentBuffer) {
    providers.push(new RustMetadataProvider({
      symbols: context.symbols || [],
      commentBuffer: context.commentBuffer,
      sections: context.sections || [],
      binaryIdentity: context.binaryIdentity,
      architecture: context.architecture,
      platform: context.platform,
      options,
    }));
  }

  // 3. Swift
  if ((context.sections || []).some((s) => (s.name || s.section || '').includes('swift5') || (s.name || s.section || '').includes('sw5'))) {
    providers.push(new SwiftMetadataProvider({
      readAt: context.readAt,
      sections: context.sections || [],
      binaryIdentity: context.binaryIdentity,
      architecture: context.architecture,
      platform: context.platform,
      options,
    }));
  }

  // 4. ObjC
  if ((context.sections || []).some((s) => (s.name || s.section || '').includes('objc_') || (s.name || s.section || '').includes('__OBJC'))) {
    providers.push(new ObjcMetadataProvider({
      readAt: context.readAt,
      sections: context.sections || [],
      binaryIdentity: context.binaryIdentity,
      architecture: context.architecture,
      platform: context.platform,
      options,
    }));
  }

  const results = [];
  for (const provider of providers) {
    try {
      const probeResult = await provider.probe();
      results.push({
        ecosystem: provider.ecosystem,
        provider,
        result: probeResult,
      });
    } catch (err) {
      results.push({
        ecosystem: provider.ecosystem,
        provider,
        result: createLanguageMetadataResult({
          providerId: provider.id,
          providerVersion: provider.version,
          ecosystem: provider.ecosystem,
          identity: createLanguageMetadataIdentity({
            verdict: 'malformed',
            providerId: provider.id,
            providerVersion: provider.version,
            ecosystem: provider.ecosystem,
            method: 'provider-probe',
            detail: String(err?.message || err),
          }),
          completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: [String(err?.message || err)] },
        }),
      });
    }
  }

  return {
    results,
    ecosystems: results.map((r) => r.ecosystem),
    authoritative: results.some((r) => r.result.authoritative),
    complete: results.length > 0 && results.every((r) => r.result.completeness?.complete === true),
  };
}
