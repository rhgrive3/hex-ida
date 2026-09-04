import test from "node:test";
import assert from "node:assert/strict";
import { createAgentTools } from "../js/agent/tools.js";
import { planAnalysisGoal } from "../js/query/planner.js";

test("FunctionLoader: throws in ctx.analyze() still consume budget against maxFunctions", async () => {
  let analyzeCalls = 0;
  const ctx = {
    analyze: async (addr) => {
      analyzeCalls++;
      if (addr === 0x1000n) {
        throw new Error("backend failure during analyze");
      }
      return { address: addr, instructions: [] };
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 1 });
  // 1st call fails
  await assert.rejects(() => tools.get_function(0x1000n), /backend failure during analyze/);
  assert.equal(analyzeCalls, 1);

  // 2nd call for distinct address must fail with function-budget without calling analyze
  await assert.rejects(() => tools.get_function(0x2000n), {
    name: "AgentToolError",
    code: "function-budget",
  });
  assert.equal(analyzeCalls, 1, "analyze must not be invoked after budget exhausted");
});

test("FunctionLoader: functionRange failure does not consume analysis budget", async () => {
  let analyzeCalls = 0;
  const ctx = {
    program: {
      functionRange(addr) {
        if (addr === 0x1000n) throw new Error("range lookup failed");
        return { start: addr, end: addr + 4n };
      },
    },
    analyze: async (addr) => {
      analyzeCalls++;
      return { address: addr, instructions: [] };
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 1 });
  await assert.rejects(() => tools.get_function(0x1000n), {
    name: "AgentToolError",
    code: "tool-failed",
  });
  assert.equal(analyzeCalls, 0, "functionRange failure must not start analysis");

  const result = await tools.get_function(0x2000n);
  assert.equal(result.address, 0x2000n);
  assert.equal(analyzeCalls, 1, "functionRange failure must not consume analysis budget");
});

test("FunctionLoader: maxFunctions=0 rejects before calling ctx.analyze()", async () => {
  let analyzeCalls = 0;
  const ctx = {
    analyze: async () => {
      analyzeCalls++;
      return null;
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 0 });
  await assert.rejects(() => tools.get_function(0x1000n), {
    name: "AgentToolError",
    code: "function-budget",
  });
  assert.equal(analyzeCalls, 0);
});

test("FunctionLoader: concurrent get() to same address shares inflight and consumes only 1 slot", async () => {
  let analyzeCalls = 0;
  let resolveAnalyze;
  const analyzePromise = new Promise((resolve) => { resolveAnalyze = resolve; });

  const ctx = {
    analyze: async (addr) => {
      analyzeCalls++;
      await analyzePromise;
      return { address: addr, instructions: [] };
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 1 });
  const p1 = tools.get_function(0x1000n);
  const p2 = tools.get_function(0x1000n);

  resolveAnalyze();
  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(analyzeCalls, 1);
  assert.equal(res1.address, 0x1000n);
  assert.equal(res2.address, 0x1000n);

  // Cache hit on same address does not consume extra budget
  const res3 = await tools.get_function(0x1000n);
  assert.equal(analyzeCalls, 1);
  assert.equal(res3.address, 0x1000n);

  // Different address is rejected due to budget=1
  await assert.rejects(() => tools.get_function(0x2000n), {
    name: "AgentToolError",
    code: "function-budget",
  });
});

test("FunctionLoader: ctx.analyze() returning null consumes 1 slot and is cached", async () => {
  let analyzeCalls = 0;
  const ctx = {
    analyze: async () => {
      analyzeCalls++;
      return null;
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 1 });
  const res1 = await tools.get_function(0x1000n);
  assert.equal(res1.found, false);
  assert.equal(analyzeCalls, 1);

  // Cache hit returns found: false without re-calling analyze
  const res2 = await tools.get_function(0x1000n);
  assert.equal(res2.found, false);
  assert.equal(analyzeCalls, 1);

  // Distinct address rejected
  await assert.rejects(() => tools.get_function(0x2000n), {
    code: "function-budget",
  });
});

test("planAnalysisGoal: candidate backend failures stop when maxFunctions reached and report function-budget", async () => {
  let analyzeCalls = 0;
  const ctx = {
    candidateFunctions: [0x1000n, 0x2000n, 0x3000n, 0x4000n],
    analyze: async (addr) => {
      analyzeCalls++;
      throw new Error("disassembly engine crash on malformed function");
    },
  };

  const tools = createAgentTools(ctx, { maxFunctions: 2 });
  const query = {
    action: "find",
    entity: { terms: ["target"] },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: {},
    expect: {},
  };

  const plan = await planAnalysisGoal(query, ctx, {
    tools,
    maxFunctions: 10,
    maxDisassembly: 10000,
    timeoutMs: 5000,
  });

  assert.equal(analyzeCalls, 2, "planner must stop after maxFunctions attempts even if all threw");
  assert.ok(plan.missingEvidence.includes("function-budget"));
  assert.equal(plan.exhausted, true);
  assert.equal(plan.completeness.budgetLimited, true);
  assert.equal(plan.completeness.reason, "function-budget");
});
