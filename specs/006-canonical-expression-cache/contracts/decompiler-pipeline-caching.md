# Interface Contract: Decompiler Pipeline Consumer Validation Caching

## Module: `js/decompiler/pipeline-core.js`

### Exported Functions
No new public exports are added; the optimization is an internal refinement to `enhanceSemanticDecompilation(result, model, opts)`.

### Internal Function: `consumerSourceMap(advanced)`

```javascript
/**
 * Resolves expression history consumers for each printed mapping entry
 * under an ephemeral synchronous validation batch.
 *
 * @param {Object} advanced
 * @param {Object} advanced.printed - Printed output containing mapping array.
 * @param {Object} advanced.cAst - High-level C AST containing statement body.
 * @param {Object} advanced.ir - Semantic IR function context.
 * @returns {Array<Object>} Updated source mapping array with merged sources.
 */
function consumerSourceMap(advanced)
```

### Preconditions
- `advanced` is an object containing `printed.mapping`, `cAst.body`, and `ir`.
- `createValidationBatch` is imported from `../core/identity/live-data.js`.

### Postconditions
- Returns an array identical in length and structure to `advanced.printed.mapping.map(...)`.
- If any observed consumer mutates prior to `settle()`, the returned array is computed by fresh un-memoized execution.
- No cached state or validation authority survives return of `consumerSourceMap()`.
