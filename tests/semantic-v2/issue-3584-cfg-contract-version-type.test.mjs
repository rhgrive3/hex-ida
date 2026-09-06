import assert from 'node:assert/strict';
import {
  SEMANTIC_CFG_CONTRACT_VERSION,
  createSemanticCfg,
} from '../../js/semantics/cfg/index.js';

const baseGraph = () => ({
  functionId:'issue-3584',
  entryBlockId:'b0',
  blocks:[{ id:'b0', successors:[] }],
});

function assertVersionMismatch(value, message) {
  assert.throws(
    () => createSemanticCfg({ ...baseGraph(), contractVersion:value }),
    (error) => error instanceof TypeError
      && error.message === 'semantic-cfg-contract-version-mismatch',
    message,
  );
}

const exact = createSemanticCfg({
  ...baseGraph(),
  contractVersion:SEMANTIC_CFG_CONTRACT_VERSION,
});
assert.equal(exact.contractVersion, SEMANTIC_CFG_CONTRACT_VERSION, 'exact primitive version remains accepted');
assert.doesNotThrow(() => createSemanticCfg(baseGraph()), 'omitted version keeps compatibility default');
assert.doesNotThrow(
  () => createSemanticCfg({ ...baseGraph(), contractVersion:null }),
  'null version keeps compatibility default',
);

assertVersionMismatch([SEMANTIC_CFG_CONTRACT_VERSION], 'array must not coerce to the canonical version');
assertVersionMismatch(2, 'number must not coerce to a version string');
assertVersionMismatch(true, 'boolean must not coerce to a version string');
assertVersionMismatch(new String(SEMANTIC_CFG_CONTRACT_VERSION), 'boxed string must not be accepted as primitive authority');
assertVersionMismatch('1.0.0', 'wrong primitive version remains rejected');

let coercions = 0;
const coercible = {
  toString() {
    coercions += 1;
    return SEMANTIC_CFG_CONTRACT_VERSION;
  },
};
assertVersionMismatch(coercible, 'object must not coerce to the canonical version');
assert.equal(coercions, 0, 'version validation must not invoke user-controlled string coercion');

console.log('issue #3584 semantic CFG strict contract version type: PASS');
