import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ResourceBudget } from '../js/core/budgets/index.js';

// 1. 同じanalyzerを同じrootで2回invokeしてもrootへfallbackしない
{
  const r = new PlatformPluginRegistry();
  const seen = [];
  r.registerAnalyzer('demo', {
    async analyze(ctx) {
      seen.push(ctx.resourceBudget.scopePath);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  assert.equal((await r.invoke('analyzer', 'demo', 'analyze', { resourceBudget: root }, {})).ok, true);
  assert.equal((await r.invoke('analyzer', 'demo', 'analyze', { resourceBudget: root }, {})).ok, true);
  assert.deepEqual(seen, ['root/analyzer.demo.analyze', 'root/analyzer.demo.analyze']);
}

// 2. 10回連続invokeでも全回plugin-specific scope contractを維持
{
  const r = new PlatformPluginRegistry();
  const seen = [];
  r.registerAnalyzer('rep', {
    async analyze(ctx) {
      seen.push(ctx.resourceBudget.scopePath);
      ctx.resourceBudget.consume('workUnits', 1);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  for (let i = 0; i < 10; i++) {
    assert.equal((await r.invoke('analyzer', 'rep', 'analyze', { resourceBudget: root }, {})).ok, true);
  }
  assert.ok(seen.every((p) => p === 'root/analyzer.rep.analyze'));
  assert.equal(root.snapshot().used.workUnits, 10);
}

// 3. concurrent invocationでもscope identity/accountingが衝突しない
{
  const r = new PlatformPluginRegistry();
  const seen = [];
  r.registerAnalyzer('conc', {
    async analyze(ctx) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(ctx.resourceBudget.scopePath);
      ctx.resourceBudget.consume('workUnits', 1);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  const results = await Promise.all([
    r.invoke('analyzer', 'conc', 'analyze', { resourceBudget: root }, {}),
    r.invoke('analyzer', 'conc', 'analyze', { resourceBudget: root }, {}),
    r.invoke('analyzer', 'conc', 'analyze', { resourceBudget: root }, {}),
  ]);
  assert.ok(results.every((res) => res.ok));
  assert.ok(seen.every((p) => p === 'root' || p.startsWith('root/analyzer.conc.analyze')));
  assert.ok(!seen.includes('root'), 'must never fall back to root scope');
  assert.equal(root.snapshot().used.workUnits, 3);
}

// 4. recursive snapshotでplugin usage attributionが維持される
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('attr', {
    async analyze(ctx) {
      ctx.resourceBudget.consume('workUnits', 7);
      return {};
    },
  });
  const root = new ResourceBudget({ workUnits: 100 });
  await r.invoke('analyzer', 'attr', 'analyze', { resourceBudget: root }, {});
  await r.invoke('analyzer', 'attr', 'analyze', { resourceBudget: root }, {});
  const snap = root.snapshot({ recursive: true });
  const child = snap.children.find((c) => c.name === 'analyzer.attr.analyze');
  assert.ok(child, 'method scope must exist');
  assert.equal(child.used.workUnits, 14);
}

// 5. scope作成失敗はrootへのsilent fallbackにしない (fail-closed)
{
  const r = new PlatformPluginRegistry();
  let pluginRan = false;
  r.registerAnalyzer('noscope', {
    async analyze(ctx) {
      pluginRan = true;
      try { ctx.resourceBudget.consume('workUnits', 1); } catch {}
      return {};
    },
  });
  const brokenBudget = {
    scope() { throw new Error('scope-unavailable'); },
    consume() { throw new Error('must-not-reach-root-consume'); },
    remaining() { return 0; },
    snapshot() { return {}; },
  };
  const res = await r.invoke('analyzer', 'noscope', 'analyze', { resourceBudget: brokenBudget }, {});
  assert.equal(res.ok, false, 'scope failure must fail closed');
  assert.equal(pluginRan, false, 'plugin must not run without a proper scope');
}

console.log('issue #5151 plugin budget scope reuse without root fallback: PASS');
