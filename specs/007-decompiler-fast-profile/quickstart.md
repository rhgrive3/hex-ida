# Quickstart: Using the Decompiler Fast Profile

## In JavaScript / TypeScript Code

```javascript
import { decompile } from './js/decompile.js';

// Standard decompile (deep analysis, default)
const thoroughResult = decompile(model);

// Fast decompile for interactive game binary reverse engineering (sub-2s)
const fastResult = decompile(model, { profile: 'fast' });

console.log(fastResult.pseudocode);
```

## Overriding Specific Budgets while using Fast Profile

```javascript
// Use fast profile defaults, but allow up to 50ms for pass iterations
const customResult = decompile(model, {
  profile: 'fast',
  decompilerTimeBudgetMs: 50,
});
```
