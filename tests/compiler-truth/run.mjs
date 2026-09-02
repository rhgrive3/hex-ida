// Keep compiler-truth diagnostics serializable when a semantic counterexample contains BigInt values.
if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', { value() { return this.toString(); }, configurable: true });
}

function lexicalCodeMask(source) {
  const text = String(source);
  const out = text.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      blank(start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw new Error('compiler-truth unterminated block comment');
      i += 2;
      blank(start, i);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i++;
      let escaped = false;
      while (i < text.length) {
        const current = text[i++];
        if (escaped) { escaped = false; continue; }
        if (current === '\\') { escaped = true; continue; }
        if (current === quote) break;
      }
      if (text[i - 1] !== quote) throw new Error('compiler-truth unterminated literal');
      blank(start, i);
      continue;
    }
    i++;
  }
  return out.join('');
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === ',' && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
    if (paren < 0 || brace < 0 || bracket < 0) return [];
  }
  if (paren !== 0 || brace !== 0 || bracket !== 0) return [];
  parts.push(source.slice(start));
  return parts;
}

function topLevelDeterministicOption(args) {
  const callArgs = splitTopLevel(args);
  if (callArgs.length < 2) return false;
  const options = callArgs[1].trim();
  if (!options.startsWith('{') || !options.endsWith('}')) return false;
  const properties = splitTopLevel(options.slice(1, -1));
  return properties.some((property) => /^\s*deterministicTransforms\s*:\s*true\s*$/.test(property));
}

function deterministicDecompileCalls(source, label) {
  const code = lexicalCodeMask(source);
  const callPattern = /\bdecompile\s*\(/g;
  let match;
  let calls = 0;
  let flagged = 0;
  while ((match = callPattern.exec(code)) != null) {
    calls++;
    const open = code.indexOf('(', match.index);
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`compiler-truth malformed decompile call in ${label}`);
    const args = code.slice(open + 1, end);
    if (topLevelDeterministicOption(args)) flagged++;
    callPattern.lastIndex = end + 1;
  }
  return { calls, flagged };
}

// The determinism gate itself must not accept proof text from comments/literals
// or a deterministicTransforms property outside the top-level second argument.
{
  const probe = [
    '// decompile(model, { deterministicTransforms: true })',
    'const s = "decompile(model, { deterministicTransforms: true })";',
    'const t = `decompile(model, { deterministicTransforms: true })`;',
    'decompile (model, { deterministicTransforms: true });',
  ].join('\n');
  const checked = deterministicDecompileCalls(probe, '<scanner-self-test>');
  if (checked.calls !== 1 || checked.flagged !== 1) throw new Error('compiler-truth determinism scanner literal/comment regression');
  const fakeFlag = deterministicDecompileCalls('decompile(model, { note: "deterministicTransforms: true" })', '<scanner-self-test>');
  if (fakeFlag.calls !== 1 || fakeFlag.flagged !== 0) throw new Error('compiler-truth determinism scanner fake-flag regression');
  const nestedFlag = deterministicDecompileCalls('decompile(model, { metadata: { deterministicTransforms: true } })', '<scanner-self-test>');
  if (nestedFlag.calls !== 1 || nestedFlag.flagged !== 0) throw new Error('compiler-truth determinism scanner nested-flag regression');
  const thirdArgFlag = deterministicDecompileCalls('decompile(model, {}, { deterministicTransforms: true })', '<scanner-self-test>');
  if (thirdArgFlag.calls !== 1 || thirdArgFlag.flagged !== 0) throw new Error('compiler-truth determinism scanner third-argument regression');
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
    const { calls, flagged } = deterministicDecompileCalls(source, file);
    if (calls !== flagged || calls === 0) {
      throw new Error(`compiler-truth determinism contract violated in ${file}: ${flagged}/${calls} decompile calls pass deterministicTransforms:true`);
    }
  }
}
await import('./run-core.mjs');
await import('./extended.mjs');
await import('./language-matrix.mjs');
