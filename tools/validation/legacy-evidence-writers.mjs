import fs from "node:fs";
import path from "node:path";

function stripComments(lines) {
  const code = [];
  let inBlockComment = false;
  let quote = null;
  let escaped = false;
  for (const raw of lines) {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; i += 1; }
        continue;
      }
      if (quote) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i += 1; continue; }
      if (ch === "/" && next === "/") break;
      out += ch;
    }
    // Ordinary quoted strings cannot continue across lines. Template literals can.
    if (quote !== '`') { quote = null; escaped = false; }
    code.push(out);
  }
  return code;
}

/* Return only syntactic-looking static import statements whose `import` token
 * occurs outside comments and string/template literals. This intentionally is a
 * small lexer rather than a regex over the whole source: a string containing
 * `import * as evidence ...` must never create a validation binding. */
function importStatements(text) {
  const out = [];
  let i = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; i++; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 2; } else i++; continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      i++; continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i++; continue; }
    if (text.startsWith('import', i)
      && !/[\w$]/.test(text[i - 1] || '')
      && !/[\w$]/.test(text[i + 6] || '')) {
      const start = i;
      let j = i + 6, q = null, esc = false, lc = false, bc = false;
      for (; j < text.length; j++) {
        const c = text[j], n = text[j + 1];
        if (lc) { if (c === '\n') lc = false; continue; }
        if (bc) { if (c === '*' && n === '/') { bc = false; j++; } continue; }
        if (q) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === q) q = null;
          continue;
        }
        if (c === '/' && n === '/') { lc = true; j++; continue; }
        if (c === '/' && n === '*') { bc = true; j++; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === ';') { j++; break; }
        // Static imports without semicolons end at a newline once the quoted
        // module specifier has closed. Multiline named imports keep scanning.
        if (c === '\n' && /\bfrom\s*["'][^"']+["']\s*$/.test(text.slice(start, j))) break;
      }
      out.push(text.slice(start, j));
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function evidenceStoreBindings(full, rootDir, sourceText) {
  const bindings = new Set(["EvidenceStore"]);
  const evidenceModule = path.resolve(rootDir, "ai/evidence.js");
  const resolvesToEvidenceModule = (specifier) => {
    if (!specifier.startsWith(".")) return false;
    let target = path.resolve(path.dirname(full), specifier);
    if (!path.extname(target)) target += ".js";
    return path.normalize(target) === path.normalize(evidenceModule);
  };

  let match;
  for (const statement of importStatements(sourceText)) {
    const named = /^\s*import\s*\{([\s\S]*?)\}\s*from\s*(["'])([^"']+)\2\s*;?\s*$/.exec(statement);
    if (named && resolvesToEvidenceModule(named[3])) {
      for (const specifier of named[1].split(",")) {
        const binding = /^\s*EvidenceStore(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
        if (binding) bindings.add(binding[1] || "EvidenceStore");
      }
    }
    const namespace = /^\s*import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*(["'])([^"']+)\2\s*;?\s*$/.exec(statement);
    if (namespace && resolvesToEvidenceModule(namespace[3])) bindings.add(`${namespace[1]}.EvidenceStore`);
  }
  return bindings;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotedStrings(line) {
  let out = '';
  let quote = null, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
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
        const bindings = evidenceStoreBindings(full, rootDir, text);
        const alternatives = [...bindings].map(escapeRegExp);
        if (!alternatives.length) continue;
        const constructorPattern = new RegExp(`\\bnew\\s+(?:${alternatives.join("|")})\\s*\\(`);
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          const withoutStrings = stripQuotedStrings(codeLines[i]);
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
