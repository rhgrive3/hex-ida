import { build, transform } from 'esbuild';
import { privilegedIdentity, releaseIdentityFor, assertStandardGraph, assertPrivilegedGraph } from './auth-build-policy.mjs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { access, readFile, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUserscriptReleaseVersion } from './userscript-release-version.mjs';
import { parseImportScriptsArguments } from './userscript-classic-imports.mjs';
import { writeFileVerified, publishUserscriptFiles } from './userscript-publication.mjs';
import { readResolvedRepositorySource, readStableRepositoryFile, resolveRepositorySource } from './stable-repository-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writeFile = (file, content) => writeFileVerified(file, content, { containmentRoot: root });
const dist = resolve(root, 'dist');
const generated = resolve(root, '.runtime-build');
const committedTemplate = resolve(root, 'userscript/hex.user.template.js');
const deploymentIdentityStamp = resolve(root, 'js/userscript/deployment-identity.generated.js');
const ORIGIN_TOKEN = '__HEX_ORIGIN__';
const releaseStatePath = resolve(root, 'userscript/release-version.json');
const MAX_LOADER_BYTES = 64 * 1024;
const CLASSIC_ENTRIES = ['js/worker.js', 'js/platform/capstone-probe-worker.js', 'js/platform/capstone-disasm-worker.js'];
const OPTIONAL_BUNDLED_CLASSIC_ENTRIES = ['js/targets/architecture/x86_64/semantic-revalidation-worker.js'];
const MODULE_WORKER_ENTRIES = ['js/platform/worker.js', 'js/symbolic/solver/worker-entry.js'];

async function bundleCss() {
  const result = await build({ absWorkingDir: root, stdin: { contents: '@import "./css/app.css";\n@import "./css/ux.css";', resolveDir: root, loader: 'css' }, bundle: true, write: false, minify: true, sourcemap: false, legalComments: 'none', target: ['safari17.4'] });
  const output = result.outputFiles?.find((file) => file.path.endsWith('.css')) || result.outputFiles?.[0];
  if (!output) throw new Error('CSS bundling produced no output.');
  return output.text;
}

function graphLoaderForPath(file) {
  switch (extname(file).toLowerCase()) {
    case '.js': case '.mjs': case '.cjs': return 'js';
    case '.jsx': return 'jsx';
    case '.ts': case '.mts': case '.cts': return 'ts';
    case '.tsx': return 'tsx';
    case '.css': return 'css';
    case '.json': return 'json';
    case '.txt': return 'text';
    default: throw new Error(`Unsupported graph source extension: ${file}`);
  }
}

export function boundGraphSourcePlugin({ rootDir = root, rewriteImportMeta = false } = {}) {
  const resolvedRoot = resolve(rootDir);
  const provenance = new Map();
  const realRootPromise = realpath(resolvedRoot);
  return {
    provenance,
    plugin: { name: 'hex-bound-graph-source', setup(api) {
      api.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        const absolute = resolve(args.path);
        if (!pathIsWithin(resolvedRoot, absolute)) return null;
        const logical = relative(resolvedRoot, absolute).split('\\').join('/');
        if (!logical || logical === '..' || logical.startsWith('../')) return null;
        const resolved = await resolveRepositorySource(logical, {
          rootDir: resolvedRoot,
          normalizePath,
          sourceLabel: 'Bundled graph source',
        });
        const sourceBytes = await readResolvedRepositorySource(resolved, {
          sourceLabel: 'Bundled graph source',
        });
        const effectivePath = relative(await realRootPromise, resolved.realSource)
          .split('\\').join('/');
        if (!effectivePath || effectivePath === '..' || effectivePath.startsWith('../') || isAbsolute(effectivePath)) {
          throw new Error(`Bundled graph source escapes repository: ${logical}`);
        }
        const loader = graphLoaderForPath(absolute);
        let contents = sourceBytes;
        if (rewriteImportMeta && loader === 'js') {
          let text = sourceBytes.toString('utf8');
          if (text.includes('import.meta.url')) {
            text = text.replace(/\bimport\.meta\.url\b/g, JSON.stringify(`https://hex.invalid/${logical}`));
          }
          contents = text;
        }
        const loadedBytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
        const record = Object.freeze({
          effectivePath,
          sourceDigest: sha256(sourceBytes),
          loadedDigest: sha256(loadedBytes),
        });
        const previous = provenance.get(logical);
        if (previous && (previous.effectivePath !== record.effectivePath || previous.loadedDigest !== record.loadedDigest)) {
          throw new Error(`Bundled graph source changed across loads: ${logical}`);
        }
        provenance.set(logical, record);
        return { contents, loader, resolveDir: dirname(absolute) };
      });
    } },
  };
}

export async function bundle(entry, { format = 'iife', rewriteImportMeta = false, globalName, inventory, graph, rootDir = root, buildImpl = build } = {}) {
  const graphBinding = graph ? boundGraphSourcePlugin({ rootDir, rewriteImportMeta }) : null;
  const plugins = graphBinding
    ? [graphBinding.plugin]
    : (rewriteImportMeta ? [protectedImportMetaPlugin({ rootDir })] : []);
  const result = await buildImpl({ absWorkingDir: rootDir, entryPoints: [entry], bundle: true, write: false, metafile: true, globalName, format, platform: 'browser', target: ['safari17.4'], charset: 'utf8', legalComments: 'none', minify: true, minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true, sourcemap: false, plugins });
  const policyOptions = graphBinding ? { repoRoot: rootDir, provenance: graphBinding.provenance } : { repoRoot: rootDir };
  if (graph === 'standard') assertStandardGraph(result.metafile, entry, policyOptions);
  else if (graph) assertPrivilegedGraph(result.metafile, graph, policyOptions);
  if (inventory) await writeFile(resolve(generated, `${inventory}.metafile.json`), JSON.stringify(result.metafile, null, 2));
  const source = result.outputFiles?.[0]?.contents;
  if (!source) throw new Error(`esbuild produced no output for ${entry}`);
  return Buffer.from(source);
}

async function bundleInlinedClassic(entry, source) {
  // capstone.js is a classic UMD script. Once its source is wrapped in the
  // bundle IIFE, keep the factory on the worker global so capstonePrelude can
  // supply the integrity-bound in-memory WASM bytes before initialization.
  source = source.replace(/\bvar MCapstone\s*=/, 'globalThis.MCapstone=');
  const result = await build({
    absWorkingDir: root,
    metafile: true,
    stdin: {
      contents: source,
      resolveDir: resolve(root, posix.dirname(entry)),
      sourcefile: posix.basename(entry),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['safari17.4'],
    charset: 'utf8',
    legalComments: 'none',
    minify: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
    sourcemap: false,
    // Emscripten's generated Capstone UMD contains a guarded Node fallback.
    // Keep that builtin external in this browser-only inline bundle so the
    // dead branch is retained without making esbuild resolve a Node module.
    external: ['node:fs'],
  });
  assertStandardGraph(result.metafile, `embedded classic ${entry}`);
  await writeFile(resolve(generated, `embedded-worker-${entry.replace(/[^a-zA-Z0-9]+/g, '-')}.metafile.json`), JSON.stringify(result.metafile, null, 2));
  const output = result.outputFiles?.[0]?.contents;
  if (!output) throw new Error(`esbuild produced no protected classic worker for ${entry}`);
  return Buffer.from(output);
}

export function protectedImportMetaPlugin({ rootDir = root, readFileImpl = readFile } = {}) {
  return { name: 'hex-protected-import-meta', setup(api) {
    api.onLoad({ filter: /\.js$/ }, async (args) => {
      if (!pathIsWithin(resolve(rootDir), resolve(args.path))) return null;
      let source = await readFileImpl(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return null;
      const logical = relative(resolve(rootDir), resolve(args.path)).split('\\').join('/');
      if (!logical || logical === '..' || logical.startsWith('../')) return null;
      source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(`https://hex.invalid/${logical}`));
      return { contents: source, loader: 'js' };
    });
  } };
}

async function existingOptionalEntries(entries) {
  const present = [];
  for (const entry of entries) {
    try {
      await access(resolve(root, entry));
      present.push(entry);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return present;
}

async function buildWorkerAssets() {
  const bundledClassicEntries = await existingOptionalEntries(OPTIONAL_BUNDLED_CLASSIC_ENTRIES);
  const sources = new Map();
  for (const entry of [...CLASSIC_ENTRIES, ...bundledClassicEntries]) await collectClassic(entry, sources);
  // These sources become strings inside embedded-assets.js, so they are not
  // transitive inputs in the final runtime metafile. Validate the real collected
  // importScripts inventory before flattening, not merely its generated wrapper.
  const classicInventory = { kind: 'classic-importScripts-source-inventory', inputs: Object.fromEntries([...sources.keys()].map((path) => [path, {}])) };
  assertStandardGraph(classicInventory, 'embedded classic source inventory');
  await writeFile(resolve(generated, 'classic-source-inventory.json'), JSON.stringify(classicInventory, null, 2));
  const classic = {};
  for (const entry of CLASSIC_ENTRIES) {
    const minified = await transform(inlineImports(entry, sources), { loader: 'js', target: 'safari17.4', minify: true, legalComments: 'none', sourcemap: false });
    classic[entry] = minified.code;
  }
  for (const entry of bundledClassicEntries) {
    classic[entry] = (await bundleInlinedClassic(entry, inlineImports(entry, sources))).toString('utf8');
  }
  const modules = {
    [MODULE_WORKER_ENTRIES[0]]: (await bundle(MODULE_WORKER_ENTRIES[0], { format: 'iife', graph: 'standard', inventory: 'embedded-worker-platform' })).toString('utf8'),
  };
  for (const entry of MODULE_WORKER_ENTRIES.slice(1)) {
    modules[entry] = (await bundle(entry, { format: 'esm', graph: 'standard', inventory: `embedded-worker-${entry.replace(/[^a-zA-Z0-9]+/g, '-')}` })).toString('utf8');
  }
  const wasm = await readStableRepositoryFile('capstone.wasm', { rootDir: root, normalizePath, sourceLabel: 'Capstone WASM source' });
  return { classic, modules, wasm: wasm.toString('base64') };
}
function pathIsWithin(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function resolveClassicSource(path, options = {}) {
  return resolveRepositorySource(path, {
    ...options,
    rootDir: options.rootDir ?? root,
    normalizePath,
    sourceLabel: 'Classic worker source',
  });
}

export async function collectClassic(path, sources, options = {}) {
  const resolved = await resolveClassicSource(path, options);
  const { normalized } = resolved;
  if (sources.has(normalized)) return;
  const source = await readResolvedRepositorySource(resolved, {
    ...options,
    sourceLabel: 'Classic worker source',
    encoding: 'utf8',
  });

  sources.set(normalized, source);
  for (const dependency of parseImports(source, normalized)) await collectClassic(dependency, sources, options);
}
export function resolveImportScriptsSpecifier(specifier, from) {
  const value = String(specifier);
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error(`Unsupported non-relative importScripts specifier in ${from}: ${value}`);
  }
  return normalizePath(posix.join(posix.dirname(from), value));
}
function resolvedImportScriptsArguments(args, from) {
  return parseImportScriptsArguments(args, from)
    .map((specifier) => resolveImportScriptsSpecifier(specifier, from));
}
function regexLiteralEnd(source, start) {
  let i = start + 1;
  let escaped = false;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i++;
      continue;
    }
    if (ch === '/' && !inClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    }
    i++;
  }
  return null;
}

function regexMayStartAfter(lastSignificantCodeChar, lastWord) {
  if (!lastSignificantCodeChar) return true;
  if (new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'instanceof', 'yield', 'await', 'else', 'do']).has(lastWord)) return true;
  return /[({[=:;,!?&|^~<>%*+\-]/.test(lastSignificantCodeChar);
}

function scanImportScriptsCalls(source) {
  const matches = [];
  const len = source.length;

  function scanCode(start, stopAtTemplateBrace = false) {
    let i = start;
    let braceDepth = 0;
    let lastSignificantCodeChar = '';
    let lastWord = '';
    while (i < len) {
      const ch = source[i];
      if (ch === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < len && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (ch === '\'' || ch === '"') {
        const quote = ch;
        i++;
        while (i < len && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        lastSignificantCodeChar = 'value';
        lastWord = '';
        continue;
      }
      if (ch === '`') {
        i++;
        while (i < len) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          if (source[i] === '`') {
            i++;
            break;
          }
          if (source[i] === '$' && source[i + 1] === '{') {
            const expressionStart = i + 2;
            const result = scanCode(expressionStart, true);
            i = result.index + 1;
            continue;
          }
          i++;
        }
        lastSignificantCodeChar = 'value';
        lastWord = '';
        continue;
      }
      if (ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*'
          && regexMayStartAfter(lastSignificantCodeChar, lastWord)) {
        const regexEnd = regexLiteralEnd(source, i);
        if (regexEnd != null) {
          i = regexEnd;
          lastSignificantCodeChar = 'value';
          lastWord = '';
          continue;
        }
      }
      if (stopAtTemplateBrace) {
        if (ch === '{') {
          braceDepth++;
          lastSignificantCodeChar = ch;
          i++;
          continue;
        }
        if (ch === '}') {
          if (braceDepth === 0) return { index: i };
          braceDepth--;
          lastSignificantCodeChar = ch;
          i++;
          continue;
        }
      }
      if (source.startsWith('importScripts', i)) {
        const prevChar = i > start ? source[i - 1] : '';
        if (!/[a-zA-Z0-9_$]/.test(prevChar) && lastSignificantCodeChar !== '.') {
          let after = i + 'importScripts'.length;
          const nextChar = source[after] || '';
          if (!/[a-zA-Z0-9_$]/.test(nextChar)) {
            while (after < len && /\s/.test(source[after])) after++;
            if (source[after] === '(') {
              const callStart = i;
              after++;
              let depth = 1;
              const argsStart = after;
              while (after < len && depth > 0) {
                const c = source[after];
                if (c === '/' && source[after + 1] === '/') {
                  after += 2;
                  while (after < len && source[after] !== '\n') after++;
                  continue;
                }
                if (c === '/' && source[after + 1] === '*') {
                  after += 2;
                  while (after < len && !(source[after] === '*' && source[after + 1] === '/')) after++;
                  after += 2;
                  continue;
                }
                if (c === '\'' || c === '"') {
                  const q = c;
                  after++;
                  while (after < len && source[after] !== q) {
                    if (source[after] === '\\') after++;
                    after++;
                  }
                  after++;
                  continue;
                }
                if (c === '(') depth++;
                else if (c === ')') depth--;
                if (depth > 0) after++;
              }
              if (depth !== 0) throw new Error('Unterminated importScripts() call.');
              const argsEnd = after;
              after++;
              let callEnd = after;
              while (callEnd < len && /[ \t\r\f\v]/.test(source[callEnd])) callEnd++;
              if (source[callEnd] === ';') callEnd++;
              matches.push({
                start: callStart,
                end: callEnd,
                args: source.slice(argsStart, argsEnd),
                expressionContext: stopAtTemplateBrace,
              });
              i = callEnd;
              lastSignificantCodeChar = ')';
              lastWord = '';
              continue;
            }
          }
        }
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end++;
        lastWord = source.slice(i, end);
        lastSignificantCodeChar = 'word';
        i = end;
        continue;
      }
      if (!/\s/.test(ch)) {
        lastSignificantCodeChar = ch;
        lastWord = '';
      }
      i++;
    }
    if (stopAtTemplateBrace) throw new Error('Unterminated template interpolation.');
    return { index: i };
  }

  scanCode(0, false);
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
export function parseImports(source, from) {
  const out = [];
  for (const call of scanImportScriptsCalls(source)) {
    out.push(...resolvedImportScriptsArguments(call.args, from));
  }
  return out;
}
export function inlineImports(path, sources, stack = []) {
  if (stack.includes(path)) throw new Error(`Worker import cycle: ${[...stack, path].join(' -> ')}`);
  const source = sources.get(path); if (source == null) throw new Error(`Missing worker source: ${path}`);
  const calls = scanImportScriptsCalls(source);
  if (calls.length === 0) return source;
  let result = '';
  let lastIndex = 0;
  for (const call of calls) {
    result += source.slice(lastIndex, call.start);
    const inlined = resolvedImportScriptsArguments(call.args, path)
      .map((dependency) => inlineImports(dependency, sources, [...stack, path]))
      .join('\n');
    result += call.expressionContext ? `(()=>{\n${inlined}\n})()` : inlined;
    lastIndex = call.end;
  }
  result += source.slice(lastIndex);
  return result;
}
function normalizePath(value) { const path = posix.normalize(String(value).replaceAll('\\', '/')).replace(/^\.\//, '').replace(/^\//, ''); if (!path || path.startsWith('../')) throw new Error(`Path escapes repository: ${value}`); return path; }

function extractBody(html) { const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i); if (!match) throw new Error('index.html has no body'); return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim(); }
function standaloneIndex(html, loaderPath) { return html.replace(/<link\s+rel="stylesheet"\s+href="\.\/css\/(?:app|ux)\.css">\s*/g, '').replace(/<script\s+type="module"\s+src="\.\/js\/(?:app|ux)\.js"><\/script>\s*/g, '').replace('</body>', `<script type="module" src="${loaderPath}"></script>\n</body>`); }
function scopeCss(source) {
  const translated = source
    .replace(/(^|[{},])\s*:root\b/g, '$1:scope')
    .replace(/(^|[{},])\s*html(?=[\s.#:[,{>+~])/g, '$1:scope')
    .replace(/(^|[{},])\s*body(?=[\s.#:[,{>+~])/g, '$1:scope');
  return `@scope (#hex-userscript-host){${translated}}#hex-userscript-host{position:fixed;inset:0;width:100vw;height:100dvh;z-index:2147483646;overflow:hidden;background:var(--bg);isolation:isolate}`;
}
function userscriptMetadata(version) { return `// ==UserScript==\n// @name         Hex for ChatGPT\n// @namespace    https://github.com/rhgrive3/hex\n// @version      ${version}\n// @description  Securely load the Hex binary analysis workbench on ChatGPT Web.\n// @match        https://chatgpt.com/*\n// @run-at       document-start\n// @inject-into  content\n// @grant        GM.xmlHttpRequest\n// @grant        GM.getValue\n// @grant        GM.setValue\n// @grant        GM.deleteValue\n// @connect      ida.rhgrive.workers.dev\n// @updateURL    ${ORIGIN_TOKEN}/hex.meta.js\n// @downloadURL  ${ORIGIN_TOKEN}/hex.user.js\n// ==/UserScript==\n\n`; }
function publicManifest(value) { const { assetPath: _private, ...safe } = value; return safe; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function b64(value) { return Buffer.from(value).toString('base64url'); }
async function writeGeneratedModule(name, source) { const path = resolve(root, '.runtime-build', name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }

export async function buildUserscript() {
  const previousReleaseBytes = await readFile(releaseStatePath);
  const previousTemplateBytes = await readFile(committedTemplate);

  await Promise.all([rm(dist, { recursive: true, force: true }), rm(generated, { recursive: true, force: true })]);
  await Promise.all([mkdir(resolve(dist, 'assets'), { recursive: true }), mkdir(resolve(dist, '.runtime'), { recursive: true }), mkdir(resolve(dist, 'userscript'), { recursive: true }), mkdir(generated, { recursive: true })]);
  await writeFile(deploymentIdentityStamp, '// Cloudflare Workers Builds overwrites this file during the production build.\n// Local/test builds intentionally remain unbound to a deployment commit.\nexport const DEPLOYMENT_COMMIT = null;\n');

  const [htmlSource, css, workerAssets] = await Promise.all([readFile(resolve(root, 'index.html'), 'utf8'), bundleCss(), buildWorkerAssets()]);
  const body = extractBody(htmlSource);
  const scopedCss = scopeCss(css);
  await writeGeneratedModule('embedded-assets.js', `export const PROTECTED_HOST=${JSON.stringify({ html: body, css, scopedCss })};\nexport const PROTECTED_WORKER_ASSETS=${JSON.stringify(workerAssets)};\n`);

  const runtime = await bundle('js/userscript/protected-entry.js', { format: 'esm', rewriteImportMeta: true, inventory: 'standard-runtime', graph: 'standard' });
  // Also prove the real parent entry's transitive input graph separately.
  await bundle('js/userscript/entry.js', { format: 'esm', rewriteImportMeta: true, inventory: 'standard-parent', graph: 'standard' });
  const parent = await bundle('js/auth/privileged/parent-entry.js', { format: 'esm', rewriteImportMeta: true, inventory: 'privileged-parent', graph: 'parent' });
  const child = await bundle('js/auth/privileged/child-entry.js', { format: 'iife', globalName: 'HexPrivilegedChild', rewriteImportMeta: true, inventory: 'privileged-child', graph: 'child' });
  const admin = await bundle('js/auth/admin-app.js', { format: 'iife', inventory: 'admin-app' });
  const loaderBundle = await bundle('js/userscript/loader.js', { format: 'iife', inventory: 'standard-loader', graph: 'standard' });
  const contentHash = sha256(runtime), buildId = contentHash.slice(0, 24);
  const privileged = privilegedIdentity(buildId, parent, child, admin);
  await writeGeneratedModule('privileged-assets.js', `export const PRIVILEGED_BUILD=Object.freeze(${JSON.stringify({ ...privileged, parentSource: parent.toString('utf8'), childSource: child.toString('utf8'), adminSource: admin.toString('utf8') })});\n`);
  const releaseInputs = [
    runtime, loaderBundle, parent, child, admin,
    await readFile(new URL('./auth-build-policy.mjs', import.meta.url)),
    await readFile(fileURLToPath(import.meta.url)),
    await readFile(new URL('./userscript-publication.mjs', import.meta.url)),
  ];
  const releaseIdentity = releaseIdentityFor(releaseInputs);
  // Private build evidence binds actual emitted source bytes to the committed
  // release identity; it contains no runtime encryption key or session secret.
  await writeFile(resolve(generated, 'loader-input.js'), loaderBundle);
  await writeFile(resolve(generated, 'release-inputs.json'), JSON.stringify({
    names: ['runtime', 'loader', 'parent', 'child', 'admin', 'policy', 'builder', 'publication'],
    digests: releaseInputs.map(sha256), releaseIdentity,
  }, null, 2));
  const previousRelease = JSON.parse(previousReleaseBytes.toString('utf8'));
  const release = resolveUserscriptReleaseVersion(previousRelease, { releaseIdentity, buildId });
  const LOADER_VERSION = release.version;
  const compressed = gzipSync(runtime, { level: 9 });
  const contentKey = randomBytes(32), iv = randomBytes(12);
  const runtimeVersion = `2.${LOADER_VERSION}`;
  const aad = `hex-runtime:${buildId}:${runtimeVersion}`;
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  const assetPath = `/.runtime/runtime.${buildId}.bin`;
  const runtimeLocator = `/_runtime/${buildId}`;
  const releaseManifest = Object.freeze({
    buildId,
    runtimeVersion,
    contentHash,
    compression: 'gzip',
    runtimeLocator,
    byteLength: ciphertext.length,
  });
  const releaseManifestHash = sha256(Buffer.from(JSON.stringify(releaseManifest), 'utf8'));
  const manifest = Object.freeze({ buildId, privileged, runtimeVersion, ciphertextHash: sha256(ciphertext), contentHash, iv: b64(iv), aad, compression: 'gzip', assetPath, byteLength: ciphertext.length });
  await writeFile(resolve(dist, assetPath.slice(1)), ciphertext);
  await writeGeneratedModule('runtime-secrets.js', `export const RUNTIME_BUILD=Object.freeze(${JSON.stringify({ manifest, contentKey: b64(contentKey), signingKey: b64(randomBytes(32)) })});\n`);

  const loaderForOrigin = (origin) => loaderBundle.toString('utf8')
    .replaceAll(ORIGIN_TOKEN, origin)
    .replaceAll('__HEX_LOADER_VERSION__', LOADER_VERSION)
    .replaceAll('__HEX_BUILD_ID__', buildId)
    .replaceAll('__HEX_CONTENT_HASH__', contentHash)
    .replaceAll('__HEX_RUNTIME_VERSION__', runtimeVersion)
    .replaceAll('__HEX_RUNTIME_BYTE_LENGTH__', String(ciphertext.length))
    .replaceAll('__HEX_RUNTIME_LOCATOR__', runtimeLocator)
    .replaceAll('__HEX_RELEASE_MANIFEST_HASH__', releaseManifestHash);
  const publicLoader = loaderForOrigin('https://ida.rhgrive.workers.dev');
  if (Buffer.byteLength(publicLoader) > MAX_LOADER_BYTES) throw new Error(`Tiny loader exceeds ${MAX_LOADER_BYTES} bytes.`);
  const loaderName = `loader.${sha256(publicLoader).slice(0, 12)}.js`;
  await writeFile(resolve(dist, 'assets', loaderName), publicLoader);

  const metadata = userscriptMetadata(LOADER_VERSION);
  const template = metadata + loaderForOrigin(ORIGIN_TOKEN);
  if (Buffer.byteLength(template) > MAX_LOADER_BYTES) throw new Error(`hex.user.js template exceeds ${MAX_LOADER_BYTES} bytes.`);
  await writeFile(resolve(dist, 'userscript/hex.user.template.js'), template);

  const index = standaloneIndex(htmlSource, `/assets/${loaderName}`);
  await writeFile(resolve(dist, 'index.html'), index);
  await writeFile(resolve(dist, 'runtime-manifest.json'), JSON.stringify(publicManifest(manifest), null, 2));
  await publishUserscriptFiles([
    { path:committedTemplate, expected:previousTemplateBytes, content:template },
    { path:releaseStatePath, expected:previousReleaseBytes, content:JSON.stringify(release.state, null, 2) + '\n' },
  ], { containmentRoot: root });

  console.log(`built tiny userscript loader ${LOADER_VERSION} (${Buffer.byteLength(template)} bytes)`);
  console.log(`userscript release identity ${releaseIdentity}${release.changed ? " (version advanced)" : ""}`);
  console.log(`built protected runtime ${buildId} (${runtime.length} -> ${ciphertext.length} bytes)`);
  console.log(`built dist/ with ${manifest.ciphertextHash}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await buildUserscript();
}