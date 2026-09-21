import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Recoverable elision.
 *
 * Some hosts expose an extension point that rewrites a tool result *before the
 * model ever sees it* — Agy 1.2.7's `PostToolUse` hook (`overwrite_result`) and
 * the OpenAI-compatible proxy both do. When such a host drops an item, this
 * module replaces it with a bounded marker and stashes the verbatim original
 * locally, so:
 *
 *   - a drop costs a few tokens instead of thousands,
 *   - the content is still recoverable (the marker names the file), and
 *   - nothing is deleted: the host's own session store, and our stash, both
 *     still hold the full text.
 *
 * Two rules make this safe:
 *   1. If stashing is requested but the write fails, elision is *refused*. We
 *      fall back to keeping the content rather than losing it.
 *   2. The marker never contains a secret-shaped excerpt: the excerpt is run
 *      through its own shape check and dropped entirely if it looks like a
 *      credential.
 */

const EXCERPT_LINE_MAX = 200;

/** Detects credential-shaped text so it never lands in a marker. */
function looksSecretish(text) {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(?:sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}/.test(text) ||
    /\b(?:eyJ[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}/.test(text) ||
    /\b(?:authorization|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S{8,}/i.test(text)
  );
}

function firstMeaningfulLine(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line.length > EXCERPT_LINE_MAX ? `${line.slice(0, EXCERPT_LINE_MAX)}…` : line;
  }
  return "";
}

/**
 * Builds the marker that takes a dropped item's place.
 *
 * @returns {string} a short, self-describing replacement
 */
export function elisionMarker(item, options = {}) {
  const original = typeof item.text === "string" ? item.text : "";
  const lines = original ? original.split(/\r?\n/).length : 0;
  const digest = crypto.createHash("sha256").update(original).digest("hex").slice(0, 12);

  const parts = [
    `[jev-prune: elided ${item.tokens ?? 0} tokens / ${original.length} chars / ${lines} lines`,
    `${item.tool || item.role || "tool"}, sha256:${digest}]`,
  ];

  const excerptChars = Number(options.excerptChars) || 0;
  if (excerptChars > 0 && original) {
    const line = firstMeaningfulLine(original);
    if (line && !looksSecretish(line)) {
      const clipped = line.length > excerptChars ? `${line.slice(0, excerptChars)}…` : line;
      parts.push(`first line: ${clipped}`);
    }
  }

  if (options.stashPath) {
    parts.push(`full text kept locally at: ${options.stashPath}`);
    parts.push("read that file if you need the elided output");
  } else {
    parts.push("pruned as stale/duplicate; rerun the command if you need it");
  }

  return parts.join(" | ");
}

/**
 * Stashes an item's verbatim text and returns the marker to put in its place.
 *
 * @returns {{ok: boolean, marker?: string, stashPath?: string, reason?: string}}
 */
export function elideItem(item, options = {}) {
  const config = options.config || {};
  const original = typeof item.text === "string" ? item.text : "";
  const excerptChars = Number(options.excerptChars ?? config.elisionExcerptChars ?? 0);

  let stashPath = null;

  if (config.elisionStash) {
    const root = config.elisionPath;
    if (!root) return { ok: false, reason: "no-elision-path" };
    try {
      // Group by session so an operator can wipe one session's stash, and key by
      // the item's decision digest so re-stashing the same content is idempotent.
      const safeScope = String(options.scope || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const dir = path.join(root, safeScope);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(item.digest || "item").slice(0, 24)}.txt`);
      if (!fs.existsSync(file)) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, original, { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      stashPath = file;
    } catch {
      // Refusing the elision is the fail-open path: keeping the content is
      // always safe, losing it is not.
      return { ok: false, reason: "stash-failed" };
    }
  }

  return {
    ok: true,
    marker: elisionMarker(item, { stashPath, excerptChars }),
    stashPath,
  };
}

/** Removes stashed originals. Used by `jev-prune cache clear`. */
export function clearElisions(options = {}) {
  const root = options.path;
  if (!root) return { cleared: false };
  try {
    if (!fs.existsSync(root)) return { cleared: true, removed: 0 };
    let removed = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) {
        removed += fs.readdirSync(target).length;
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
        removed += 1;
      }
    }
    return { cleared: true, removed };
  } catch {
    return { cleared: false };
  }
}
