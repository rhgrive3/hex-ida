import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDeterministicDecompilerOptions } from './deterministic-decompile.mjs';

// Keep compiler-truth diagnostics serializable when a semantic counterexample contains BigInt values.
if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', { value() { return this.toString(); }, configurable: true });
}

// Exercise the evaluated-value boundary directly. JavaScript has already
// applied duplicate properties and spreads by this point, so these cases cannot
// evade the gate through source syntax.
{
  assert.doesNotThrow(() => assertDeterministicDecompilerOptions({ deterministicTransforms: true }));
  for (const invalid of [
    null,
    {},
    { deterministicTransforms: false },
    { deterministicTransforms: 1 },
    { deterministicTransforms: 'true' },
  ]) {
    assert.throws(() => assertDeterministicDecompilerOptions(invalid),
      /require deterministicTransforms:true/);
  }

  const defaults = { deterministicTransforms: false };
  assert.throws(
    () => assertDeterministicDecompilerOptions({
      deterministicTransforms: true,
      deterministicTransforms: false,
    }),
    /require deterministicTransforms:true/,
    'a later duplicate property must not override the deterministic proof flag',
  );
  assert.throws(
    () => assertDeterministicDecompilerOptions({ deterministicTransforms: true, ...defaults }),
    /require deterministicTransforms:true/,
    'a later spread must not override the deterministic proof flag',
  );
  assert.doesNotThrow(
    () => assertDeterministicDecompilerOptions({ ...defaults, deterministicTransforms: true }),
    'a final explicit true value must remain accepted',
  );
}

// Every compiler-truth suite must bind `decompile` to the guarded call boundary.
// This small import check prevents a future direct product import from silently
// bypassing the runtime assertion without attempting to parse call expressions.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ['run-core.mjs', 'extended.mjs', 'language-matrix.mjs']) {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    assert.match(source,
      /import\s*\{\s*decompile\s*\}\s*from\s*['"]\.\/deterministic-decompile\.mjs['"]/,
      `${file} must use the deterministic compiler-truth decompile boundary`);
    assert.doesNotMatch(source, /from\s*['"][^'"]*js\/decompile\.js['"]/,
      `${file} must not import the product decompiler directly`);
  }
}

await import('./run-core.mjs');
await import('./extended.mjs');
await import('./language-matrix.mjs');
