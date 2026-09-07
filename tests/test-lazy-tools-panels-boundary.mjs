import assert from "node:assert/strict";
import * as tools from "../js/tools.js";

console.log("Testing Issue #2622 Tools/Panels lazy boundary regressions...");

// 1. Export presence and identity
assert.equal(typeof tools.showTools, "function");
assert.equal(typeof tools.prettyName, "function");
assert.equal(typeof tools.fullName, "function");
assert.equal(typeof tools.currentFunctionAddr, "function");
assert.equal(typeof tools.showDecompiler, "function");
assert.equal(typeof tools.showCfg, "function");
assert.equal(typeof tools.showTypes, "function");
assert.equal(typeof tools.showDebugger, "function");
assert.equal(typeof tools.showIl2cpp, "function");
assert.equal(typeof tools.showScript, "function");
assert.equal(typeof tools.showPlugins, "function");

// 2. parseDebuggerArgument functionality
const parsed = tools.parseDebuggerArgument("0x1000");
assert.equal(parsed.ok, true);
assert.equal(parsed.value, 0x1000n);

const parsedDec = tools.parseDebuggerArgument("42");
assert.equal(parsedDec.ok, true);
assert.equal(parsedDec.value, 42n);

const invalid = tools.parseDebuggerArgument("invalid");
assert.equal(invalid.ok, false);

// 3. prettyName / fullName functionality
assert.equal(tools.prettyName("my_function"), "my_function");
assert.equal(tools.fullName("my_function"), "my_function");

console.log("Issue #2622 regressions PASS!");
