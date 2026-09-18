-- D1 / SQLite. Millisecond UTC timestamps; tokens/proofs are SHA-256 hashes only.
CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'free' CHECK (role IN ('free', 'vip', 'admin')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  kind TEXT NOT NULL CHECK (kind IN ('web', 'userscript')),
  csrf_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(discord_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_transactions (
  transaction_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  client_kind TEXT NOT NULL CHECK (client_kind IN ('web', 'userscript')),
  return_path TEXT NOT NULL,
  browser_hash TEXT,
  poll_secret_hash TEXT,
  completion_proof_hash TEXT,
  proof_expires_at INTEGER,
  opener_origin TEXT,
  discord_id TEXT REFERENCES users(discord_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  callback_claimed_at INTEGER,
  completed_at INTEGER,
  consumed_at INTEGER,
  redemption_hash TEXT
);
CREATE INDEX oauth_expiry ON oauth_transactions(expires_at);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_discord_id TEXT NOT NULL,
  target_discord_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE INDEX users_search_role ON users(role, discord_id);
