import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DECOMPILER_ASSERTION_FILES,
  SEMANTIC_ASSERTION_FILES,
} from '../support/semantic-corpus-manifest.mjs';
import { runPhase3Corpus } from '../support/phase3-corpus-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const legacyPreloadFile = path.join(os.tmpdir(), `hex-phase3-legacy-preload-${process.pid}.mjs`);
const irUrl = pathToFileURL(path.join(root, 'js/ir.js')).href;
fs.writeFileSync(legacyPreloadFile,
  `import { setSemanticMigrationMode } from ${JSON.stringify(irUrl)};\n` +
  `setSemanticMigrationMode('legacy-v1');\n`);
const legacyPreloadUrl = pathToFileURL(legacyPreloadFile).href;
const inheritedNodeOptions = String(process.env.NODE_OPTIONS ?? '').trim();
const legacyEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  NODE_OPTIONS: [inheritedNodeOptions, `--import=${legacyPreloadUrl}`].filter(Boolean).join(' '),
};
delete legacyEnv.npm_config_prefix;

// This invocation is intentionally byte-for-byte equivalent to the one in
// integration-final-evidence.test.mjs. With the explicit process-scoped reuse
// token set by current-corpus-group.mjs, the later consumer receives this exact
// completed proof instead of launching the same 25 legacy commands again.
await runPhase3Corpus({
  suite: 'legacy-differential',
  files: [...SEMANTIC_ASSERTION_FILES, ...DECOMPILER_ASSERTION_FILES],
  root,
  env: legacyEnv,
  timeoutMs: 180_000,
});
