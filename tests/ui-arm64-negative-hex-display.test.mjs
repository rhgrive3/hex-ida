import assert from 'node:assert/strict';
import { immText } from '../js/ui/explain/arm64-operands.js';

const rendered = immText({ k: 'imm', text: '#-0x20', value: -32n });
assert.match(rendered, /^-0x20(?:\s|（)/, 'negative hexadecimal immediates must place the sign before the 0x prefix');
assert.doesNotMatch(rendered, /0x-20/, 'negative hexadecimal immediates must never render as 0x-N');

console.log('ui-arm64-negative-hex-display: PASS');
