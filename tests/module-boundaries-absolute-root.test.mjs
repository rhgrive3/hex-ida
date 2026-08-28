import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanModuleBoundaries } from '../tools/validation/module-boundaries.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = scanModuleBoundaries({ root: 'js' });
const absolute = scanModuleBoundaries({ root: path.join(repositoryRoot, 'js') });

assert.deepEqual(absolute, relative);
console.log('module boundaries absolute-root regression: PASS');
