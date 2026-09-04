# Data Model: Apple Knowledge Result v1

```javascript
interface AppleKnowledgeResult {
  schema: 'hex-apple-knowledge/v1';
  matrixVersion: '2026.09';
  formatMatrix: object;
  provider: { id: 'apple.knowledge'; version: string };
  identity: {
    binaryIdentity: string | null;
    sliceIdentity: string | null;
    architecture: string | null;
    platform: 'apple';
    authoritative: boolean;
  };
  cells: {
    dyldCache: AppleKnowledgeCell;
    chainedFixups: AppleKnowledgeCell;
    swift: AppleKnowledgeCell;
    objc: AppleKnowledgeCell;
    pointerAuthentication: AppleKnowledgeCell;
    codeSigning: AppleKnowledgeCell;
  };
  complete: boolean;
  reasons: string[];
}

interface AppleKnowledgeCell {
  status: 'absent' | 'supported' | 'partial' | 'unsupported' | 'malformed' | 'ambiguous' | 'unknown';
  version: string | number | null;
  complete: boolean;
  reasons: string[];
  evidence: object;
}

interface ChainedPointerSite {
  address: bigint;
  fileOffset: bigint;       // container-relative
  sliceFileOffset: bigint;  // selected-slice-relative
  raw: bigint;
  pointerFormat: number;
  semantics: 'bind' | 'rebase';
  ordinal: number | null;
  addend: bigint;
  target: bigint | null;
  next: number;
  stride: number;
  storageWidth: 4 | 8;
  ambiguous: boolean;
  candidateIndex: number;
  candidateCount: number;
  authenticated: boolean;
  authentication: null | {
    key: 'IA' | 'IB' | 'DA' | 'DB';
    diversity: number;
    addressDiversity: boolean;
  };
}

interface AppleCodeSignatureStructure {
  status: 'absent' | 'structurally-valid' | 'malformed' | 'unsupported';
  commandOffset: number | null;
  dataOffset: number | null;
  dataSize: number;
  blobs: Array<{ type: number; offset: number; magic: number; length: number }>;
  codeDirectories: Array<object>;
  validity: 'unknown';
  authoritativeValidation: null;
}
```

CodeDirectory rows retain `codeLimit32`, `codeLimit64`, and the effective `codeLimit`; a nonzero `codeLimit64` is authoritative for versions at or above `0x20300`.

An in-memory `complete` cell is accepted only from the private issuance record of the canonical Mach-O/cache/language producer and an exact binary/slice/architecture binding. Language providers are constructed inside the Apple module from the parser-owned section/mapping snapshot and canonical resident-byte reader, then executed through immutable lexical provider implementations; caller providers, replaced prototypes/instance methods/subclasses, proxy results, copied or mutated section arrays, and missing/custom readers cannot prove presence or absence. Resident Mach-O and dyld-cache identities are derived from the bytes; sparse reads without whole-source identity, caller labels, clones, and serialized shapes cannot create completeness. A CodeDirectory also retains its validated hash type/width, page-size exponent, and version-dependent offsets; exponent zero means one infinite code page for nonempty code.

All address-like and file-offset fields remain exact integers internally. JSON serialization tags BigInt values explicitly, rejects unrecognized tags/schema/cell authority, and marks every serialized cell `unknown`/incomplete until source bytes and providers are rerun.
