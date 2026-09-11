#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BAKED = "/usr/local/share/nvm/versions/node/v24.14.0/lib/node_modules/@nanonets/graft/dist/claude";

// The dist/claude dir of @nanonets/graft resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

function candidates() {
  const out = [];
  // Project-local dependency wins: the checkout's own @nanonets/graft must
  // never be shadowed by a machine-specific global install (#5895). The
  // baked absolute path is only a historical compat fallback, and an
  // explicit GRAFT_CLAUDE_DIR override takes precedence over everything so
  // a pinned toolchain stays possible without repinning every checkout.
  const override = process.env.GRAFT_CLAUDE_DIR;
  if (override) out.push(override);
  const local = fromPkg(dir); if (local) out.push(local);
  const legacy = fromPkg(path.join(path.dirname(process.execPath), '..', 'lib')); if (legacy) out.push(legacy);
  const gr = globalRoot(); if (gr) out.push(path.join(gr, '@nanonets', 'graft', 'dist', 'claude'));
  if (BAKED) out.push(BAKED);
  return out;
}

function entry(name) {
  // Tests may provide an isolated project-local fixture. Do not let a baked or
  // globally installed graft satisfy that fixture by accident.
  if (process.env.GRAFT_TEST_NO_FALLBACK === '1') {
    return path.join(dir, 'dist', 'claude', name);
  }
  for (const d of candidates()) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return path.join(dir, 'dist', 'claude', name); // last-ditch; import will no-op if absent
}

// The module boundary is separated from the execution boundary (#5897): only
// "graft is genuinely not installed here" may fail open as a no-op. Once the
// module loads and main() starts, a hook failure must reach the caller as a
// non-zero exit with evidence on stderr — a broken quality guardrail must not
// be converted into a success.
async function runGraftHook() {
  const hookPath = entry("hooks.js");
  let module;
  try {
    module = await import(pathToFileURL(hookPath).href);
  } catch (error) {
    // Only an absent entry module is an unavailable graft. An existing but
    // unloadable hook (syntax error or missing transitive dependency) is an
    // installed guardrail failure and must not become a silent success.
    if (!fs.existsSync(hookPath)
      && error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) return 0;
    process.stderr.write(`graft hook unavailable: ${error?.message || error}\n`);
    return 1;
  }
  if (!module || typeof module.main !== 'function') {
    process.stderr.write('graft hook failed: hooks.js has no main() export\n');
    return 1;
  }
  try {
    await module.main(process.argv[2]);
    return 0;
  } catch (error) {
    process.stderr.write(`graft hook failed: ${error?.message || error}\n`);
    return 1;
  }
}

runGraftHook().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`graft hook failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
