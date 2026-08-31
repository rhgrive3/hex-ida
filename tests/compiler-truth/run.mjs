// Keep compiler-truth diagnostics serializable when a semantic counterexample contains BigInt values.
if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', { value() { return this.toString(); }, configurable: true });
}
// Compiler-truth proof output must be a function of the input, not of the host's
// speed. The production rewrite engine keeps a wall-clock valve for interactive
// budgets, so every decompile call in these suites has to opt into
// `deterministicTransforms: true`. This gate fails the suite if a future call
// drops that flag and reintroduces machine-speed-dependent expectations.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const files = ['run-core.mjs', 'extended.mjs', 'language-matrix.mjs'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    let index = source.indexOf('decompile(');
    let calls = 0;
    let flagged = 0;
    while (index >= 0) {
      calls++;
      let depth = 0;
      let end = index + 'decompile('.length - 1;
      for (; end < source.length; end++) {
        const ch = source[end];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
      }
      const args = source.slice(index + 'decompile('.length, end);
      if (/deterministicTransforms\s*:\s*true/.test(args)) flagged++;
      index = source.indexOf('decompile(', end + 1);
    }
    if (calls !== flagged || calls === 0) {
      throw new Error(`compiler-truth determinism contract violated in ${file}: ${flagged}/${calls} decompile calls pass deterministicTransforms:true`);
    }
  }
}
await import('./run-core.mjs');
await import('./extended.mjs');
await import('./language-matrix.mjs');
