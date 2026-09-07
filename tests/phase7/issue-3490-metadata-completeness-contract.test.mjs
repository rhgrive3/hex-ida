import assert from 'node:assert/strict';
import test from 'node:test';

import { __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { completenessFor } = __investigationInternalsForTests;

const strings = Object.assign([], { complete:true });
const program = {
  graphCompleteness:{ complete:true },
  callsCapped:false,
  refsCapped:false,
  statsComplete:true,
};
const metadataFailure = { complete:false, reasons:['objc-metadata-failed'] };

test('#3490 metadata failure remains partial when the goal depends on metadata/shape evidence', () => {
  const completeness = completenessFor({
    strings,
    program,
    shapes:{ complete:true },
    metadata:metadataFailure,
    goal:{ id:'hp', expects:{ numeric:true } },
  });

  assert.equal(completeness.complete, false);
  assert.deepEqual(completeness.reasons, ['objc-metadata-failed']);
});

test('#3490 metadata failure does not lower completeness for metadata-optional goals', () => {
  const completeness = completenessFor({
    strings,
    program,
    shapes:null,
    metadata:metadataFailure,
    goal:{ id:'strings', expects:{} },
  });

  assert.equal(completeness.complete, true);
  assert.deepEqual(completeness.reasons, []);
});
