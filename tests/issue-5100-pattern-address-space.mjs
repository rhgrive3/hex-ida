import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../js/pattern/index.js';

function spaceProbeSource(snapshotId = 's') {
  const seen = [];
  return {
    seen,
    source: {
      snapshotId,
      size: 1,
      read(offset, length, options) {
        seen.push(options?.space);
        return new Uint8Array([0x2a]);
      },
    },
  };
}

// 1. targetAddressSpace:'vm' でcompileしたpatternがdefault評価でvm readを行う
{
  const pattern = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'vm' });
  assert.equal(pattern.compileOptions.targetAddressSpace, 'vm');
  const { source, seen } = spaceProbeSource();
  const result = evaluatePattern(pattern, source);
  assert.equal(result.status, 'complete');
  assert.equal(seen[0], 'vm');
  assert.equal(result.value.provenance.space, 'vm');
}

// 2. file defaultの既存挙動を維持
{
  const pattern = compilePattern('struct Root { x: u8; }');
  assert.equal(pattern.compileOptions.targetAddressSpace, 'file');
  const { source, seen } = spaceProbeSource();
  const result = evaluatePattern(pattern, source);
  assert.equal(result.status, 'complete');
  assert.equal(seen[0], 'file');
}

// 3. 同じpatternIdがidentity外のruntime変更で意味論を変えない (conflictはthrow)
{
  const pattern = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'vm' });
  const { source } = spaceProbeSource();
  assert.throws(() => evaluatePattern(pattern, source, { addressSpace: 'file' }), /address-space/);
  const vmPattern = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'file' });
  const { source: s2 } = spaceProbeSource();
  assert.throws(() => evaluatePattern(vmPattern, s2, { addressSpace: 'vm' }), /address-space/);
}

// 4. 一致する明示spaceは許可される
{
  const pattern = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'vm' });
  const { source, seen } = spaceProbeSource();
  const result = evaluatePattern(pattern, source, { addressSpace: 'vm' });
  assert.equal(result.status, 'complete');
  assert.equal(seen[0], 'vm');
}

// 5. compile identityがspaceごとに分離される (patternIdが異なる)
{
  const fileP = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'file' });
  const vmP = compilePattern('struct Root { x: u8; }', { targetAddressSpace: 'vm' });
  assert.notEqual(fileP.patternId, vmP.patternId);
}

// 6. 不正なtargetAddressSpaceはcompile時にfail-closed
{
  assert.throws(() => compilePattern('struct Root { x: u8; }', { targetAddressSpace: {} }), /address-space/);
  assert.throws(() => compilePattern('struct Root { x: u8; }', { targetAddressSpace: '' }), /address-space/);
}

console.log('issue #5100 pattern targetAddressSpace binds evaluation: PASS');
