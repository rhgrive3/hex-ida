import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ResourceBudget } from '../js/core/budgets/index.js';

// 1. pluginから parent/used/children/scope へ到達できない
{
  const r = new PlatformPluginRegistry();
  let seen = {};
  r.registerAnalyzer('probe', {
    async analyze(ctx) {
      seen = {
        parent: ctx.resourceBudget.parent,
        used: ctx.resourceBudget.used,
        children: ctx.resourceBudget.children,
        scope: ctx.resourceBudget.scope,
        hasConsume: typeof ctx.resourceBudget.consume,
        hasRemaining: typeof ctx.resourceBudget.remaining,
        hasSnapshot: typeof ctx.resourceBudget.snapshot,
      };
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  const res = await r.invoke('analyzer', 'probe', 'analyze', { resourceBudget: root }, {});
  assert.equal(res.ok, true);
  assert.equal(seen.parent, undefined);
  assert.equal(seen.used, undefined);
  assert.equal(seen.children, undefined);
  assert.equal(seen.scope, undefined);
  assert.equal(seen.hasConsume, 'function');
  assert.equal(seen.hasRemaining, 'function');
  assert.equal(seen.hasSnapshot, 'function');
}

// 2. root limit 4 で child plugin が 10 consume すると必ず失敗し、rootは汚染されない
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('greedy', {
    async analyze(ctx) {
      ctx.resourceBudget.consume('bytesRead', 10);
      return { ok: true };
    },
  });
  const root = new ResourceBudget({ bytesRead: 4 });
  const res = await r.invoke('analyzer', 'greedy', 'analyze', { resourceBudget: root }, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /budget/i);
  assert.equal(root.snapshot().used.bytesRead ?? 0, 0);
}

// 3. adversarial mutation (parent切断・used巻き戻し) がrootに届かない
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('attacker', {
    async analyze(ctx) {
      try { ctx.resourceBudget.parent = null; } catch {}
      try { ctx.resourceBudget.used = Object.create(null); } catch {}
      try { ctx.resourceBudget.children = new Map(); } catch {}
      try { ctx.resourceBudget.parent = { used: Object.create(null) }; } catch {}
      ctx.resourceBudget.consume('workUnits', 5);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  const res = await r.invoke('analyzer', 'attacker', 'analyze', { resourceBudget: root }, {});
  assert.equal(res.ok, true);
  // host accountingは単調: pluginの5 unitsがrootへ計上されている
  assert.equal(root.snapshot().used.workUnits, 5);
  // root budgetはその後も正常に機能する
  root.consume('workUnits', 5);
  assert.equal(root.snapshot().used.workUnits, 10);
}

// 4. ctx.read() のconsumptionがroot budgetへ必ず伝播する
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('reader', {
    async analyze(ctx) {
      try { ctx.resourceBudget.parent = null; } catch {}
      await ctx.read(0n, 4);
      return {};
    },
  });
  const root = new ResourceBudget({ bytesRead: 100 });
  const res = await r.invoke('analyzer', 'reader', 'analyze', {
    resourceBudget: root,
    read: async () => Uint8Array.of(1, 2, 3, 4),
    pluginPolicy: { binaryRead: true },
  }, {});
  assert.equal(res.ok, true);
  assert.equal(root.snapshot().used.bytesRead, 4);
}

// 5. 複数invocationでもglobal cumulative budgetをresetできない
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('reset-try', {
    async analyze(ctx) {
      try { ctx.resourceBudget.parent.used.workUnits = 0; } catch {}
      ctx.resourceBudget.consume('workUnits', 6);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 10 });
  assert.equal((await r.invoke('analyzer', 'reset-try', 'analyze', { resourceBudget: root }, {})).ok, true);
  const second = await r.invoke('analyzer', 'reset-try', 'analyze', { resourceBudget: root }, {});
  assert.equal(second.ok, false, 'cumulative 12 > limit 10 must fail');
  assert.equal(root.snapshot().used.workUnits, 6);
}

// 6. facadeはinvocation終了後にrevokeされる
{
  const r = new PlatformPluginRegistry();
  let retained = null;
  r.registerAnalyzer('retain', {
    async analyze(ctx) {
      retained = ctx.resourceBudget;
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  assert.equal((await r.invoke('analyzer', 'retain', 'analyze', { resourceBudget: root }, {})).ok, true);
  assert.throws(() => retained.consume('workUnits', 1), /revoked/i);
}

console.log('issue #5147 plugin resourceBudget facade isolation: PASS');
