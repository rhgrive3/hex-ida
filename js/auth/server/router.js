import { HEX_ROLES, identityForUser } from '../capabilities.js';
import { CHATGPT_ORIGINS } from '../../userscript/request-origin-policy.js';
import { AuthRepository } from './repository.js';
import { ADMIN_HTML, ADMIN_CSS } from './admin-site.js';
import { authorizationUrl, completionPage, fetchDiscordIdentity, oauthConfig } from './oauth.js';
import { AuthError, SESSION_COOKIE, OAUTH_COOKIE, SESSION_TTL_MS, TRANSACTION_TTL_MS, PROOF_TTL_MS, SECRET_RE, cookie, cookieValue, discordId, equalHash, hash, headers, json, objectShape, randomSecret, readJson, requireMethod, requireSameOrigin, secret } from './primitives.js';

const RETURN_PATHS = new Set(['/', '/admin/']);
const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function isAuthRoute(path) {
  return path === '/auth' || path.startsWith('/auth/') || path === '/admin' || path.startsWith('/admin/') || path === '/api/auth' || path.startsWith('/api/auth/') || path === '/api/admin' || path.startsWith('/api/admin/') || path === '/_privileged' || path.startsWith('/_privileged/');
}
export function createAuthHandler({ privileged = null, fetchRef = (...args) => fetch(...args), now = Date.now, discordTimeoutMs = 8000 } = {}) {
  return async function handleAuthRequest(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (!isAuthRoute(path)) return null;
    let response;
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin && !CHATGPT_ORIGINS.has(origin)) throw new AuthError('origin-not-allowed', 403);
      if (request.method === 'OPTIONS') {
        // Cross-origin browser JS must never be able to bootstrap the userscript
        // pairing flow. GM.xmlHttpRequest does not need CORS; same-origin web does.
        if (!origin || origin !== url.origin) throw new AuthError('origin-not-allowed', 403);
        return withCors(new Response(null, { status: 204, headers: headers({ 'access-control-allow-methods': 'GET, HEAD, POST, PATCH, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-hex-csrf', 'access-control-max-age': '0' }) }), origin, url.origin);
      }
      let ownerId;
      try { ownerId = discordId(env.HEX_OWNER_DISCORD_ID); } catch { throw new AuthError('auth-not-configured', 503); }
      const repo = new AuthRepository(env.AUTH_DB, ownerId, now);
      const authenticate = () => readSession(request, repo);
      const requireCapability = async (capability) => {
        const auth = await authenticate();
        if (auth.identity.capabilities[capability] !== true) throw new AuthError('forbidden', 403);
        return auth;
      };

      if (path === '/auth/discord/start') {
        requireMethod(request, ['GET']);
        const returnPath = url.searchParams.get('return_to') || '/';
        if (!RETURN_PATHS.has(returnPath)) throw new AuthError('invalid-return-path');
        const config = oauthConfig(env, url.origin), state = randomSecret(), browser = randomSecret();
        await repo.createTransaction({ id: randomSecret(), stateHash: await hash(state), kind: 'web', returnPath, browserHash: await hash(browser), pollHash: null, openerOrigin: null, expiresAt: now() + TRANSACTION_TTL_MS });
        response = new Response(null, { status: 302, headers: headers({ location: authorizationUrl(config, state), 'set-cookie': cookie(OAUTH_COOKIE, browser, TRANSACTION_TTL_MS / 1000) }) });
      } else if (path === '/auth/discord/callback') {
        requireMethod(request, ['GET']);
        const config = oauthConfig(env, url.origin), state = secret(url.searchParams.get('state')), code = url.searchParams.get('code');
        if (!code || code.length > 2048 || url.searchParams.has('error')) throw new AuthError('oauth-code-required');
        const stateHash = await hash(state), candidate = await repo.transactionForState(stateHash);
        if (!candidate || candidate.expires_at <= now() || candidate.callback_claimed_at !== null || candidate.consumed_at !== null) throw new AuthError('invalid-state', 401);
        if (candidate.client_kind === 'web') {
          const binder = cookieValue(request, OAUTH_COOKIE);
          if (!binder || !SECRET_RE.test(binder) || !equalHash(await hash(binder), candidate.browser_hash)) throw new AuthError('invalid-browser-state', 401);
        } else if (candidate.client_kind !== 'userscript') throw new AuthError('invalid-state', 401);
        const transaction = await repo.claimCallback(stateHash);
        if (!transaction) throw new AuthError('invalid-state', 401);
        const user = await repo.loginUser(await fetchDiscordIdentity(config, code, fetchRef, discordTimeoutMs));
        if (transaction.client_kind === 'web') {
          const token = await repo.issueSession(user.discord_id, 'web');
          const previous = cookieValue(request, SESSION_COOKIE);
          if (previous && SECRET_RE.test(previous)) await repo.revoke(await hash(previous));
          await repo.finishWeb(transaction.transaction_id);
          const resultHeaders = new Headers(headers({ location: RETURN_PATHS.has(transaction.return_path) ? transaction.return_path : '/' }));
          resultHeaders.append('set-cookie', cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000));
          resultHeaders.append('set-cookie', cookie(OAUTH_COOKIE, '', 0));
          response = new Response(null, { status: 303, headers: resultHeaders });
        } else {
          const proof = randomSecret();
          await repo.finishUserscript(transaction.transaction_id, user.discord_id, await hash(proof), Math.min(transaction.expires_at, now() + PROOF_TTL_MS));
          response = completionPage(transaction, proof, randomSecret());
        }
      } else if (path === '/api/auth/userscript/start') {
        requireMethod(request, ['POST']);
        const input = objectShape(await readJson(request), ['openerOrigin'], ['openerOrigin']);
        if (!CHATGPT_ORIGINS.has(input.openerOrigin)) throw new AuthError('origin-not-allowed', 403);
        const config = oauthConfig(env, url.origin), id = randomSecret(), state = randomSecret(), pollSecret = randomSecret(), expiresAt = now() + TRANSACTION_TTL_MS;
        await repo.createTransaction({ id, stateHash: await hash(state), kind: 'userscript', returnPath: '/', browserHash: null, pollHash: await hash(pollSecret), openerOrigin: input.openerOrigin, expiresAt });
        response = json({ transactionId: id, pollSecret, authorizationUrl: authorizationUrl(config, state), expiresAt });
      } else if (path === '/api/auth/userscript/poll') {
        requireMethod(request, ['POST']);
        const input = objectShape(await readJson(request), ['transactionId', 'pollSecret'], ['transactionId', 'pollSecret']);
        const transaction = await repo.transaction(secret(input.transactionId));
        const pollHash = await hash(secret(input.pollSecret));
        if (!transaction || transaction.client_kind !== 'userscript' || !equalHash(pollHash, transaction.poll_secret_hash)) throw new AuthError('invalid-transaction', 401);
        // Deliberately status-only. The callback-browser proof is NEVER returned.
        const expired = transaction.expires_at <= now() || (transaction.proof_expires_at !== null && transaction.proof_expires_at <= now());
        response = json({ status: expired ? 'expired' : transaction.consumed_at !== null ? 'consumed' : transaction.completed_at !== null ? 'completed' : 'pending' });
      } else if (path === '/api/auth/userscript/complete') {
        requireMethod(request, ['POST']);
        const input = objectShape(await readJson(request), ['transactionId', 'pollSecret', 'completionProof'], ['transactionId', 'pollSecret', 'completionProof']);
        const token = await repo.redeem({ id: secret(input.transactionId), pollHash: await hash(secret(input.pollSecret)), proofHash: await hash(secret(input.completionProof)) });
        response = json({ token, expiresAt: now() + SESSION_TTL_MS });
      } else if (path === '/api/auth/me') {
        requireMethod(request, ['GET']);
        response = json((await authenticate()).identity);
      } else if (path === '/api/auth/csrf') {
        requireMethod(request, ['GET']);
        const auth = await authenticate();
        if (auth.kind !== 'web') throw new AuthError('web-session-required', 403);
        const token = randomSecret(); await repo.csrf(auth.tokenHash, await hash(token));
        response = json({ csrfToken: token });
      } else if (path === '/auth/logout') {
        requireMethod(request, ['POST']);
        const auth = await authenticate();
        await validateMutation(request, auth);
        objectShape(await readJson(request), []);
        await repo.revoke(auth.tokenHash);
        response = json({ ok: true }, 200, auth.kind === 'web' ? { 'set-cookie': cookie(SESSION_COOKIE, '', 0) } : {});
      } else if (path === '/api/auth/dev/authorize') {
        requireMethod(request, ['POST']);
        const auth = await requireCapability('canUseDevAgent');
        await validateMutation(request, auth);
        const input = objectShape(await readJson(request), ['buildId', 'policy'], ['buildId', 'policy']);
        requireBuild(privileged, input.buildId);
        if (!['normal', 'yolo'].includes(input.policy)) throw new AuthError('invalid-policy');
        if (input.policy === 'yolo' && !auth.identity.capabilities.canUseDevYolo) throw new AuthError('forbidden', 403);
        response = json(auth.identity);
      } else if (path.startsWith('/_privileged/')) {
        requireMethod(request, ['GET', 'HEAD']);
        await requireCapability('canFetchPrivilegedDevSource');
        const match = /^\/_privileged\/dev\/([a-f0-9]{24}\.[a-f0-9]{24})\/(parent|child)\.js$/.exec(path);
        if (!match) throw new AuthError('not-found', 404);
        requireBuild(privileged, match[1]);
        const source = privileged[`${match[2]}Source`];
        if (typeof source !== 'string' || !source) throw new AuthError('privileged-unavailable', 503);
        response = new Response(request.method === 'HEAD' ? null : source, { headers: headers({ 'content-type': 'application/javascript; charset=utf-8', 'x-hex-privileged-build': privileged.buildId }) });
      } else if (path === '/admin' || path.startsWith('/admin/')) {
        requireMethod(request, ['GET', 'HEAD']);
        try { await requireCapability('canManageUsers'); }
        catch (error) {
          if (error.status === 401 && ['/admin', '/admin/'].includes(path)) return new Response(null, { status: 302, headers: headers({ location: '/auth/discord/start?return_to=%2Fadmin%2F' }) });
          throw error;
        }
        let source, contentType;
        if (path === '/admin' || path === '/admin/') { source = ADMIN_HTML; contentType = 'text/html'; }
        else if (path === '/admin/app.css') { source = ADMIN_CSS; contentType = 'text/css'; }
        else if (path === '/admin/app.js' && privileged?.adminSource) { source = privileged.adminSource; contentType = 'application/javascript'; }
        else throw new AuthError('not-found', 404);
        response = new Response(request.method === 'HEAD' ? null : source, { headers: headers({ 'content-type': `${contentType}; charset=utf-8`, 'content-security-policy': ADMIN_CSP }) });
      } else if (path === '/api/admin/users') {
        requireMethod(request, ['GET', 'POST']);
        const auth = await requireCapability('canManageUsers');
        if (request.method === 'GET') response = json(await repo.listUsers(userSearch(url)));
        else {
          await validateMutation(request, auth);
          const input = objectShape(await readJson(request), ['discordId'], ['discordId']);
          response = json(await repo.register(auth.identity.discordId, discordId(input.discordId)), 201);
        }
      } else if (path.startsWith('/api/admin/users/')) {
        requireMethod(request, ['PATCH']);
        const auth = await requireCapability('canManageUsers');
        await validateMutation(request, auth);
        const id = discordId(path.slice('/api/admin/users/'.length));
        const input = objectShape(await readJson(request), ['role', 'enabled']);
        if (!Object.keys(input).length || (Object.hasOwn(input, 'role') && !HEX_ROLES.includes(input.role)) || (Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean')) throw new AuthError('invalid-user-update');
        response = json(await repo.updateUser(auth.identity.discordId, id, input));
      } else if (path === '/api/admin/audit') {
        requireMethod(request, ['GET']);
        await requireCapability('canManageUsers');
        const { limit, offset } = pagination(url);
        response = json(await repo.audit(limit, offset));
      } else throw new AuthError('not-found', 404);
    } catch (error) {
      // Never serialize exception messages from D1, Discord, fetch or credentials.
      response = json({ error: error instanceof AuthError ? error.code : 'auth-unavailable' }, error instanceof AuthError ? error.status : 503);
    }
    return withCors(response, request.headers.get('origin'), url.origin);
  };
}
async function readSession(request, repo) {
  const authorization = request.headers.get('authorization');
  let token, kind;
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new AuthError('unauthenticated', 401);
    token = match[1]; kind = 'userscript';
  } else {
    token = cookieValue(request, SESSION_COOKIE); kind = 'web';
    if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw new AuthError('origin-not-allowed', 403);
  }
  if (!token || !SECRET_RE.test(token)) throw new AuthError('unauthenticated', 401);
  const tokenHash = await hash(token), row = await repo.session(tokenHash, kind), identity = identityForUser(row, repo.ownerId);
  if (!identity.authenticated) throw new AuthError('unauthenticated', 401);
  return { kind, tokenHash, identity, csrfHash: row.csrf_hash };
}
async function validateMutation(request, auth) {
  if (auth.kind !== 'web') return;
  requireSameOrigin(request);
  const token = request.headers.get('x-hex-csrf');
  if (!token || !SECRET_RE.test(token) || !equalHash(await hash(token), auth.csrfHash)) throw new AuthError('invalid-csrf', 403);
}
function requireBuild(privileged, buildId) {
  if (!privileged?.buildId) throw new AuthError('privileged-unavailable', 503);
  if (buildId !== privileged.buildId) throw new AuthError('wrong-build', 409);
}
function pagination(url) {
  const parse = (key, fallback, max) => {
    const value = url.searchParams.get(key);
    if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]{0,6})$/.test(value) || Number(value) > max) throw new AuthError('invalid-pagination');
    return Number(value);
  };
  const limit = parse('limit', 25, 100), offset = parse('offset', 0, 10000);
  if (!limit) throw new AuthError('invalid-pagination');
  return { limit, offset };
}
function userSearch(url) {
  const query = url.searchParams.get('q') || '', role = url.searchParams.get('role') || '', enabled = url.searchParams.get('enabled');
  if (query.length > 128 || (role && !HEX_ROLES.includes(role)) || (enabled !== null && !['0', '1'].includes(enabled))) throw new AuthError('invalid-search');
  return { query, role, enabled: enabled === null ? null : Number(enabled), ...pagination(url) };
}
function withCors(response, origin, ownOrigin) {
  // Auth CORS is same-origin only. Privileged userscript requests use
  // GM.xmlHttpRequest and therefore do not need browser CORS exposure.
  if (!origin || origin !== ownOrigin) return response;
  const result = new Response(response.body, response);
  result.headers.set('access-control-allow-origin', origin);
  result.headers.set('access-control-allow-credentials', 'true');
  result.headers.set('vary', 'Origin');
  return result;
}
