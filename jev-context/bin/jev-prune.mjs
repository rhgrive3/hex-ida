#!/usr/bin/env node
import process from "node:process";
import { loadConfig, describeConfig } from "../core/config.mjs";
import { createDecisionCache } from "../core/decision-cache.mjs";
import { clearElisions } from "../core/elision.mjs";
import { createMetrics } from "../core/metrics.mjs";
import { createSettingsStore } from "../core/settings.mjs";
import { createOpenJevClient } from "../core/openjev.mjs";
import {
  installOpenCode,
  uninstallOpenCode,
  installCodex,
  uninstallCodex,
  installAgy,
  uninstallAgy,
  writeCodexProviderSample,
} from "../adapters/install.mjs";

/**
 * jev-prune — the operator surface.
 *
 * Design rule: this command must be safe to run in any terminal, at any time,
 * and must never print a credential. `status` is safe to paste into an issue.
 */

const COMMANDS = [
  "status",
  "on",
  "off",
  "shadow",
  "active",
  "stats",
  "probe",
  "cache",
  "metrics",
  "install",
  "uninstall",
  "proxy",
  "help",
];

const HOSTS = ["opencode", "codex", "agy"];

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function resolveConfig() {
  return loadConfig(process.env);
}

function printStatus() {
  const config = resolveConfig();
  const settings = createSettingsStore({ path: config.statePath }).load();
  const cache = createDecisionCache({ path: config.cachePath, policyVersion: config.policyVersion });
  const cacheSummary = cache.load();
  const metrics = createMetrics({ path: config.metricsPath }).load();

  // The *effective* mode is what actually decides behaviour, and a persisted
  // setting overrides the environment default. Reporting the environment value
  // here would describe a configuration that is not in force.
  const effectiveMode = settings.mode || config.mode;

  const lines = [
    `enabled: ${config.enabled}`,
    `mode: ${effectiveMode}${settings.mode && settings.mode !== config.mode ? ` (persisted; env default ${config.mode})` : settings.mode ? " (persisted)" : " (from environment)"}`,
    "provider: OpenJEV",
    `endpoint: ${config.baseUrl}${config.endpointPath}`,
    `api key: ${config.apiKey.length > 0 ? "present (not shown)" : "MISSING — pruning is fail-open and inert"}`,
    `policy version: ${config.policyVersion}`,
    `evaluated: ${formatNumber(metrics.toolResultsEvaluated)} items`,
    `kept: ${formatNumber(metrics.itemsKept)}`,
    `dropped: ${formatNumber(metrics.itemsDropped)}${
      metrics.shadowEvaluations > 0 ? ` (shadow would-drop: ${formatNumber(metrics.itemsWouldDrop)})` : ""
    }`,
    `decision-cache: ${formatNumber(cacheSummary.size)} entries, protocol hit rate ${
      metrics.cacheHits + metrics.cacheMisses > 0
        ? `${(100 * (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses))).toFixed(1)}%`
        : "n/a"
    }`,
    `main input tokens avoided: ~${formatNumber(metrics.estimatedMainTokensAvoided)}`,
    `context tokens: ${formatNumber(metrics.contextTokensBefore)} -> ${formatNumber(metrics.contextTokensAfter)} (${metrics.removalPercent}% removed)`,
    `OpenJEV calls: ${formatNumber(metrics.openjevCalls)} (input tokens ${formatNumber(metrics.openjevInputTokens)}, output ${formatNumber(metrics.openjevOutputTokens)})`,
    `average OpenJEV latency: ${formatNumber(metrics.averageOpenjevLatencyMs)} ms`,
    `OpenJEV failures: ${formatNumber(metrics.apiFailureCount)}`,
    `timeouts: ${formatNumber(metrics.timeoutCount)}`,
    `fallbacks: ${formatNumber(metrics.fallbackCount)}`,
    `secrets skipped before transmission: ${formatNumber(metrics.skippedUnsafeItems)}`,
    `model calls affected: ${formatNumber(metrics.modelCallsAffected)}`,
    // A dropped item on a host that can rewrite a live result is stashed, not
    // deleted. Say so, so elision is never mistaken for data loss.
    `elided originals kept: ${config.elisionStash ? "yes" : "no (JEV_PRUNING_ELISION_STASH=false)"}`,
    `elision stash: ${config.elisionPath}`,
    `state path: ${config.statePath}`,
    `cache path: ${config.cachePath}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printStats() {
  const config = resolveConfig();
  const metrics = createMetrics({ path: config.metricsPath }).load();
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

function setMode(mode) {
  const config = resolveConfig();
  const store = createSettingsStore({ path: config.statePath });
  const result = store.save({ mode });
  if (!result.saved) {
    process.stderr.write(`failed to persist mode: ${result.error || "unknown error"}\n`);
    return 1;
  }
  process.stdout.write(
    `mode set to ${mode}` +
      (mode === "active" ? " — pruning is now applied to model requests\n" : mode === "shadow" ? " — decisions are recorded but nothing is removed\n" : " — pruning disabled\n"),
  );
  if (!config.apiKey && mode !== "off") {
    process.stderr.write("warning: OPENJEV_API_KEY is not set; all pruning decisions fail open.\n");
  }
  return 0;
}

function clearCache() {
  const config = resolveConfig();
  const cache = createDecisionCache({ path: config.cachePath, policyVersion: config.policyVersion });
  const { removed } = cache.clear();
  process.stdout.write(`decision cache cleared (${formatNumber(removed)} entries removed)\n`);
  const elisions = clearElisions({ path: config.elisionPath });
  process.stdout.write(
    elisions.cleared
      ? `elision stash cleared (${formatNumber(elisions.removed)} elided originals removed)\n`
      : "elision stash could not be cleared\n",
  );
  return 0;
}

function resetMetrics() {
  const config = resolveConfig();
  const metrics = createMetrics({ path: config.metricsPath });
  metrics.reset();
  metrics.save();
  process.stdout.write("metrics reset\n");
  return 0;
}

async function probe() {
  const config = resolveConfig();
  if (!config.apiKey) {
    process.stderr.write("OPENJEV_API_KEY is not set; nothing to probe.\n");
    return 1;
  }
  const client = createOpenJevClient(config);
  const result = await client.probe();
  if (!result.ok) {
    process.stdout.write(`probe: FAILED (${result.reason}) after ${result.latencyMs} ms — pruning will fail open.\n`);
    return 1;
  }
  const answer = result.answers.item_0001_keep || {};
  process.stdout.write(
    `probe: ok in ${result.latencyMs} ms — choice=${answer.choice} confidence=${answer.confidence} ` +
      `input_tokens=${result.usage ? result.usage.input_tokens : "?"}\n`,
  );
  return 0;
}

function installHost(host, options = {}) {
  const results = [];
  if (host === "opencode" || host === "all") results.push(installOpenCode({ root: options.root }));
  if (host === "codex" || host === "all") results.push(installCodex(options));
  if (host === "agy" || host === "all") results.push(installAgy(options));

  for (const result of results) {
    process.stdout.write(`installed ${result.host}: ${result.file}\n`);
    if (result.backup) process.stdout.write(`  backup: ${result.backup}\n`);
    if (result.added && result.added.length > 0) process.stdout.write(`  events registered: ${result.added.join(", ")}\n`);
    if (result.already && result.already.length > 0) process.stdout.write(`  already present: ${result.already.join(", ")}\n`);
  }

  if (host === "codex" || host === "all") {
    const sample = writeCodexProviderSample();
    process.stdout.write(
      `\nTo route Codex model traffic through the pruning proxy, append the block in\n  ${sample}\n` +
        `to $CODEX_HOME/config.toml and set model_provider = "jev-prune".\n` +
        `This is the only Codex surface that can remove items from a model request;\n` +
        `hooks alone cannot. Run \`jev-prune proxy\` before starting Codex.\n`,
    );
  }
  return 0;
}

function uninstallHost(host, options = {}) {
  const results = [];
  if (host === "opencode" || host === "all") results.push(uninstallOpenCode({ root: options.root }));
  if (host === "codex" || host === "all") results.push(uninstallCodex(options));
  if (host === "agy" || host === "all") results.push(uninstallAgy(options));
  for (const result of results) process.stdout.write(`uninstalled ${result.host}: ${result.file}\n`);
  return 0;
}

function runProxy() {
  // Imported lazily so a plain `status` run never opens a listening socket.
  return import("../proxy/server.mjs").then(({ createPruningProxy }) =>
    createPruningProxy()
      .listen()
      .then((server) => {
        const address = server.address();
        process.stdout.write(`jev-prune proxy listening on http://${address.address}:${address.port}\n`);
        return new Promise(() => {});
      }),
  );
}

function printHelp() {
  process.stdout.write(
    [
      "jev-prune — OpenJEV-backed context pruning",
      "",
      "Usage: jev-prune <command>",
      "",
      "  status             show mode, counters and paths (never prints the API key)",
      "  on                 re-enable pruning in shadow mode",
      "  off                disable pruning entirely",
      "  shadow             evaluate and record decisions, but remove nothing",
      "  active             apply decisions to model requests",
      "  stats              print the raw metrics snapshot as JSON",
      "  probe              send one liveness request to OpenJEV",
      "  cache clear        drop all cached decisions",
      "  metrics reset      zero the counters",
      "  install <host>     host: opencode | codex | agy | all",
      "  uninstall <host>   host: opencode | codex | agy | all",
      "  proxy              run the OpenAI-compatible pruning proxy",
      "",
      "Environment: OPENJEV_API_KEY (required), OPENJEV_BASE_URL, JEV_PRUNING_MODE,",
      "JEV_PRUNING_ENABLED, JEV_PRUNING_THRESHOLD_TOKENS, JEV_PRUNING_TIMEOUT_MS,",
      "JEV_PRUNING_MAX_STATE_TOKENS, JEV_PRUNING_MIN_CONFIDENCE, JEV_PRUNING_DROP_PROBABILITY,",
      "JEV_PRUNING_BACKGROUND, JEV_PRUNING_HOME",
      "",
    ].join("\n"),
  );
  return 0;
}

async function main() {
  const [command, subcommand] = process.argv.slice(2);
  switch (command) {
    case "status":
      printStatus();
      return 0;
    case "on": {
      // Re-enabling after `off` must never jump straight to active: pruning
      // resumes in shadow so an operator can inspect decisions first.
      const current = resolveConfig();
      return setMode(current.mode === "off" ? "shadow" : current.mode);
    }
    case "off":
      return setMode("off");
    case "shadow":
      return setMode("shadow");
    case "active":
      return setMode("active");
    case "stats":
      printStats();
      return 0;
    case "probe":
      return probe();
    case "install":
      if (HOSTS.includes(subcommand) || subcommand === "all") return installHost(subcommand, { root: process.cwd() });
      process.stderr.write(`usage: jev-prune install <${HOSTS.join("|")}|all>\n`);
      return 1;
    case "uninstall":
      if (HOSTS.includes(subcommand) || subcommand === "all") return uninstallHost(subcommand, { root: process.cwd() });
      process.stderr.write(`usage: jev-prune uninstall <${HOSTS.join("|")}|all>\n`);
      return 1;
    case "proxy":
      return runProxy();
    case "cache":
      if (subcommand === "clear") return clearCache();
      process.stderr.write("usage: jev-prune cache clear\n");
      return 1;
    case "metrics":
      if (subcommand === "reset") return resetMetrics();
      process.stderr.write("usage: jev-prune metrics reset\n");
      return 1;
    case "help":
    case undefined:
      return printHelp();
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`jev-prune failed: ${String(error && error.message ? error.message : error).slice(0, 300)}\n`);
    process.exit(1);
  });

export { printStatus, setMode, clearCache, probe, installHost, uninstallHost, COMMANDS };
