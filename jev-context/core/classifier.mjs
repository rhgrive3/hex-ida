/**
 * Stage 1 — deterministic rules.
 *
 * Most of the safety of the whole system lives here, because Stage 1 is the
 * part that runs without any model and therefore cannot be "wrong". Its job is
 * to make the expensive Stage 2 (OpenJEV) call *smaller* and *safer*: anything
 * Stage 1 can settle is never sent to OpenJEV, and anything Stage 1 must keep
 * is kept no matter what OpenJEV would have said.
 *
 * Three outcomes exist:
 *   - `keep`  — an invariant proves it must survive. Never sent to OpenJEV.
 *   - `drop`  — provably redundant (byte-identical duplicate). Never lost,
 *               because an identical survivor stays in the context.
 *   - `ask`   — genuinely ambiguous: an old tool result that may still matter.
 *               This is the only class OpenJEV is asked about.
 */

/** Roles whose content is authored by a human or a platform and is never pruned. */
export const PROTECTED_ROLES = new Set(["system", "developer", "user"]);

/** Tool groups whose old output is usually superseded by the next identical call. */
export const SUPERSEDABLE_GROUPS = new Set(["file", "command", "test", "diff", "status"]);

/**
 * Groups whose newest member is a *live view of state* and must always survive:
 * the current contents of a file, the current diff, the current test result,
 * the current task list. Dropping one of these replaces truth with archaeology.
 */
export const ALWAYS_NEWEST_GROUPS = new Set(["file", "diff", "test", "status"]);

/**
 * True when this item is the survivor of its resource.
 *
 * Important subtlety: the newest member of a *singleton* resource is not
 * meaningfully "newest" — nothing was superseded — so for ordinary command or
 * search output a unique resource key grants no protection at all. Otherwise
 * every distinct `bash` invocation would be permanently unprunable.
 */
export function isProtectedNewest(item, { newestIdByResource, countsByResource }) {
  const resourceKey = item.meta && item.meta.resourceKey;
  if (!resourceKey) return false;
  if (newestIdByResource.get(resourceKey) !== item.id) return false;
  const group = (item.meta && item.meta.group) || "other";
  if (ALWAYS_NEWEST_GROUPS.has(group)) return true;
  return (countsByResource.get(resourceKey) || 0) > 1;
}

const UNRESOLVED_FAILURE_RE =
  /(?:^|\n)[ \t]*(?:Error|ERROR|error|fatal|panic|Traceback|FAILED|Failed|AssertionError|Exception|TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES)\b|error\[E[0-9]+\]|\bexit code [1-9][0-9]*\b|\bexit=[1-9][0-9]*\b|\bnon-zero exit\b|\bcommand failed\b/i;

const SUCCESS_RE =
  /\bexit code 0\b|\bexit=0\b|\b0 errors?\b|\ball tests? passed\b|\bPASS\b|\bpassed\b|\bSuccess\b|\bok\b/i;

const VERBOSE_RE =
  /\b(?:npm install|npm ci|yarn install|pnpm install|added \d+ packages|Downloading|Fetching|Resolving|Progress:|\d+% \||installing|Building|Compiling|Waiting for|Retrying)\b/i;

const REPETITIVE_PROGRESS_RE = /(?:^|\n)[ \t]*[^\n]{0,80}(?:\d+%|\b\d+\/\d+\b)[^\n]{0,80}(?:\n|$)/g;

/**
 * Detects output that is almost entirely progress/verbose noise, i.e. text whose
 * informational content is already carried by a result summary line.
 */
export function looksVerbose(text) {
  if (!text) return false;
  const lines = text.split("\n");
  if (lines.length < 20) return false;
  const progress = (text.match(REPETITIVE_PROGRESS_RE) || []).length;
  const noise = VERBOSE_RE.test(text) ? 1 : 0;
  return progress >= 5 || (noise === 1 && lines.length > 60);
}

/** Detects the presence of a failure marker that has not been superseded. */
export function containsFailure(text) {
  return UNRESOLVED_FAILURE_RE.test(String(text ?? ""));
}

/** Detects an explicit success marker. */
export function containsSuccess(text) {
  return SUCCESS_RE.test(String(text ?? ""));
}

/**
 * Index of the first volatile (tool) item. Everything before it is the stable
 * prefix — system/developer/project instructions and the opening user turn —
 * which is forwarded byte-for-byte so the provider's prompt cache still hits.
 */
export function protectedPrefixEnd(items) {
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].role === "tool") return i;
  }
  return items.length;
}

/**
 * Classifies a single item with rules only (no model, no network).
 *
 * @returns {{ action: "keep"|"drop"|"ask", reason: string, flags: Record<string, boolean> }}
 */
export function classifyItem(item, context) {
  const {
    index,
    total,
    prefixEnd,
    latestIndexByDigest,
    latestIndexByResource,
    countsByDigest,
    countsByResource,
    keepRecentItems,
  } = context;

  const flags = {
    protectedRole: PROTECTED_ROLES.has(item.role),
    recent: index >= total - keepRecentItems,
    inPrefix: index < prefixEnd,
    secretFailClosed: Boolean(item.flags && item.flags.secretFailClosed),
    duplicate: false,
    superseded: false,
    unresolvedFailure: false,
    verbose: false,
    search: false,
    fileSnapshot: false,
    resourceNewest: false,
  };

  // ---- Invariants that always win -----------------------------------------
  if (item.role !== "tool") {
    return { action: "keep", reason: "non-tool content is never pruned", flags };
  }
  if (flags.inPrefix) {
    return { action: "keep", reason: "inside the stable prompt prefix", flags };
  }
  if (flags.secretFailClosed) {
    return { action: "keep", reason: "likely credential that could not be safely redacted", flags };
  }
  if (flags.recent) {
    return { action: "keep", reason: "within the recent working window", flags };
  }

  const text = item.text || "";
  const group = (item.meta && item.meta.group) || "other";
  const resourceKey = (item.meta && item.meta.resourceKey) || null;

  const newestForResource = resourceKey ? latestIndexByResource.get(resourceKey) : undefined;
  const newestForDigest = latestIndexByDigest.get(item.digest);
  flags.resourceNewest = isProtectedNewest(item, { newestIdByResource: latestIndexByResource, countsByResource });
  flags.superseded = Boolean(resourceKey) && SUPERSEDABLE_GROUPS.has(group) && newestForResource !== index;
  flags.duplicate = countsByDigest.get(item.digest) > 1 && newestForDigest !== index;
  flags.verbose = looksVerbose(text);
  flags.search = group === "search";
  flags.fileSnapshot = group === "file";
  flags.unresolvedFailure = containsFailure(text);
  flags.resolvedFailure = flags.unresolvedFailure && containsSuccess(text);

  // ---- Deterministic drops -------------------------------------------------
  // A byte-identical duplicate is the only thing we drop without asking: an
  // identical copy survives elsewhere in the same context, so no information is
  // lost and the model never sees a hole.
  if (flags.duplicate && !flags.unresolvedFailure && !latestIsFailure(context, item.digest)) {
    return { action: "drop", reason: "byte-identical duplicate of a later item", flags };
  }

  // ---- Invariants that force a keep ---------------------------------------
  // An unresolved failure is the single most expensive thing to lose.
  if (flags.unresolvedFailure && !isSupersededBySuccess(context, item)) {
    return { action: "keep", reason: "unresolved failure still relevant", flags };
  }
  if (item.flags && item.flags.containsUserConstraint) {
    return { action: "keep", reason: "carries a user constraint", flags };
  }
  if (item.flags && item.flags.isCurrentEdit || item.flags && item.flags.isLatestDiff) {
    return { action: "keep", reason: "current edit or latest diff", flags };
  }
  // The newest snapshot of a resource must always survive, even if Stage 2
  // would have been willing to drop an older one.
  if (flags.resourceNewest) {
    return { action: "keep", reason: "newest snapshot for its resource", flags };
  }
  // Search results are cheap to misjudge: a symbol found by an old grep may be
  // needed much later. Never drop one deterministically.
  if (flags.search) {
    return { action: "ask", reason: "old search result may still be referenced", flags };
  }

  // ---- Ambiguous: hand to OpenJEV -----------------------------------------
  if (flags.superseded) {
    return { action: "ask", reason: "superseded by a newer snapshot of the same resource", flags };
  }
  if (flags.verbose) {
    return { action: "ask", reason: "verbose progress output with a summary elsewhere", flags };
  }
  if (group === "install") {
    return { action: "ask", reason: "bulk package install output", flags };
  }
  if (flags.fileSnapshot) {
    return { action: "ask", reason: "older file snapshot", flags };
  }
  return { action: "ask", reason: "aged tool result of uncertain relevance", flags };
}

function latestIsFailure(context, digest) {
  const latestIndex = context.latestIndexByDigest.get(digest);
  const latest = context.items[latestIndex];
  return Boolean(latest && containsFailure(latest.text || ""));
}

function isSupersededBySuccess(context, item) {
  const resourceKey = item.meta && item.meta.resourceKey;
  if (!resourceKey) return false;
  const newestIndex = context.latestIndexByResource.get(resourceKey);
  if (newestIndex === undefined || newestIndex === context.index) return false;
  const newest = context.items[newestIndex];
  return Boolean(newest && containsSuccess(newest.text || "") && !containsFailure(newest.text || ""));
}

/**
 * Groups whose *fresh* output may be elided when a host judges it at the moment
 * it is produced. Deliberately narrow: `file` and `diff` are excluded because a
 * brand-new read or edit is the current truth about a resource and there is no
 * later snapshot to supersede it, and `status` is excluded because it carries
 * the task plan.
 */
export const WRITE_TIME_DROPPABLE_GROUPS = new Set(["command", "test", "install", "search", "other"]);

/**
 * Stage 1 for the write-time path.
 *
 * Some hosts can only judge a tool result *as it is produced* — Agy 1.2.7's
 * `PostToolUse` hook rewrites it via `overwrite_result`, and there is no second
 * chance to revisit older items. That changes what is provably safe:
 *
 *   - The "recent working window" protection does not apply, because the item
 *     under judgement *is* the newest one by construction. Applying it would
 *     make the path structurally incapable of ever dropping anything.
 *   - `newest snapshot` protection likewise cannot apply for the same reason.
 *   - Freshness means the supersession arms (`superseded`, `fileSnapshot`) can
 *     never fire, so the only deterministic drop left is a byte-identical
 *     duplicate — which is still lossless, because the earlier copy it
 *     duplicates is already in the context.
 *
 * Everything else is `ask`, and the pruning policy's write-time veto list is
 * what decides whether a drop is genuinely permitted.
 */
export function classifyWriteTimeItem(item, context = {}) {
  const flags = {
    protectedRole: PROTECTED_ROLES.has(item.role),
    writeTime: true,
    duplicate: false,
    groupDroppable: false,
    unresolvedFailure: false,
    verbose: false,
    secretFailClosed: Boolean(item.flags && item.flags.secretFailClosed),
  };

  if (item.role !== "tool") {
    return { action: "keep", reason: "non-tool content is never pruned", flags };
  }
  if (flags.secretFailClosed) {
    return { action: "keep", reason: "likely credential that could not be safely redacted", flags };
  }

  const text = String(item.text || "");
  const group = (item.meta && item.meta.group) || "other";
  const groupDroppable = WRITE_TIME_DROPPABLE_GROUPS.has(group) || group === "install";
  flags.groupDroppable = groupDroppable;
  flags.unresolvedFailure = containsFailure(text);
  flags.verbose = looksVerbose(text);
  // Strictly greater than one: `countsByDigest` counts this item too, and a
  // count of one means this is its first appearance, not a repeat.
  flags.duplicate = ((context.countsByDigest && context.countsByDigest.get(item.digest)) || 0) > 1;

  // Lossless: an identical item already sits in the session before this one.
  if (flags.duplicate) {
    return { action: "drop", reason: "byte-identical duplicate of an earlier result", flags };
  }

  if (flags.unresolvedFailure) {
    return { action: "keep", reason: "unresolved failure still relevant", flags };
  }
  if (item.flags && item.flags.containsUserConstraint) {
    return { action: "keep", reason: "carries a user constraint", flags };
  }
  if ((item.flags && item.flags.isCurrentEdit) || (item.flags && item.flags.isLatestDiff)) {
    return { action: "keep", reason: "current edit or latest diff", flags };
  }
  if (!groupDroppable) {
    return { action: "keep", reason: `fresh ${group} output is current state`, flags };
  }
  if (flags.verbose) {
    return { action: "ask", reason: "verbose progress output whose summary is elsewhere", flags };
  }
  return { action: "ask", reason: "fresh tool output of uncertain future relevance", flags };
}

/**
 * Runs Stage 1 over a whole item list and returns per-item verdicts plus the
 * context map later stages reuse.
 */
export function classifyAll(items, options = {}) {
  const keepRecentItems = options.keepRecentItems ?? 6;
  const prefixEnd = protectedPrefixEnd(items);

  const latestIndexByDigest = new Map();
  const latestIndexByResource = new Map();
  const countsByDigest = new Map();
  const countsByResource = new Map();

  items.forEach((item, index) => {
    latestIndexByDigest.set(item.digest, index);
    countsByDigest.set(item.digest, (countsByDigest.get(item.digest) || 0) + 1);
    const resourceKey = item.meta && item.meta.resourceKey;
    if (resourceKey) {
      latestIndexByResource.set(resourceKey, index);
      countsByResource.set(resourceKey, (countsByResource.get(resourceKey) || 0) + 1);
    }
  });

  const context = {
    items,
    total: items.length,
    prefixEnd,
    latestIndexByDigest,
    latestIndexByResource,
    countsByDigest,
    countsByResource,
    keepRecentItems,
  };

  const verdicts = items.map((item, index) =>
    Object.assign(classifyItem(item, { ...context, index }), { index, id: item.id }),
  );

  return { verdicts, context };
}
