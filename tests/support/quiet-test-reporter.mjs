const MACHINE_LINE = /^[A-Z][A-Z0-9_]*=/;
const MAX_CONTEXT_CHARS = 16 * 1024;
const MAX_ERROR_CHARS = 24 * 1024;

function tail(text, limit) {
  const value = String(text ?? "");
  return value.length <= limit ? value : value.slice(-limit);
}

function machineLines(message) {
  return String(message ?? "")
    .split(/\r?\n/)
    .filter((line) => MACHINE_LINE.test(line));
}

function failureText(error) {
  const cause = error?.cause;
  const primary = cause && typeof cause === "object" ? cause : error;
  const text = primary?.stack
    || error?.stack
    || primary?.message
    || error?.message
    || String(primary ?? error ?? "unknown test failure");
  return tail(text, MAX_ERROR_CHARS);
}

function location(data) {
  if (!data?.file) return "";
  const line = Number.isInteger(data.line) ? `:${data.line}` : "";
  const column = Number.isInteger(data.column) ? `:${data.column}` : "";
  return ` (${data.file}${line}${column})`;
}

/**
 * Low-token Node test reporter.
 *
 * Default mode emits nothing for passing tests. On failure it emits only the
 * failing test, a bounded tail of recent test output, and the assertion/error
 * stack. Machine mode additionally forwards explicit UPPER_CASE=value proof
 * records so release verifiers can consume large ledgers without restoring the
 * normal per-test chatter.
 */
export default async function* quietTestReporter(source) {
  const machine = process.env.HEX_TEST_REPORTER_MACHINE === "1";
  let recentOutput = "";

  for await (const event of source) {
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      const message = String(event.data?.message ?? "");
      recentOutput = tail(recentOutput + message, MAX_CONTEXT_CHARS);
      if (machine && event.type === "test:stdout") {
        const lines = machineLines(message);
        if (lines.length) yield `${lines.join("\n")}\n`;
      }
      continue;
    }

    if (event.type !== "test:fail") continue;
    const error = event.data?.details?.error;
    // Node reports the containing file as failed after a child test fails. The
    // child failure already contains the useful assertion, so do not duplicate it.
    if (error?.failureType === "subtestsFailed") continue;

    yield `FAIL ${event.data?.name ?? "unnamed test"}${location(event.data)}\n`;
    const context = recentOutput.trim();
    if (context) {
      yield `--- recent test output ---\n${context}\n--- end recent test output ---\n`;
    }
    yield `${failureText(error)}\n`;
    recentOutput = "";
  }
}
