import fs from "node:fs";
import assert from "node:assert/strict";
import {
  architectureAdapter,
  registerArchitectureAdapter,
  ArchitectureAdapter,
  architecturePluginV2,
  architecturePluginsV2,
  ArchitecturePluginV2,
} from "../js/architecture/index.js";
import { registerArchitecturePlugin } from "../js/targets/architecture/index.js";

console.log("Testing ArchitectureAdapter live view over ArchitecturePluginV2...");

for (const plugin of architecturePluginsV2()) {
  const adapter = architectureAdapter(plugin.id);
  assert.equal(adapter.id, plugin.id);
  assert.equal(adapter.instructionAlignment, plugin.instructionAlignment);
  assert.equal(adapter.fixedInstructionSize, plugin.fixedInstructionSize);
  assert.equal(adapter.viewerCompatible, plugin.viewerCompatible);
  assert.equal(adapter.decode, plugin.decode);
  assert.equal(adapter.assemble, plugin.assemble);
}
console.log("  ok Case 1 built-ins parity");

for (const plugin of architecturePluginsV2()) {
  const adapter = architectureAdapter(plugin.id);
  const fakeInsn = { mnemonic: "ret" };
  assert.equal(adapter.controlFlow(fakeInsn), plugin.classifyControlFlow(fakeInsn));
}
console.log("  ok Case 2 control-flow projection parity");

{
  const arm = architectureAdapter("arm64");
  assert.equal(arm.callKind({ mnemonic: "bl" }), "call");
  assert.equal(arm.callKind({ mnemonic: "add" }), null);
  assert.equal(arm.returnKind({ mnemonic: "ret" }), "return");
  assert.equal(arm.returnKind({ mnemonic: "add" }), null);
  console.log("  ok Case 3 callKind/returnKind");
}

{
  const a1 = architectureAdapter("arm64");
  const a2 = architectureAdapter("arm64");
  assert.strictEqual(a1, a2);
  console.log("  ok Case 4 repeated lookup is strict equal");
}

{
  const a1 = architectureAdapter("  ARM64  ");
  const a2 = architectureAdapter("arm64");
  assert.strictEqual(a1, a2);
  console.log("  ok Case 5 shared normalization");
}

{
  const unk = architectureAdapter("non-existent-arch");
  const unkPlugin = architecturePluginV2("unknown");
  assert.equal(unk.id, unkPlugin.id);
  console.log("  ok Case 6 unknown fallback parity");
}

{
  const testId = "test-arch-live-" + Date.now();
  registerArchitecturePlugin({ id: testId, instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true });
  const adapter = architectureAdapter(testId);
  assert.equal(adapter.id, testId);
  assert.equal(adapter.fixedInstructionSize, 4);
  console.log("  ok Case 7 late canonical registration immediately visible");
}

{
  const testId = "test-replace-live-" + Date.now();
  registerArchitecturePlugin({ id: testId, instructionAlignment: 4, fixedInstructionSize: 4 });
  const a1 = architectureAdapter(testId);
  registerArchitecturePlugin({ id: testId, instructionAlignment: 2, fixedInstructionSize: 2 }, { replace: true });
  const a2 = architectureAdapter(testId);
  assert.notStrictEqual(a1, a2);
  assert.equal(a2.fixedInstructionSize, 2);
  assert.strictEqual(a2, architectureAdapter(testId));
  console.log("  ok Case 8 canonical replacement invalidation");
}

{
  const testId = "test-legacy-write-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 8, fixedInstructionSize: 8 });
  const plugin = architecturePluginV2(testId);
  assert.ok(plugin);
  assert.equal(plugin.id, testId);
  assert.equal(plugin.fixedInstructionSize, 8);
  console.log("  ok Case 9 legacy registration writes canonical");
}

{
  const testId = "test-legacy-dup-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 4 });
  assert.throws(() => registerArchitectureAdapter({ id: testId, instructionAlignment: 4 }), /architecture already registered/);
  console.log("  ok Case 10 legacy duplicate rejection");
}

{
  const testId = "test-legacy-replace-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 4, fixedInstructionSize: 4 });
  const a2 = registerArchitectureAdapter({ id: testId, instructionAlignment: 2, fixedInstructionSize: 2 }, { replace: true });
  assert.equal(a2.fixedInstructionSize, 2);
  assert.equal(architecturePluginV2(testId).fixedInstructionSize, 2);
  console.log("  ok Case 11 legacy replace updates canonical");
}

{
  const custom = new ArchitectureAdapter({ id: "custom", fixedInstructionSize: 4, instructionAlignment: 4 });
  assert.equal(custom.rowForAddress({ vmAddr: 0x1000n, size: 0x100n }, 0x1004n), 1);
  console.log("  ok Case 12 direct construction works");
}

{
  const custom = new ArchitectureAdapter({ id: "custom-var", fixedInstructionSize: null });
  const res = custom.validateInstructionPlacement({ vmAddr: 0x1000n, size: 0x100n }, 0x1000n, 4);
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  console.log("  ok Case 13 variable-width placement unsupported");
}

{
  const code = fs.readFileSync(new URL("../js/architecture/index.js", import.meta.url), "utf8");
  assert.ok(!code.includes("const BUILTINS = new Map"));
  assert.ok(!code.includes("for (const plugin of architecturePluginsV2()) registerArchitectureAdapter"));
  console.log("  ok Case 14 no registry snapshot in source");
}

{
  const custom = new ArchitectureAdapter({ id: "custom-safe-row", fixedInstructionSize: 1, instructionAlignment: 1 });
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const region = { vmAddr: 0n, size: maxSafe + 2n };
  assert.equal(custom.rowForAddress(region, maxSafe), Number.MAX_SAFE_INTEGER);
  assert.equal(custom.addressForRow(region, Number.MAX_SAFE_INTEGER), maxSafe);
  assert.equal(custom.rowForAddress(region, maxSafe + 1n), null);
  console.log("  ok Case 15 unsafe row numbers fail closed");
}

{
  const arm = new ArchitectureAdapter({ id: "arm64-strict-placement", fixedInstructionSize: 4, instructionAlignment: 4 });
  const region = { vmAddr: 0x1000n, size: 0x100n };
  assert.equal(arm.addressForRow(region, 0), 0x1000n);
  assert.equal(arm.addressForRow(region, 3), 0x100cn);
  for (const malformedRow of [[], [3], true, false, "3", { valueOf: () => 3 }]) assert.equal(arm.addressForRow(region, malformedRow), null);
  assert.deepEqual(arm.validateInstructionPlacement(region, 0x1000n, 4), { ok: true });
  for (const malformedLength of [[4], true, "4", { valueOf: () => 4 }]) {
    const result = arm.validateInstructionPlacement(region, 0x1000n, malformedLength);
    assert.equal(result.ok, false);
    assert.equal(result.code, "instruction-placement");
  }
  console.log("  ok Case 16 placement coercion fails closed");
}

{
  const valid = new ArchitecturePluginV2({ id: "strict-metadata-valid", instructionAlignment: 1, fixedInstructionSize: 4 });
  assert.equal(valid.instructionAlignment, 1);
  assert.equal(valid.fixedInstructionSize, 4);
  const variable = new ArchitecturePluginV2({ id: "strict-metadata-variable", instructionAlignment: 4, fixedInstructionSize: null });
  assert.equal(variable.fixedInstructionSize, null);
  for (const malformed of ["4", [4], true, { valueOf: () => 4 }]) {
    assert.throws(() => new ArchitecturePluginV2({ id: "strict-alignment", instructionAlignment: malformed, fixedInstructionSize: 4 }), /instructionAlignment must be a finite positive integer/);
    assert.throws(() => new ArchitecturePluginV2({ id: "strict-size", instructionAlignment: 4, fixedInstructionSize: malformed }), /fixedInstructionSize must be a finite positive integer/);
  }
  console.log("  ok Case 17 architecture metadata coercion fails closed");
}

console.log("All architecture live view tests PASS!");