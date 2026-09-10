/* Recoverable Dev tool failures must stay inside the Supervisor decision loop.
   A tool that throws is evidence for the next decision, not a reason to end the
   run. Only cancellation and explicitly fatal invariant/security/runtime
   corruption failures are terminal. */

export const DEV_TOOL_ERROR_HISTORY_KIND = 'tool-error';
export const DEV_TOOL_ERROR_RECOVERY_BUDGET = 6;

export const DEV_TERMINAL_TOOL_ERROR_CODES = Object.freeze([
  'dev-extension-untrusted',
  'dev-extension-integrity-mismatch',
  'dev-extension-version-mismatch',
  'dev-extension-tool-call-active',
  'dev-bootstrap-identity-mismatch',
  'dev-runtime-corruption',
  'dev-security-violation',
  'dev-invariant-violation',
]);

const TERMINAL_CODES = new Set(DEV_TERMINAL_TOOL_ERROR_CODES);
const TERMINAL_CODE_PREFIXES = Object.freeze(['dev-security-', 'dev-invariant-', 'dev-runtime-corruption']);
const ABORT_CODES = new Set(['cancelled', 'ABORT_ERR', 'dev-run-cancelled']);
const SENSITIVE_KEY = /(token|secret|password|passphrase|credential|cookie|authorization|api[-_]?key|session[-_]?key|nonce)/i;
const REDACTED = '[redacted]';
const MAX_TEXT_CHARS = 160;
const MAX_MESSAGE_CHARS = 512;
const MAX_KEYS = 24;
const MAX_ITEMS = 12;
const MAX_DEPTH = 3;

export function isDevToolAbort(error) {
  if (!error) return false;
  if (String(error.name || '') === 'AbortError') return true;
  return ABORT_CODES.has(String(error.code || ''));
}

/* Terminal failures are enumerated on purpose: anything not named here is
   handed back to the Supervisor instead of failing the whole run. */
export function isTerminalDevToolError(error) {
  if (isDevToolAbort(error)) return true;
  if (error?.fatal === true) return true;
  const code = String(error?.code || '');
  if (!code) return false;
  if (TERMINAL_CODES.has(code)) return true;
  return TERMINAL_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/* Provider-bound history must not carry tool-controlled free-form text
   (#5137): the issue's exact counterexample (`Authorization failed: <secret>`)
   proves key-name/value patterns cannot certify an arbitrary message
   secret-free, so the boundary withholds raw diagnostic text entirely and
   carries only the failure class (code/name) plus fixed guidance. Free-form
   text stays in local diagnostics (describeDevToolError). */
export const DEV_TOOL_ERROR_SAFE_MESSAGE
  = 'Dev tool failed. Raw diagnostic text is withheld from provider-bound history; the failure class is in code.';

export function describeDevToolError(error) {
  const name = String(error?.name || '').trim();
  const code = String(error?.code || '').trim() || name || 'dev-tool-error';
  /* Local diagnostic representation: error text is tool/transport-controlled
     untrusted input, so credential-shaped values are removed before the text
     reaches even local consumers, and the result stays bounded by
     MAX_MESSAGE_CHARS. Provider-bound history never uses this message. */
  const rawMessage = String(error?.message || error || 'Dev tool failed.');
  const message = redactSensitiveText(rawMessage).slice(0, MAX_MESSAGE_CHARS);
  return Object.freeze({ code, name: name || null, message });
}

/* Redact secret-bearing values from free-form error text. Key-name patterns
   alone cannot identify a secret inside a sentence, so redaction pairs the
   key pattern with its value assignment (`key=value`, `key: value`) and
   credential-shaped `bearer/basic/token <value>` forms. Everything else is
   preserved so normal diagnostics stay readable. */
const SECRET_VALUE_PATTERNS = Object.freeze([
  // Credential scheme forms first, so `authorization=Bearer <token>` loses the
  // token before the key=value pass redacts the remaining assignment.
  /\b(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  new RegExp(`(?:${SENSITIVE_KEY.source})\\s*[=:]\\s*("[^"]*"|'[^']*'|\\S+)`, 'gi'),
]);

function redactSensitiveText(text) {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, () => REDACTED);
  }
  return redacted;
}

export function sanitizeDevToolArguments(value) {
  return Object.freeze(sanitizeValue(value, 0));
}

export function createDevToolErrorHistoryEntry({ tool, purpose = null, error, attempt, remaining }) {
  const described = describeDevToolError(error);
  return {
    kind: DEV_TOOL_ERROR_HISTORY_KIND,
    tool: String(tool || ''),
    purpose: purpose == null ? null : String(purpose),
    code: described.code,
    message: DEV_TOOL_ERROR_SAFE_MESSAGE,
    recoverable: true,
    attempt,
    remainingRecoveries: remaining,
    guidance: 'このツール呼び出しだけが失敗した。runは継続している。同じツールの再試行・別ツールへの切り替え・状態の再観測のいずれかを選び、次のdecisionを1つ返すこと。',
  };
}

function sanitizeValue(value, depth) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array:${value.length}]`;
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[object]';
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_KEYS) {
      Object.defineProperty(out, '[truncated]', {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      break;
    }
    count += 1;
    const sanitizedItem = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, depth + 1);
    Object.defineProperty(out, key, {
      value: sanitizedItem,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function truncate(text) {
  const value = String(text);
  return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}…[+${value.length - MAX_TEXT_CHARS}]` : value;
}
