import assert from 'node:assert/strict';
import { validateSchema } from '../js/ai/validation.js';

const objectSchema = { type: 'object', additionalProperties: true };
assert.equal(validateSchema({ value: 1 }, objectSchema).ok, true);
assert.equal(validateSchema(Object.assign(Object.create(null), { value: 1 }), objectSchema).ok, true);
assert.equal(validateSchema(new Date(), objectSchema).ok, false);
assert.equal(validateSchema(new (class ModelOutput { constructor() { this.value = 1; } })(), objectSchema).ok, false);

// Maintainer-owned exact-head regression after the latest canonical generated synchronization.
console.log('ai-schema-plain-object: PASS');
