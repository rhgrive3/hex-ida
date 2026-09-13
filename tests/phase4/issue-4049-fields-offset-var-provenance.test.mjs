import assert from 'node:assert/strict';
import { FieldIndex } from '../../js/fields.js';

const fields = new FieldIndex({
  classes: [
    {
      name: 'C',
      instanceSize: 0x40,
      ivars: [
        { name: '_foo', offset: 0x10, offsetVar: 0x2000n, size: 8 },
        { name: '_bar', offset: 0x20, size: 8 },
      ],
      properties: [],
      methods: [],
      classMethods: [],
    },
  ],
});

{
  const hit = fields.resolveAccess({ base: 'x19', indexAddr: 0x2000n, self: true }, 'C');
  assert.equal(hit?.name, '_foo');
  assert.equal(hit?.exact, true);
  assert.equal(hit?.viaOffsetVar, true);
  assert.equal(hit?.certain, true, 'proven self must keep offset-variable field certainty');
}

for (const className of ['C', 'Other']) {
  const hit = fields.resolveAccess({ base: 'x5', indexAddr: 0x2000n, self: false }, className);
  assert.equal(hit?.name, '_foo', 'offset-variable identity remains useful as a field candidate');
  assert.equal(hit?.exact, true);
  assert.equal(hit?.viaOffsetVar, true);
  assert.equal(hit?.certain, false, `owner ${className} must not substitute for base-object provenance`);
}

{
  const hit = fields.resolveAccess({ base: 'x5', indexAddr: 0x2000n }, 'C');
  assert.equal(hit?.name, '_foo');
  assert.equal(hit?.certain, false, 'missing self provenance must fail closed');
}

{
  const directUnknown = fields.resolveAccess({ base: 'x19', disp: 0x20n }, 'C');
  assert.equal(directUnknown?.name, '_bar');
  assert.equal(directUnknown?.certain, false, 'direct-displacement heuristic must remain uncertain');

  const directSelf = fields.resolveAccess({ base: 'x19', disp: 0x20n, self: true }, 'C');
  assert.equal(directSelf?.name, '_bar');
  assert.equal(directSelf?.certain, true, 'proven self direct access must remain certain');
}

console.log('phase4 issue-4049 FieldIndex offset-variable provenance: PASS');
