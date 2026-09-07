import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../js/ai/tools/registry-query-base.js', import.meta.url), 'utf8');

const getFunctionStart = source.indexOf("const originalGetFunction = registry.get('get_function')?.execute;");
const inspectStart = source.indexOf("const originalInspect = registry.get('inspect_function_region')?.execute;");
assert.ok(getFunctionStart >= 0 && inspectStart > getFunctionStart, 'expected QueryAPI get_function and inspect overrides');

const compactOverride = source.slice(getFunctionStart, inspectStart);
assert.doesNotMatch(compactOverride, /getInstructions\s*\(/, 'get_function must not eagerly fetch assembly');
assert.doesNotMatch(compactOverride, /decompile\s*\(/, 'get_function must not eagerly invoke decompiler');
assert.match(compactOverride, /markQueryAuthority/, 'get_function should retain QueryAPI authority provenance');

const detailOverride = source.slice(inspectStart);
assert.match(detailOverride, /context\.getInstructions\s*\(/, 'assembly remains available through inspect_function_region');
