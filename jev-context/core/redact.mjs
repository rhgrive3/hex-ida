/**
 * Secret redaction for anything that would leave the machine.
 *
 * OpenJEV is an external service. Nothing reaches it before passing through
 * `redact()`. The contract is:
 *
 *  - known secret shapes are replaced with `[REDACTED:<label>]`;
 *  - if a payload *looks* like it carries a credential we cannot positively
 *    identify, it is flagged `suspicious` and the caller MUST keep the item out
 *    of the OpenJEV request entirely (`redactFailClosed`).
 *
 * A secret is never "probably fine". The failure mode of over-redacting is a
 * slightly worse pruning decision; the failure mode of under-redacting is a
 * leaked credential, so the bias is deliberate.
 */

const PATTERNS = [
  // HTTP auth headers.
  { label: "authorization-header", re: /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, replacement: "$1: [REDACTED:authorization-header]" },
  { label: "bearer-token", re: /\b(bearer|token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replacement: "$1 [REDACTED:bearer-token]" },
  { label: "basic-auth", re: /\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}/gi, replacement: "basic [REDACTED:basic-auth]" },

  // Vendor key shapes.
  { label: "openai-key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g },
  { label: "openjev-key", re: /\boj_(?:live|test)\.[A-Za-z0-9._-]{12,}/g },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { label: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: "google-oauth", re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { label: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { label: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{16,}/g },
  { label: "anthropic-key", re: /\bsk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}/g },
  { label: "huggingface-token", re: /\bhf_[A-Za-z0-9]{20,}/g },
  { label: "stripe-key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },

  // Structured credential material.
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "private-key-block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { label: "certificate", re: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g },

  // Cookies.
  { label: "cookie-header", re: /\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, replacement: "$1: [REDACTED:cookie-header]" },

  // KEY=VALUE / key: value assignments whose name says "secret".
  {
    label: "secret-assignment",
    re: /\b([A-Za-z0-9_]*(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_?KEY|AUTH_?TOKEN|SESSION_?ID)[A-Za-z0-9_]*)\s*[:=]\s*("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s'";&|]{6,})/gi,
    replacement: "$1=[REDACTED:secret-assignment]",
  },
  // curl -u user:password
  { label: "curl-userpass", re: /(\s-u\s+)[^\s:]{1,64}:[^\s]{1,128}/g, replacement: "$1[REDACTED:curl-userpass]" },
  // Connection strings with inline credentials.
  { label: "uri-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]{1,64}:[^\s/@]{1,128}@/gi, replacement: "$1[REDACTED:uri-credentials]@" },
];

/** Pre-compiled once; `RegExp` statefulness is avoided by never using `.test` on a global regex. */
const COMPILED = PATTERNS.map((entry) => ({
  label: entry.label,
  // Fresh RegExp per use keeps lastIndex state from leaking across calls.
  source: entry.re.source,
  flags: entry.re.flags.includes("g") ? entry.re.flags : `${entry.re.flags}g`,
  replacement: entry.replacement || "[REDACTED:" + entry.label + "]",
}));

/**
 * Suspicion test for a credential we could not positively identify.
 *
 * Both halves must be present: a word that *names* a credential, and an opaque
 * run long enough to *be* one. Requiring only the word would make every tool
 * result that says "password field" permanently unprunable; requiring only the
 * run would flag ordinary file hashes and build digests.
 */
const CREDENTIAL_WORD_RE = /\b(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)\b/i;
const OPAQUE_RUN_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b|\b[0-9a-fA-F]{40,}\b/;

/** Our own markers must never be treated as residual secret material. */
const MARKER_RE = /\[REDACTED:[a-z0-9-]+\]/g;

function looksSuspicious(text) {
  // Strip our own markers first: `[REDACTED:secret-assignment]` contains the
  // word "secret" and would otherwise re-trigger the check on its own output.
  const scrubbed = String(text ?? "").replace(MARKER_RE, " ");
  return CREDENTIAL_WORD_RE.test(scrubbed) && OPAQUE_RUN_RE.test(scrubbed);
}

/**
 * Redacts credentials from a string.
 *
 * @returns {{ text: string, count: number, labels: string[], suspicious: boolean, changed: boolean }}
 *   `suspicious` is a *fail-closed* hint: the caller must not send `text` to a
 *   third party when it is true and fail-closed mode is on.
 */
export function redact(input) {
  const original = typeof input === "string" ? input : String(input ?? "");
  let text = original;
  let count = 0;
  const labels = new Set();

  for (const pattern of COMPILED) {
    const re = new RegExp(pattern.source, pattern.flags);
    let matched = false;
    text = text.replace(re, (...args) => {
      matched = true;
      // Last argument is the full match; drop offset/input bookkeeping.
      return pattern.replacement;
    });
    if (matched) {
      count += 1;
      labels.add(pattern.label);
    }
  }

  const changed = text !== original;
  // Suspicion is evaluated on the *post-redaction* text in both cases: whatever
  // we successfully removed must not be able to keep the payload flagged, and
  // whatever we failed to remove still can.
  const suspicious = looksSuspicious(text);

  return { text, count, labels: [...labels], suspicious, changed };
}

/** True when the payload must never be forwarded to OpenJEV. */
export function mustNotTransmit(redaction, { failClosed = true } = {}) {
  return Boolean(failClosed && redaction && redaction.suspicious);
}
