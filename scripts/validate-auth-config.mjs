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
  // The runtime binding identity must be unambiguous: a deployment config that
  // declares AUTH_DB more than once cannot prove which definition the auth
  // worker will resolve, and `find()` would silently ignore later conflicts.
  // Cardinality is therefore exactly one, independent of array ordering.
  const databases = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  const authBindings = databases.filter((item) => item?.binding === 'AUTH_DB');
  if (authBindings.length !== 1) throw new Error('AUTH_DB must be defined exactly once.');
  const [binding] = authBindings;
  if (binding.database_name !== 'hex-auth' || binding.migrations_dir !== 'migrations/auth') throw new Error('AUTH_DB and migrations/auth must be configured.');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.database_id || '')) throw new Error('AUTH_DB database_id must be a real D1 UUID.');
  if (!local && binding.database_id === LOCAL_D1_ID) throw new Error('Local-only AUTH_DB sentinel: set the real production D1 ID before deployment.');
  if (config.assets?.run_worker_first !== true) throw new Error('Protected asset routes require assets.run_worker_first=true.');
  return true;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let file = 'wrangler.jsonc';
  let local = false;
  let hasConfigFile = false;
  let hasLocal = false;

  for (const arg of argv) {
    if (arg.startsWith('--config=')) {
      if (hasConfigFile) throw new Error(`Duplicate --config option: ${arg}`);
      const val = arg.slice(9);
      if (!val) throw new Error('Invalid --config option: path cannot be empty.');
      file = val;
      hasConfigFile = true;
    } else if (arg === '--local') {
      if (hasLocal) throw new Error('Duplicate --local option.');
      local = true;
      hasLocal = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { file, local };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { file, local } = parseCliArgs(process.argv.slice(2));
    const config = parseJsonc(await readFile(file, 'utf8'));
    validateAuthConfig(config, { local });
    console.log('Auth deployment configuration validated.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
