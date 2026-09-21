# Contract: Decompiler Profile Resolution

## 1. Resolution Signature

```javascript
export function resolveDecompilerProfile(profileName) { ... }
```

## 2. Invariants

- **INV-001 (Default Equivalence)**: Calling `resolveDecompilerProfile(undefined)` or `resolveDecompilerProfile('deep')` returns default values identical to existing production behavior (`decompilerTimeBudgetMs: 250`, `phase8TimeBudgetMs: 120`, `phase8WorkBudget: 1000000`, `renderProvenanceBudget: null`).
- **INV-002 (Fast Profile Boundedness)**: Calling `resolveDecompilerProfile('fast')` returns bounded values (`decompilerTimeBudgetMs <= 30`, `phase8TimeBudgetMs <= 30`, `phase8WorkBudget <= 10000`).
- **INV-003 (Graceful Fallback)**: Unrecognized profile strings (e.g. `'invalid'`, null, numbers) gracefully fall back to the default profile without throwing.
- **INV-004 (Explicit Override Precedence)**: If a caller explicitly provides `opts.decompilerTimeBudgetMs`, it MUST override the profile preset value.
