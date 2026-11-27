import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(ROOT, 'js/ui/v6-workbench-bridge.js');
const toolsBasePath = path.join(ROOT, 'js/tools-base.js');
const cleanViewPath = path.join(ROOT, 'js/decompiler/clean-view.js');

// 1. Verify syntax of modified files via node --check
execFileSync(process.execPath, ['--check', bridgePath], { stdio: 'pipe' });
execFileSync(process.execPath, ['--check', toolsBasePath], { stdio: 'pipe' });

// 2. Verify js/tools-base.js Clean View wiring and imports
const toolsSrc = fs.readFileSync(toolsBasePath, 'utf8');
assert.ok(
  toolsSrc.includes("import { formatCleanViewLines } from './decompiler/clean-view.js';"),
  'js/tools-base.js must import formatCleanViewLines from ./decompiler/clean-view.js',
);
assert.ok(
  toolsSrc.includes('let cleanView = true;'),
  'showDecompiler must initialize cleanView = true',
);
assert.ok(
  toolsSrc.includes("const cleanChip = button('Clean View', 'chip on'"),
  'showDecompiler must add Clean View toggle chip with class "chip on"',
);
assert.ok(
  toolsSrc.includes('formatCleanViewLines(out.lines'),
  'showDecompiler must call formatCleanViewLines(out.lines, ...)',
);
assert.ok(
  toolsSrc.includes('getActiveDecompiledText'),
  'showDecompiler copy button must copy the active view text (Clean View or raw)',
);

// 3. Verify js/ui/v6-workbench-bridge.js Clean View wiring and imports
const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
assert.ok(
  bridgeSrc.includes("import { formatCleanViewLines, formatCleanViewText } from '../decompiler/clean-view.js';"),
  'v6-workbench-bridge.js must import formatCleanViewLines and formatCleanViewText',
);
assert.ok(
  bridgeSrc.includes('refineDecompiledCode(pseudoC, opts = {})'),
  'V6Workbench must define refineDecompiledCode(pseudoC, opts = {})',
);

// 4. Runtime test for V6Workbench.prototype.refineDecompiledCode when clean-view.js is present
if (fs.existsSync(cleanViewPath)) {
  const { V6Workbench } = await import('../js/ui/v6-workbench-bridge.js');
  assert.equal(typeof V6Workbench.prototype.refineDecompiledCode, 'function');

  const wb = new V6Workbench(null);
  const samplePseudoC = [
    'typedef unsigned long uint64_t;',
    'int64_t sub_1000(int64_t a1) {',
    '    return a1 + 1;',
    '}',
  ].join('\n');

  const defaultRes = wb.refineDecompiledCode(samplePseudoC);
  assert.equal(typeof defaultRes?.code, 'string', 'refineDecompiledCode must return { code, stats }');
  assert.ok(defaultRes.stats && typeof defaultRes.stats === 'object', 'refineDecompiledCode must return stats');

  // displayHints defaults should be respected when opts does not override them
  wb.displayHints.cleanView = { hideTypedefPrelude: false };
  const withHintFalse = wb.refineDecompiledCode(samplePseudoC);
  assert.ok(
    withHintFalse.code.includes('typedef unsigned long uint64_t;'),
    'displayHints.cleanView.hideTypedefPrelude = false should preserve typedef prelude',
  );

  // Explicit opts must override displayHints
  const withExplicitTrue = wb.refineDecompiledCode(samplePseudoC, { hideTypedefPrelude: true });
  assert.ok(
    !withExplicitTrue.code.includes('typedef unsigned long uint64_t;'),
    'explicit opts.hideTypedefPrelude = true should override displayHints',
  );

  wb.detach();
} else {
  console.log('NOTE: js/decompiler/clean-view.js not yet present; static and syntax checks passed.');
}

console.log('v6-clean-view-ui.test.mjs PASS');
