import { AuthError, deadline, discordId, headers, readTextBounded } from './primitives.js';

export function oauthConfig(env, origin) {
  let redirect;
  try { redirect = new URL(env.DISCORD_REDIRECT_URI); } catch { throw new AuthError('oauth-not-configured', 503); }
  const local = redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname);
  if ((!local && redirect.protocol !== 'https:') || redirect.origin !== origin || redirect.pathname !== '/auth/discord/callback' || redirect.search || redirect.hash || redirect.username || redirect.password || typeof env.DISCORD_CLIENT_SECRET !== 'string' || !env.DISCORD_CLIENT_SECRET.trim()) throw new AuthError('oauth-not-configured', 503);
  try { discordId(env.DISCORD_CLIENT_ID); } catch { throw new AuthError('oauth-not-configured', 503); }
  return { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET, redirectUri: redirect.href };
}
export function authorizationUrl(config, state) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'identify', state }).toString();
  return url.href;
}
export async function fetchDiscordIdentity(config, code, fetchRef, timeoutMs = 8000) {
  const call = (url, init) => deadline(async (signal) => {
    const response = await fetchRef(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new AuthError('discord-unavailable', 502); }
    let data;
    try { data = JSON.parse(await readTextBounded(response, 64 * 1024, signal)); } catch { throw new AuthError('discord-invalid-response', 502); }
    return data;
  }, timeoutMs, 'discord-timeout');
  // Tokens are short-lived local variables, never stored in D1, URLs or logs.
  const tokens = await call('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }).toString(),
  });
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 4096 || /[\r\n]/.test(tokens.access_token) || String(tokens.token_type).toLowerCase() !== 'bearer') throw new AuthError('discord-invalid-response', 502);
  const profile = await call('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
  try { discordId(profile?.id); } catch { throw new AuthError('discord-invalid-identity', 502); }
  if (typeof profile.username !== 'string' || !profile.username || profile.username.length > 128) throw new AuthError('discord-invalid-identity', 502);
  return { id: profile.id, username: profile.username };
}
export function completionPage(transaction, proof, nonce) {
  const payload = JSON.stringify({ type: 'hex.auth.complete', transactionId: transaction.transaction_id, completionProof: proof }).replaceAll('<', '\\u003c');
  const origin = JSON.stringify(transaction.opener_origin).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HEX login complete</title><body><h1>Discordの確認が完了</h1><p>自分のHEXログイン画面へ戻ってください。自動で戻らない場合は、このコードをコピーして貼り付けてください。他人には渡さないでください。</p><label>完了コード <input id="proof" readonly size="44"></label><button id="copy">Copy</button><p id="status" role="status"></p><script nonce="${nonce}">const data=${payload};const target=${origin};document.getElementById('proof').value=data.completionProof;document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(data.completionProof);document.getElementById('status').textContent='Copied';}catch{document.getElementById('proof').select();}};if(window.opener&&target){try{window.opener.postMessage(data,target);}catch{}}</script></body></html>`;
  return new Response(html, { headers: headers({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }) });
}
