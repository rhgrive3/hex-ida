function unsupported(from, detail) {
  throw new Error(`Unsupported importScripts() in ${from}: ${detail}; only plain string-literal arguments are supported`);
}

export function parseImportScriptsArguments(args, from = '<worker>') {
  const source = String(args ?? '');
  const out = [];
  let index = 0;

  const skipWhitespace = () => {
    while (index < source.length && /\s/u.test(source[index])) index += 1;
  };

  skipWhitespace();
  if (index === source.length) return out;

  while (index < source.length) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"') unsupported(from, `argument ${out.length + 1} is not a string literal`);
    index += 1;
    let value = '';
    let closed = false;
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) {
        closed = true;
        break;
      }
      if (char === '\\') unsupported(from, `argument ${out.length + 1} uses an escaped string literal`);
      if (char === '\n' || char === '\r') unsupported(from, `argument ${out.length + 1} contains a line break`);
      value += char;
    }
    if (!closed) unsupported(from, `argument ${out.length + 1} has an unterminated string literal`);
    if (!value) unsupported(from, `argument ${out.length + 1} is an empty dependency path`);
    out.push(value);

    skipWhitespace();
    if (index === source.length) break;
    if (source[index] !== ',') unsupported(from, `argument ${out.length} is followed by a non-comma expression`);
    index += 1;
    skipWhitespace();
    if (index === source.length) break;
  }

  return out;
}
