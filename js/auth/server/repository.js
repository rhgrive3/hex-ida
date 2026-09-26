import { identityForUser } from '../capabilities.js';
import { AuthError, hash, randomSecret, SESSION_TTL_MS } from './primitives.js';

// Retain rows for 24h after expiry or consumption so polling can report
// terminal status and replay attempts remain diagnosable.
export const OAUTH_TRANSACTION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const OAUTH_TRANSACTION_PRUNE_BATCH_SIZE = 100;
const OAUTH_TRANSACTION_PRUNE_PER_INDEX = Math.floor(OAUTH_TRANSACTION_PRUNE_BATCH_SIZE / 2);

// This SQL predicate is the only DB-side management policy. It is evaluated in
// the mutation transaction as well as at the HTTP gate, avoiding actor TOCTOU.
const MANAGER = "EXISTS (SELECT 1 FROM users actor WHERE actor.discord_id = ? AND (actor.discord_id = ? OR (actor.enabled = 1 AND actor.role = 'admin')))";
export class AuthRepository {
  constructor(db, ownerId, now = Date.now) {
    if (!db?.prepare || !db?.batch) throw new AuthError('auth-unavailable', 503);
    // Plain D1 binding reads use the primary, not an unconstrained read replica.
    this.db = db; this.ownerId = ownerId; this.now = now;
  }
  statement(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  user(id) { return this.statement('SELECT * FROM users WHERE discord_id = ?', id).first(); }
  async loginUser(profile) {
    const now = this.now(), owner = profile.id === this.ownerId;
    await this.statement(`INSERT INTO users (discord_id, username, role, enabled, verified_at, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username,
      role = CASE WHEN ? THEN 'admin' ELSE users.role END, enabled = CASE WHEN ? THEN 1 ELSE users.enabled END,
      verified_at = ?, updated_at = ?, last_login_at = ?, version = users.version + 1`,
    profile.id, profile.username, owner ? 'admin' : 'free', now, now, now, now, owner ? 1 : 0, owner ? 1 : 0, now, now, now).run();
    const user = await this.user(profile.id);
    if (!identityForUser(user, this.ownerId).authenticated) throw new AuthError('user-disabled', 403);
    return user;
  }
  async issueSession(id, kind) {
    const token = randomSecret(), tokenHash = await hash(token), now = this.now();
    await this.statement('INSERT INTO sessions (token_hash, discord_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', tokenHash, id, kind, now, now + SESSION_TTL_MS).run();
    return token;
  }
  async session(tokenHash, kind) {
    return this.statement(`SELECT u.*, s.token_hash, s.kind, s.csrf_hash, s.expires_at FROM sessions s
      JOIN users u ON u.discord_id = s.discord_id WHERE s.token_hash = ? AND s.kind = ? AND s.revoked_at IS NULL AND s.expires_at > ?`, tokenHash, kind, this.now()).first();
  }
  revoke(tokenHash) { return this.statement('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', this.now(), tokenHash).run(); }
  csrf(tokenHash, csrfHash) { return this.statement('UPDATE sessions SET csrf_hash = ? WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?', csrfHash, tokenHash, this.now()).run(); }
  async createTransaction(tx) {
    await this.statement(`INSERT INTO oauth_transactions (transaction_id, state_hash, client_kind, return_path, browser_hash, poll_secret_hash, opener_origin, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, tx.id, tx.stateHash, tx.kind, tx.returnPath, tx.browserHash, tx.pollHash, tx.openerOrigin, this.now(), tx.expiresAt).run();
  }
  // Request paths call this best-effort: reclamation must never turn a
  // successful OAuth step into a failure. The scheduled handler surfaces errors.
  async pruneOAuthTransactionsBestEffort() {
    try { return await this.pruneOAuthTransactions(); } catch { return { deleted: 0, limit: OAUTH_TRANSACTION_PRUNE_BATCH_SIZE, failed: true }; }
  }
  async pruneOAuthTransactions() {
    const staleBefore = this.now() - OAUTH_TRANSACTION_RETENTION_MS;
    const result = await this.statement(`WITH expired AS (
        SELECT transaction_id FROM oauth_transactions
        WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      ), consumed AS (
        SELECT transaction_id FROM oauth_transactions
        WHERE consumed_at <= ? ORDER BY consumed_at LIMIT ?
      )
      DELETE FROM oauth_transactions WHERE transaction_id IN (
        SELECT transaction_id FROM expired UNION ALL SELECT transaction_id FROM consumed
      )`, staleBefore, OAUTH_TRANSACTION_PRUNE_PER_INDEX, staleBefore, OAUTH_TRANSACTION_PRUNE_PER_INDEX).run();
    return { deleted: result.meta?.changes ?? 0, limit: OAUTH_TRANSACTION_PRUNE_BATCH_SIZE };
  }
  transaction(id) { return this.statement('SELECT * FROM oauth_transactions WHERE transaction_id = ?', id).first(); }
  transactionForState(stateHash) { return this.statement('SELECT * FROM oauth_transactions WHERE state_hash = ?', stateHash).first(); }
  claimCallback(stateHash) {
    return this.statement('UPDATE oauth_transactions SET callback_claimed_at = ? WHERE state_hash = ? AND callback_claimed_at IS NULL AND consumed_at IS NULL AND expires_at > ? RETURNING *', this.now(), stateHash, this.now()).first();
  }
  finishWeb(id) { return this.statement('UPDATE oauth_transactions SET completed_at = ?, consumed_at = ? WHERE transaction_id = ?', this.now(), this.now(), id).run(); }
  finishUserscript(id, userId, proofHash, proofExpiry) {
    return this.statement('UPDATE oauth_transactions SET discord_id = ?, completion_proof_hash = ?, proof_expires_at = ?, completed_at = ? WHERE transaction_id = ? AND consumed_at IS NULL', userId, proofHash, proofExpiry, this.now(), id).run();
  }
  async redeem({ id, pollHash, proofHash }) {
    const now = this.now(), token = randomSecret(), tokenHash = await hash(token), redemptionHash = await hash(randomSecret());
    const results = await this.db.batch([
      this.statement(`UPDATE oauth_transactions SET consumed_at = ?, redemption_hash = ? WHERE transaction_id = ? AND client_kind = 'userscript'
        AND poll_secret_hash = ? AND completion_proof_hash = ? AND completed_at IS NOT NULL AND consumed_at IS NULL
        AND expires_at > ? AND proof_expires_at > ? AND EXISTS (SELECT 1 FROM users u WHERE u.discord_id = oauth_transactions.discord_id AND (u.enabled = 1 OR u.discord_id = ?))`,
      now, redemptionHash, id, pollHash, proofHash, now, now, this.ownerId),
      this.statement(`INSERT INTO sessions (token_hash, discord_id, kind, created_at, expires_at)
        SELECT ?, discord_id, 'userscript', ?, ? FROM oauth_transactions WHERE transaction_id = ? AND redemption_hash = ?`, tokenHash, now, now + SESSION_TTL_MS, id, redemptionHash),
    ]);
    if (results[0].meta?.changes !== 1 || results[1].meta?.changes !== 1) throw new AuthError('invalid-completion', 401);
    return token;
  }
  async listUsers({ query, role, enabled, limit, offset }) {
    const clauses = [], values = [];
    if (query) {
      // Literal substring search, not user-supplied LIKE wildcards.
      clauses.push("(discord_id = ? OR username LIKE ? ESCAPE '\\')");
      values.push(query, `%${query.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (role) { clauses.push('role = ?'); values.push(role); }
    if (enabled !== null) { clauses.push('enabled = ?'); values.push(enabled); }
    const result = await this.statement(`SELECT * FROM users${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY discord_id LIMIT ? OFFSET ?`, ...values, limit + 1, offset).all();
    return { users: result.results.slice(0, limit).map((row) => this.publicUser(row)), hasMore: result.results.length > limit, offset, limit };
  }
  publicUser(row) { return { discordId: row.discord_id, username: row.username, role: row.discord_id === this.ownerId ? 'admin' : row.role, enabled: row.discord_id === this.ownerId || row.enabled === 1, owner: row.discord_id === this.ownerId, verifiedAt: row.verified_at, createdAt: row.created_at, updatedAt: row.updated_at, lastLoginAt: row.last_login_at, version: row.version }; }
  async register(actorId, id) {
    const now = this.now(), mutationId = randomSecret();
    const results = await this.db.batch([
      this.statement(`INSERT INTO users (discord_id, role, enabled, created_at, updated_at, mutation_id)
        SELECT ?, 'free', 1, ?, ?, ? WHERE ${MANAGER} ON CONFLICT(discord_id) DO NOTHING`, id, now, now, mutationId, actorId, this.ownerId),
      this.statement(`INSERT INTO audit_log (actor_discord_id, target_discord_id, action, old_value_json, new_value_json, request_id, created_at)
        SELECT ?, discord_id, 'user.register', NULL, json_object('role', role, 'enabled', enabled), ?, ? FROM users WHERE discord_id = ? AND mutation_id = ?`, actorId, mutationId, now, id, mutationId),
    ]);
    if (results[0].meta?.changes !== 1) throw new AuthError('conflict-or-authority-changed', 409);
    return this.publicUser(await this.user(id));
  }
  async updateUser(actorId, id, patch) {
    if (id === this.ownerId && ((patch.role !== undefined && patch.role !== 'admin') || patch.enabled === false)) throw new AuthError('owner-locked', 403);
    const before = await this.user(id);
    if (!before) throw new AuthError('user-not-found', 404);
    const role = patch.role ?? before.role, enabled = patch.enabled === undefined ? before.enabled : Number(patch.enabled);
    const now = this.now(), mutationId = randomSecret();
    const results = await this.db.batch([
      this.statement(`UPDATE users SET role = ?, enabled = ?, updated_at = ?, version = version + 1, mutation_id = ?
        WHERE discord_id = ? AND version = ? AND ${MANAGER}`, role, enabled, now, mutationId, id, before.version, actorId, this.ownerId),
      this.statement(`INSERT INTO audit_log (actor_discord_id, target_discord_id, action, old_value_json, new_value_json, request_id, created_at)
        SELECT ?, discord_id, 'user.update', ?, json_object('role', role, 'enabled', enabled), ?, ? FROM users WHERE discord_id = ? AND mutation_id = ?`,
      actorId, JSON.stringify({ role: before.role, enabled: before.enabled }), mutationId, now, id, mutationId),
    ]);
    if (results[0].meta?.changes !== 1) throw new AuthError('conflict-or-authority-changed', 409);
    return this.publicUser(await this.user(id));
  }
  async audit(limit, offset) {
    const result = await this.statement('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit + 1, offset).all();
    return { entries: result.results.slice(0, limit), hasMore: result.results.length > limit, limit, offset };
  }
}
