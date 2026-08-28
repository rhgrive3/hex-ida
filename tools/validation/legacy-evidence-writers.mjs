import fs from "node:fs";
import path from "node:path";

function stripComments(lines) {
  const code = [];
  let inBlockComment = false;
  for (const raw of lines) {
    let out = "";
    let quote = null;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") break;
      out += ch;
    }
    code.push(out);
  }
  return code;
}

function evidenceStoreBindings(full, rootDir, codeLines) {
  const bindings = new Set(["EvidenceStore"]);
  const evidenceModule = path.resolve(rootDir, "ai/evidence.js");
  const fullCode = codeLines.join('\n');
  const importRegex = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/gs;
  let match;
  while ((match = importRegex.exec(fullCode)) !== null) {
    if (!match[3].startsWith(".")) continue;
    let target = path.resolve(path.dirname(full), match[3]);
    if (!path.extname(target)) target += ".js";
    if (path.normalize(target) !== path.normalize(evidenceModule)) continue;
    for (const specifier of match[1].split(",")) {
      const binding = /^\s*EvidenceStore(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (binding) bindings.add(binding[1] || "EvidenceStore");
    }
  }
  return bindings;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanEvidenceWriters(rootDir = "js") {
  const findings = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        const lines = text.split("\n");
        const codeLines = stripComments(lines);
        const bindings = evidenceStoreBindings(full, rootDir, codeLines);
        const constructorPattern = new RegExp(`\\bnew\\s+(?:${[...bindings].map(escapeRegExp).join("|")})\\s*\\(`);
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          // Remove double and single quoted strings after comment lexing.
          const withoutStrings = codeLines[i].replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '""');
          if (constructorPattern.test(withoutStrings)) {
            findings.push({
              file: full.replace(/\\/g, "/"),
              line: i + 1,
              constructor: "EvidenceStore",
              snippet: trimmed,
            });
          }
        }
      }
    }
  }
  walk(rootDir);
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function validateEvidenceWriters(options = {}) {
  const root = options.root || "js";
  const baselinePath = options.baselinePath || "tools/validation/legacy-evidence-writers-baseline.json";
  const findings = scanEvidenceWriters(root);

  if (options.noBaseline) {
    return { ok: findings.length === 0, findings, violations: findings, stale: [] };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const allowed = baseline.allowed || [];

  const violations = [];
  for (const f of findings) {
    const isAllowed = allowed.some((a) => a.file === f.file && a.snippet === f.snippet);
    if (!isAllowed) violations.push(f);
  }

  const stale = [];
  for (const a of allowed) {
    const isFound = findings.some((f) => f.file === a.file && f.snippet === a.snippet);
    if (!isFound) stale.push(a);
  }

  return {
    ok: violations.length === 0 && stale.length === 0,
    findings,
    violations,
    stale,
  };
}

if (process.argv[1] && process.argv[1].endsWith("legacy-evidence-writers.mjs")) {
  const result = validateEvidenceWriters();
  if (result.violations.length) {
    console.error("FAIL: legacy-evidence-writer-added:", result.violations);
    process.exit(1);
  }
  if (result.stale.length) {
    console.error("FAIL: legacy-evidence-writer-baseline-stale:", result.stale);
    process.exit(1);
  }
  console.log("Legacy evidence writers check: PASS");
}
