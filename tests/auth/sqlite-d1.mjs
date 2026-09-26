import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Real SQLite executing production SQL; no query-pattern mocks. */
export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../migrations/auth');
  for (const migration of readdirSync(migrations).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(join(migrations, migration), 'utf8'));
  }
  function prepare(sql, args = []) {
    return {
      bind: (...values) => prepare(sql, values),
      async first(column) { const row = sqlite.prepare(sql).get(...args) ?? null; return column && row ? row[column] : row; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      _run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  return {
    sqlite, prepare,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map((statement) => statement._run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); },
  };
}
