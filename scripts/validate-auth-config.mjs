import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export const LOCAL_D1_ID = '00000000-0000-0000-0000-000000000000';

// Wrangler reads JSONC, not JSON: comments are part of the configuration
// grammar and trailing commas are accepted. Keep validation on the same
// grammar boundary instead of deleting only full-line comments, which changes
// string contents and rejects valid inline comments.
export function parseJsonc(text) {
  if (typeof text !== 'string') throw new TypeError('Auth configuration must be text.');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let stripped = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
    } else if (char === '/' && next === '/') {
      const start = index;
      while (index + 1 < source.length && source[index + 1] !== '\n' && source[index + 1] !== '\r') index += 1;
      stripped += ' '.repeat(index - start + 1);
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('Invalid JSONC: unterminated block comment.');
      const comment = source.slice(index, end + 2);
      stripped += comment.replace(/[^\r\n]/g, ' ');
      index = end + 1;
    } else {
      stripped += char;
    }
  }
  if (inString || escaped) throw new SyntaxError('Invalid JSONC: unterminated string.');

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index++) {
    const char = stripped[index];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/.test(stripped[lookahead] ?? '')) lookahead += 1;
      if (stripped[lookahead] === '}' || stripped[lookahead] === ']') {
        withoutTrailingCommas += ' ';
        continue;
      }
    }
    withoutTrailingCommas += char;
  }
  return JSON.parse(withoutTrailingCommas);
}

export function validateAuthConfig(config, { local = false } = {}) {
  const binding = config?.d1_databases?.find((item) => item.binding === 'AUTH_DB');
  if (!binding || binding.database_name !== 'hex-auth' || binding.migrations_dir !== 'migrations/auth') throw new Error('AUTH_DB and migrations/auth must be configured.');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.database_id || '')) throw new Error('AUTH_DB database_id must be a real D1 UUID.');
  if (!local && binding.database_id === LOCAL_D1_ID) throw new Error('Local-only AUTH_DB sentinel: set the real production D1 ID before deployment.');
  if (config.assets?.run_worker_first !== true) throw new Error('Protected asset routes require assets.run_worker_first=true.');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv.find((arg) => arg.startsWith('--config='))?.slice(9) || 'wrangler.jsonc';
    const config = parseJsonc(await readFile(file, 'utf8'));
    validateAuthConfig(config, { local: process.argv.includes('--local') });
    console.log('Auth deployment configuration validated.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
