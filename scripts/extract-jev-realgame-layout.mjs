#!/usr/bin/env node
// extract-struct-layout.mjs — durable, evaluation-only structural layout extractor.
//
// Purpose: derive authoritative C++ class/struct member layouts (name, byte offset,
// size, declared type, access, nesting path) from a debug object file that is
// build-id-identical to the frozen evaluation binary.
//
// It drives `gdb -batch -nx -ex "file <debug-file>"` and parses `ptype /o <class>`.
// It never touches the repository, never makes network calls, and never queries Jev.
//
// Usage:
//   node extract-struct-layout.mjs \
//     --debug-file <path-to-elf-with-DWARF> \
//     --class Vehicle --class GroundVehicleCache \
//     [--classes-file <file-with-one-class-per-line>] \
//     --out <output.json> --source-label <human label> \
//     [--binary-sha256 <sha>] [--build-id <id>] [--gdb <gdb-path>] [--timeout-ms N]
//
// Exit code 0 when the run completed and the output was written; non-zero on hard
// failure. Per-class failures (type not found) are recorded in the JSON, not fatal.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCESS_RE = /^(private|protected|public)\s*:\s*$/;
const MEMBER_RE = /^\/\*\s*(\d+)\s*\|\s*(\d+)\s*\*\/\s*(.*)$/;
const BITFIELD_HEADER_RE = /\/\*\s*bit offset\s*\|/;
const TOTAL_SIZE_RE = /\/\* total size \(bytes\):\s*\d+\s*\*\//;
const HOLE_RE = /\/\* XXX/;

function parseArgs(argv) {
  const opts = { classes: [], gdb: 'gdb', timeoutMs: 900000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--debug-file': opts.debugFile = argv[++i]; break;
      case '--class': opts.classes.push(argv[++i]); break;
      case '--classes-file': opts.classesFile = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--source-label': opts.sourceLabel = argv[++i]; break;
      case '--binary-sha256': opts.binarySha256 = argv[++i]; break;
      case '--build-id': opts.buildId = argv[++i]; break;
      case '--gdb': opts.gdb = argv[++i]; break;
      case '--timeout-ms': opts.timeoutMs = Number(argv[++i]); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function usage() {
  return [
    'usage: node extract-struct-layout.mjs --debug-file <elf> --out <json> [--class Name ...]',
    '       [--classes-file <file>] [--source-label <label>] [--binary-sha256 <sha>]',
    '       [--build-id <id>] [--gdb gdb] [--timeout-ms N]',
  ].join('\n');
}

// The member name is the trailing identifier (optionally with array suffix).
const NAME_RE = /([A-Za-z_$][A-Za-z0-9_$]*\s*(?:\[\s*\d*\s*\])*)\s*$/;

function splitDecl(decl) {
  const trimmed = decl.trim().replace(/;$/, '').trim();
  const m = NAME_RE.exec(trimmed);
  if (!m) return { type: trimmed, name: null };
  const name = m[1].replace(/\s*\[\s*(\d*)\s*\]/g, (_, n) => `[${n}]`);
  return { type: trimmed.slice(0, m.index).trim(), name };
}

export function parsePtypeOutput(text) {
  const lines = text.split('\n');
  const root = { kind: 'root', offset: null, size: null, name: null, head: null, access: null, children: [] };
  const stack = [root];
  let bitfield = false;
  let headerSeen = false;

  const top = () => stack[stack.length - 1];

  for (const raw of lines) {
    if (BITFIELD_HEADER_RE.test(raw)) { bitfield = true; continue; }
    if (bitfield) continue;
    if (TOTAL_SIZE_RE.test(raw)) continue;
    if (HOLE_RE.test(raw)) continue;
    if (/\/\* offset\s*\|/.test(raw) && /type = /.test(raw)) {
      const head = raw.slice(raw.indexOf('type = ') + 'type = '.length).trim();
      root.head = head.replace(/\s*\{$/, '').trim();
      headerSeen = true;
      continue;
    }
    const access = ACCESS_RE.exec(raw.trim());
    if (access) { top().access = access[1]; continue; }

    const m = MEMBER_RE.exec(raw);
    if (m) {
      const [, off, size, rest] = m;
      const decl = rest.trim();
      if (decl.endsWith('{')) {
        const frame = {
          kind: 'aggregate',
          offset: Number(off),
          size: Number(size),
          name: null,
          head: decl.replace(/\{\s*$/, '').trim(),
          access: top().access,
          children: [],
        };
        top().children.push(frame);
        stack.push(frame);
      } else {
        const { type, name } = splitDecl(decl);
        top().children.push({
          kind: 'member',
          offset: Number(off),
          size: Number(size),
          name,
          type,
          access: top().access,
          children: [],
        });
      }
      continue;
    }

    const close = /^\s*\}([^;]*);?\s*$/.exec(raw);
    if (close) {
      const label = close[1].trim();
      if (stack.length > 1) {
        const frame = stack.pop();
        if (label) frame.name = label;
      } else if (label) {
        root.name = label;
      }
    }
  }

  if (!headerSeen) return null;
  return root;
}

// Flatten the tree into (path, topLevel, offset, size, type, access, isAggregate).
// Aggregate subobjects that carry a name are emitted as well as their leaves, so
// that e.g. `Vehicle.cargo` (a VehicleCargoList subobject) resolves directly.
function flatten(node, prefix = [], out = []) {
  for (const child of node.children) {
    const name = child.name || '';
    const path = name ? [...prefix, name] : prefix;
    const hasChildren = child.children.length > 0;
    if (name && child.offset !== null) {
      out.push({
        path: path.join('.'),
        topLevel: path.length ? path[0] : null,
        offset: child.offset,
        size: child.size,
        type: child.type || child.head || null,
        access: child.access || null,
        isAggregate: hasChildren,
      });
    }
    if (hasChildren) flatten(child, path, out);
  }
  return out;
}

function countMembers(node) {
  let n = 0;
  for (const child of node.children) {
    if (child.kind === 'member') n += 1;
    n += countMembers(child);
  }
  return n;
}

function runGdb(opts, className) {
  const args = ['-batch', '-nx', '-ex', `file ${opts.debugFile}`, '-ex', `ptype /o ${className}`];
  try {
    const out = execFileSync(opts.gdb, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : String(err.message || err),
    };
  }
}

function sha256File(p) {
  const h = createHash('sha256');
  h.update(readFileSync(p));
  return h.digest('hex');
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(`${usage()}\n`); return; }
  if (!opts.debugFile || !opts.out) throw new Error(`--debug-file and --out are required\n${usage()}`);
  if (opts.classesFile) {
    const extra = readFileSync(opts.classesFile, 'utf8')
      .split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    opts.classes.push(...extra);
  }
  const classes = [...new Set(opts.classes)];
  if (!classes.length) throw new Error(`no classes requested\n${usage()}`);

  const result = {
    schema: 'hex-jev-realgame-struct-layout/v1',
    sourceLabel: opts.sourceLabel || null,
    debugFile: resolve(opts.debugFile),
    debugFileSha256: sha256File(opts.debugFile),
    binarySha256: opts.binarySha256 || null,
    buildId: opts.buildId || null,
    gdb: opts.gdb,
    extractedAtUtc: new Date().toISOString(),
    classes: {},
  };

  for (const className of classes) {
    const { ok, stdout, stderr } = runGdb(opts, className);
    const tree = ok ? parsePtypeOutput(stdout) : null;
    if (!tree || !tree.children.length) {
      result.classes[className] = {
        status: 'unresolved',
        error: (stderr || stdout || 'no members parsed').slice(0, 2000),
      };
      continue;
    }
    result.classes[className] = {
      status: 'resolved',
      declaration: tree.head,
      memberCount: countMembers(tree),
      members: flatten(tree),
    };
  }

  writeAtomic(resolve(opts.out), `${JSON.stringify(result, null, 2)}\n`);
  const resolved = Object.values(result.classes).filter((c) => c.status === 'resolved').length;
  process.stdout.write(`extract-struct-layout: ${resolved}/${classes.length} classes resolved -> ${resolve(opts.out)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
