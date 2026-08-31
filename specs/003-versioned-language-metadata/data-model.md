# Data Model: Versioned Language and Runtime Metadata (HEX-C3-03)

## Identity Model

```javascript
/**
 * Language metadata identity object.
 */
interface LanguageMetadataIdentity {
  verdict: 'matched-authoritative' | 'matched-partial' | 'identity-unavailable' | 'identity-mismatch' | 'unsupported' | 'malformed' | 'ambiguous';
  providerId: string;
  providerVersion: string;
  ecosystem: 'go' | 'rust' | 'swift' | 'objc' | 'cxx' | 'generic';
  toolchainVersion?: string | null;
  expected?: string | null;
  observed?: string | null;
  method: string;
  detail?: string | null;
  coverage?: {
    entityIds?: string[];
    recordKinds?: string[];
    addresses?: string[];
    buildIdentities?: string[];
    modules?: string[];
  } | null;
  digest: string;
}
```

## Record Model

```javascript
interface LanguageMetadataRecord {
  kind: 'symbol' | 'type' | 'vtable' | 'conformance' | 'field' | 'method';
  entityId: string;
  name?: string | null;
  address?: string | null;
  sizeBytes?: number | null;
  descriptor?: any;
  providerId: string;
  providerVersion: string;
  buildIdentity?: string | null;
  evidenceIds: string[];
}
```

## Provider Result Model

```javascript
interface LanguageMetadataResult {
  schemaVersion: number;
  contractVersion: string;
  providerId: string;
  providerVersion: string;
  ecosystem: string;
  identity: LanguageMetadataIdentity;
  authoritative: boolean;
  sections: string[];
  counts: {
    symbols?: number;
    types?: number;
    vtables?: number;
    methods?: number;
    conformances?: number;
    fields?: number;
  };
  completeness: {
    present: boolean;
    declared: number;
    scanned: number;
    parsed: number;
    capped: boolean;
    unreadableEntries: number;
    invalidEntries: number;
    complete: boolean;
    reasons?: string[];
  };
  diagnostics: string[];
  status: any;
}
```
