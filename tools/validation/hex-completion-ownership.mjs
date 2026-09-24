import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'tools/validation/hex-completion-ownership.json');

export function loadManifest(manifestPath = MANIFEST_PATH) {
  const content = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(content);
}

export function compileLanePatterns(manifest, lane) {
  const patterns = manifest?.lanes?.[lane] ?? [];
  return patterns.map((pattern) => new RegExp(pattern));
}

export function permitsFile(manifest, lane, file, { allowIntegrationGovernance = false } = {}) {
  if (typeof file !== 'string' || !file) return false;
  // Fail closed on directory traversal or absolute path tricks
  if (file.startsWith('/') || file.includes('..') || file.includes('\\')) {
    return false;
  }

  // Generated output is owned exclusively by integration
  const isGenerated = (manifest.generatedPaths || []).includes(file);
  if (isGenerated && lane !== manifest.integrationLane) {
    return false;
  }

  const regexes = compileLanePatterns(manifest, lane);
  const laneMatches = regexes.some((re) => re.test(file));
  if (laneMatches) return true;

  if (allowIntegrationGovernance && lane === manifest.integrationLane) {
    if ((manifest.governancePaths || []).includes(file)) return true;
  }

  return false;
}

export function validateInventory(manifest, lane, files, options = {}) {
  if (!manifest?.lanes?.[lane]) {
    throw new Error(`unknown lane: ${lane}`);
  }
  if (!Array.isArray(files)) {
    throw new TypeError('files must be an array');
  }

  const uniqueFiles = [...new Set(files.map((f) => String(f).trim()).filter(Boolean))].sort();
  const violations = uniqueFiles.filter((file) => !permitsFile(manifest, lane, file, options));

  return {
    lane,
    valid: violations.length === 0,
    fileCount: uniqueFiles.length,
    files: uniqueFiles,
    violations,
    verdict: violations.length === 0 ? 'PASS' : 'BLOCKING',
  };
}

export function runNegativeSelfCheck(manifest = loadManifest()) {
  const failures = [];
  for (const [lane, file] of manifest.forbiddenExamples || []) {
    if (permitsFile(manifest, lane, file)) {
      failures.push({ lane, file, reason: 'forbidden file was unexpectedly permitted' });
    }
  }
  return {
    valid: failures.length === 0,
    failures,
  };
}

export function getChangedFilesFromGit(repoPath, base, head) {
  const git = (...args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  const diffOutput = git('diff', '--name-only', `${base}..${head}`);
  return diffOutput.split('\n').filter(Boolean);
}

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const manifest = loadManifest();

  // Run negative self check first
  const selfCheck = runNegativeSelfCheck(manifest);
  if (!selfCheck.valid) {
    stderr.write(`ownership negative self-check failed: ${JSON.stringify(selfCheck.failures)}\n`);
    return 1;
  }

  const lane = argv[0];
  if (!lane) {
    stdout.write('ownership negative self-check: PASS\n');
    return 0;
  }

  if (!manifest.lanes[lane]) {
    stderr.write(`error: unknown lane ${lane}\n`);
    return 1;
  }

  let repoDir = ROOT;
  let baseSha = null;
  let headSha = null;
  let files = null;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) {
      repoDir = argv[++i];
    } else if (argv[i] === '--base' && argv[i + 1]) {
      baseSha = argv[++i];
    } else if (argv[i] === '--head' && argv[i + 1]) {
      headSha = argv[++i];
    } else if (argv[i] === '--files-json' && argv[i + 1]) {
      files = JSON.parse(argv[++i]);
    }
  }

  if (!files) {
    const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
    if (!headSha) headSha = git('rev-parse', 'HEAD');
    if (!baseSha) {
      try {
        baseSha = git('merge-base', headSha, 'origin/main');
      } catch {
        baseSha = git('merge-base', headSha, 'main');
      }
    }
    files = getChangedFilesFromGit(repoDir, baseSha, headSha);
  }

  const result = validateInventory(manifest, lane, files, { allowIntegrationGovernance: true });
  stdout.write(JSON.stringify({ ...result, baseSha, headSha }, null, 2) + '\n');
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const code = runCli();
  process.exit(code);
}
