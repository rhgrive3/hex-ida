import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import {
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/shared/bridge-v2.js';

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:issue-4028',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      exceptionClauses: [],
    }],
  };
}

// 00: ldc.i4.0
// 01: switch (1 target)
// 0a: ldc.i4.1; ret        default
// 0c: ldc.i4.2; ret        case target
const SWITCH_BYTES = Uint8Array.from([
  0x16,
  0x45, 0x01, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
  0x17, 0x2a,
  0x18, 0x2a,
]);

function loweredSwitch() {
  return lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(SWITCH_BYTES)));
}

test('#4028 production CIL switch renders a conservative dispatch with case/default edges', () => {
  const lowered = loweredSwitch();
  const switchNode = lowered.semanticIr.nodes.find((node) => node.kind === 'switch');
  assert.ok(switchNode, 'production lowering must retain the switch node');
  assert.deepEqual(switchNode.targets, ['bb_0xc', 'bb_0xa']);

  const out = decompileManagedMethod(lowered);
  assert.match(
    out.pseudocode,
    /switch_dispatch\(0, case_edge\(0, bb_0xc\), default_edge\(bb_0xa\)\);/,
    'renderer must preserve the selector and distinguish case/default CFG authority',
  );
  assert.match(out.pseudocode, /^bb_0xa:$/m, 'default target must remain an explicit label');
  assert.match(out.pseudocode, /^bb_0xc:$/m, 'case target must remain an explicit label');
});

test('#4028 target-only Semantic IR fails closed without inventing case values', () => {
  const lowered = loweredSwitch();
  const switchNode = lowered.semanticIr.nodes.find((node) => node.kind === 'switch');
  const nodes = lowered.semanticIr.nodes.map((node) => node === switchNode
    ? { ...node, targets: ['bb_0xc', 'bb_0xc', 'bb_0xa'] }
    : node);
  const cfgBlocks = lowered.cfg.blocks.map((block) => block.id === switchNode.blockId
    ? { ...block, successors: [] }
    : block);

  const out = decompileManagedMethod({
    ...lowered,
    semanticIr: { ...lowered.semanticIr, nodes },
    cfg: { ...lowered.cfg, blocks: cfgBlocks },
  });

  const renderedSwitch = out.decompiledAst.body.find((stmt) => stmt.kind === 'switch');
  assert.equal(
    renderedSwitch?.text,
    'switch_dispatch(0, target_edge(0, bb_0xc), target_edge(1, bb_0xc), target_edge(2, bb_0xa));',
    'when only targets are authoritative, renderer must keep every edge without claiming case/default meaning',
  );
  assert.doesNotMatch(out.pseudocode, /case\s+0\s*:/, 'unknown case values must not be fabricated');
});


test('#4028 default-only switch preserves the default role without fabricating a case', () => {
  const lowered = loweredSwitch();
  const switchNode = lowered.semanticIr.nodes.find((node) => node.kind === 'switch');
  const nodes = lowered.semanticIr.nodes.map((node) => node === switchNode
    ? { ...node, targets: ['bb_0xa'] }
    : node);
  const cfgBlocks = lowered.cfg.blocks.map((block) => block.id === switchNode.blockId
    ? { ...block, successors: [{ kind: 'switch-default', to: 'bb_0xa' }] }
    : block);

  const out = decompileManagedMethod({
    ...lowered,
    semanticIr: { ...lowered.semanticIr, nodes },
    cfg: { ...lowered.cfg, blocks: cfgBlocks },
  });

  const renderedSwitch = out.decompiledAst.body.find((stmt) => stmt.kind === 'switch');
  assert.equal(renderedSwitch?.text, 'switch_dispatch(0, default_edge(bb_0xa));');
  assert.doesNotMatch(out.pseudocode, /case_edge\(/, 'default-only authority must not mint a case edge');
});

test('#4028 unresolved switch remains visible instead of becoming layout fallthrough', () => {
  const lowered = loweredSwitch();
  const switchNode = lowered.semanticIr.nodes.find((node) => node.kind === 'switch');
  const nodes = lowered.semanticIr.nodes.map((node) => node === switchNode
    ? {
        ...node,
        targets: [],
        completeness: 'partial',
        unknown: { reason: 'unresolved-switch-targets', categories: ['control'] },
      }
    : node);
  const cfgBlocks = lowered.cfg.blocks.map((block) => block.id === switchNode.blockId
    ? { ...block, successors: [] }
    : block);

  const out = decompileManagedMethod({
    ...lowered,
    semanticIr: { ...lowered.semanticIr, nodes },
    cfg: { ...lowered.cfg, blocks: cfgBlocks },
  });
  assert.match(out.pseudocode, /switch_unknown\(0\);/);
});
