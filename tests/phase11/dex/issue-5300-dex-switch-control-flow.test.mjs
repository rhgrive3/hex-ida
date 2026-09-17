// Regression for #5300: DEX control-flow family must carry first-class
// control effects. `goto` (0x28), `goto/16` (0x29) and the if-family
// (0x32..0x3d) are already lifted on main; this pins the remaining gap —
// `goto/32` (0x2a), `packed-switch` (0x2b) and `sparse-switch` (0x2c) —
// which fell to the default unsupported-partial path. Switch opcodes must
// resolve their payload pseudo-unit into a switch-kind control effect with
// the exact case-target edge set (targets are switch-opcode-relative) plus
// the fallthrough default, and fail closed to partial with the default edge
// preserved when the payload cannot be resolved losslessly.
import assert from 'node:assert/strict';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running dex switch/goto32 control-flow regression #5300...');

async function lift(words) {
  const bytes = buildDex({
    fields: [],
    methods: [{
      classType: 'LTest;', name: 'flow', returnType: 'I', params: ['I'],
      flags: 9, registers: 3, ins: 1, words,
    }],
  }).bytes;
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'dex-switch-flow' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods.find((m) => m.name === 'flow'), { image });
  const validation = await frontend.validateMethod(decoded, { image });
  return { decoded, validation, lowered: lowerVMEffectsToSemanticIr(decoded) };
}

// 1. goto/32 resolves its signed 32-bit, code-unit displacement.
{
  const { decoded, lowered } = await lift([
    0x002a, 0x0003, 0x0000,   // goto/32 +3  -> pc 3
    0x1012,                   // const/4 v0, #1
    0x000f,                   // return v0
    0x0000,                   // nop (skipped-over padding)
  ]);
  const goto32 = decoded.bundles.find((b) => b.mnemonic === 'goto/32');
  assert.ok(goto32, 'goto/32 bundle present');
  assert.equal(goto32.completeness, 'exact');
  assert.deepEqual(goto32.controlEffects, [{ kind: 'branch', targetOffset: 6 }]);
  assert.equal(lowered.semanticIr.completeness, 'complete');
}

// 2. packed-switch: payload table resolves to exact case-target edges plus
// the fallthrough default.
{
  const { decoded, lowered } = await lift([
    0x002b, 0x0005, 0x0000,   // packed-switch +5 (payload at pc 5), tests v0
    0x1012,                   // pc 3: const/4 v0, #1   (case target)
    0x000f,                   // pc 4: return v0        (case target / default)
    0x0100, 0x0002,           // packed-switch-payload: ident, size 2
    0x0000, 0x0000,           // first_key = 0
    0x0003, 0x0000,           // target 0 -> pc 3 (switch-relative +3)
    0x0004, 0x0000,           // target 1 -> pc 4 (switch-relative +4)
  ]);
  const sw = decoded.bundles.find((b) => b.mnemonic === 'packed-switch');
  assert.ok(sw, 'packed-switch bundle present');
  assert.equal(sw.completeness, 'exact');
  assert.deepEqual(sw.locationReads, [{ kind: 'register', index: 0, bits: 32 }]);
  assert.deepEqual(sw.controlEffects, [{
    kind: 'switch',
    targetOffsets: [6, 8],
    defaultTargetOffset: 6,
  }]);
  const cfg = lowered.cfg.blocks.map((b) => b.id).sort();
  assert.deepEqual(cfg, ['bb_0x0', 'bb_0x6', 'bb_0x8', 'bb_0xa']);
  const switchNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'packed-switch');
  assert.equal(switchNode.kind, 'switch');
  assert.deepEqual([...switchNode.targets].sort(), ['bb_0x6', 'bb_0x8']);
}

// 3. sparse-switch: interleaved key/target tables resolve to the same
// first-class edge set.
{
  const { decoded } = await lift([
    0x002c, 0x0005, 0x0000,   // sparse-switch +5 (payload at pc 5), tests v0
    0x1012,                   // pc 3: const/4 v0, #1
    0x000f,                   // pc 4: return v0
    0x0200,                   // sparse-switch-payload: ident
    0x0002, 0x0000,           // size = 2
    0x0000, 0x0000,           // key 0 = 0
    0x0007, 0x0000,           // key 1 = 7
    0x0003, 0x0000,           // target 0 -> pc 3
    0x0004, 0x0000,           // target 1 -> pc 4
  ]);
  const sw = decoded.bundles.find((b) => b.mnemonic === 'sparse-switch');
  assert.ok(sw, 'sparse-switch bundle present');
  assert.equal(sw.completeness, 'exact');
  assert.deepEqual(sw.controlEffects, [{
    kind: 'switch',
    targetOffsets: [6, 8],
    defaultTargetOffset: 6,
  }]);
}

// 4. Fail-closed: a switch whose operand does not point at a payload
// pseudo-unit keeps its default edge, publishes no case targets, and
// degrades to partial with a typed reason.
{
  const { decoded, validation } = await lift([
    0x002b, 0x0003, 0x0000,   // packed-switch +3 (pc 3 is const/4, not a payload)
    0x1012,                   // pc 3: const/4 v0, #1
    0x000f,                   // pc 4: return v0
    0x0000,                   // nop
  ]);
  const sw = decoded.bundles.find((b) => b.mnemonic === 'packed-switch');
  assert.ok(sw, 'packed-switch bundle present');
  assert.equal(sw.completeness, 'partial');
  assert.ok(sw.unknownEffects.some((e) => e.reason === 'dex-switch-payload-ident-mismatch'));
  assert.deepEqual(sw.controlEffects, [{ kind: 'switch', targetOffsets: [], defaultTargetOffset: 6 }]);
  assert.equal(validation.completeness.semanticEffect, 'partial');
}

// 5. Fail-closed: payload displaced beyond the instruction stream.
{
  const { decoded } = await lift([
    0x002b, 0x0064, 0x0000,   // packed-switch +100 (past the code end)
    0x1012,                   // pc 3
    0x000f,                   // pc 4
    0x0000,                   // nop
  ]);
  const sw = decoded.bundles.find((b) => b.mnemonic === 'packed-switch');
  assert.equal(sw.completeness, 'partial');
  assert.ok(sw.unknownEffects.some((e) => e.reason === 'dex-switch-payload-out-of-range'));
  assert.deepEqual(sw.controlEffects, [{ kind: 'switch', targetOffsets: [], defaultTargetOffset: 6 }]);
}

// 6. Fail-closed: case target outside the instruction stream is rejected.
{
  const { decoded } = await lift([
    0x002b, 0x0005, 0x0000,   // packed-switch +5
    0x1012,                   // pc 3
    0x000f,                   // pc 4
    0x0100, 0x0001,           // payload: size 1
    0x0000, 0x0000,           // first_key = 0
    0x0064, 0x0000,           // target -> pc 103: out of range
  ]);
  const sw = decoded.bundles.find((b) => b.mnemonic === 'packed-switch');
  assert.equal(sw.completeness, 'partial');
  assert.ok(sw.unknownEffects.some((e) => e.reason === 'dex-switch-target-out-of-range'));
  assert.deepEqual(sw.controlEffects, [{ kind: 'switch', targetOffsets: [], defaultTargetOffset: 6 }]);
}

console.log('  ok dex switch/goto32 control-flow regression #5300 passed');
