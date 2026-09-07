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
  if (BAKED) out.push(BAKED);
  const local = fromPkg(dir); if (local) out.push(local);
  const legacy = fromPkg(path.join(path.dirname(process.execPath), '..', 'lib')); if (legacy) out.push(legacy);
  const gr = globalRoot(); if (gr) out.push(path.join(gr, '@nanonets', 'graft', 'dist', 'claude'));
  return out;
}

function entry(name) {
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
  let module;
  try {
    module = await import(pathToFileURL(entry("hooks.js")).href);
  } catch (error) {
    // Module not found / cannot resolve = graft unavailable; stay a no-op.
    if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) return 0;
    process.stderr.write(`graft hook unavailable: ${error?.message || error}\n`);
    return 0; // resolution-side breakage is still "graft unavailable"
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
