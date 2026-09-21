# Data Model: Decompiler Profile Options

## 1. Profile Configuration Schema

```typescript
type DecompilerProfile = 'fast' | 'deep' | 'balanced';

interface DecompilerProfileSettings {
  readonly decompilerTimeBudgetMs: number;
  readonly phase8TimeBudgetMs: number;
  readonly phase8WorkBudget: number;
  readonly renderProvenanceBudget: {
    readonly maxTransformRecords?: number;
    readonly maxConsumers?: number;
    readonly maxEdges?: number;
  } | null;
}
```

## 2. Default Profile Preset Values

| Field | `'fast'` | `'deep'` (default) |
| :--- | :--- | :--- |
| `decompilerTimeBudgetMs` | `30` | `250` |
| `phase8TimeBudgetMs` | `30` | `120` |
| `phase8WorkBudget` | `10000` | `1000000` |
| `renderProvenanceBudget` | `{ maxTransformRecords: 128, maxConsumers: 256 }` | `null` (unconstrained default) |

## 3. Propagation Model

When `decompile(model, opts)` is called:
1. `opts.profile` is normalized to lowercase string or `'deep'` if omitted or unknown.
2. The resolved preset provides baseline defaults for budget properties.
3. If caller explicitly specifies any budget property in `opts`, the caller's value overrides the preset value.
4. Resolved options flow into `decompileSemantic` and `enhanceSemanticDecompilation`.
