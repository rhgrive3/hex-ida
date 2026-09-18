/* Protected admin application. Every resource and API also has a Worker gate. */
const $ = (id) => document.getElementById(id);
let offset = 0, auditOffset = 0, generation = 0;
const limit = 25;
async function request(path, method = 'GET', body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { 'content-type': 'application/json' };
    if (method !== 'GET') {
      const csrf = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!csrf.ok) throw new Error('Session expired. Reload and log in.');
      headers['x-hex-csrf'] = (await csrf.json()).csrfToken;
    }
    const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  } finally { clearTimeout(timer); }
}
// Keep CSRF-token rotation and its mutation together. Concurrent changes in
// different rows must not invalidate one another's session-bound token.
let mutationTail = Promise.resolve(), queuedMutations = 0;
function api(path, method = 'GET', body) {
  if (method === 'GET') return request(path, method, body);
  if (queuedMutations >= 16) return Promise.reject(new Error('Too many pending changes. Retry shortly.'));
  queuedMutations++;
  const result = mutationTail.then(() => request(path, method, body));
  mutationTail = result.then(() => {}, () => {});
  return result.finally(() => { queuedMutations--; });
}
function status(text) { $('status').textContent = text; }
async function action(task) {
  status('Loading…');
  try { await task(); status(''); } catch (error) { status(error.name === 'AbortError' ? 'Request timed out. Retry.' : error.message); }
}
function renderUsers(data) {
  $('users').replaceChildren();
  for (const user of data.users) {
    const tr = document.createElement('tr'), label = document.createElement('td'), roleCell = document.createElement('td'), enabledCell = document.createElement('td');
    const name = document.createElement('span'), id = document.createElement('small');
    name.textContent = (user.username || 'Not verified') + (user.owner ? ' · Owner (locked)' : ''); id.textContent = user.discordId; label.append(name, id);
    const role = document.createElement('select'); role.setAttribute('aria-label', `Role: ${user.discordId}`);
    for (const value of ['free', 'vip', 'admin']) { const option = document.createElement('option'); option.value = value; option.textContent = value; role.append(option); }
    role.value = user.role; role.disabled = user.owner;
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = user.enabled; enabled.disabled = user.owner; enabled.setAttribute('aria-label', `Enabled: ${user.discordId}`);
    const change = (patch) => action(async () => {
      role.disabled = true; enabled.disabled = true;
      try { await api(`/api/admin/users/${encodeURIComponent(user.discordId)}`, 'PATCH', patch); }
      finally { await loadUsers(); }
      await loadAudit();
    });
    role.onchange = () => change({ role: role.value }); enabled.onchange = () => change({ enabled: enabled.checked });
    roleCell.append(role); enabledCell.append(enabled); tr.append(label, roleCell, enabledCell); $('users').append(tr);
  }
  $('previous').disabled = offset === 0; $('next').disabled = !data.hasMore;
}
async function loadUsers() {
  const current = ++generation;
  const query = new URLSearchParams({ q: $('query').value, role: $('filter').value, limit, offset });
  const data = await api(`/api/admin/users?${query}`);
  if (current === generation) renderUsers(data);
}
async function loadAudit() {
  const data = await api(`/api/admin/audit?limit=${limit}&offset=${auditOffset}`);
  $('audit').textContent = data.entries.map((entry) => `${new Date(entry.created_at).toISOString()} ${entry.actor_discord_id} → ${entry.target_discord_id} ${entry.action}\n${entry.old_value_json || 'new'} → ${entry.new_value_json}`).join('\n\n') || 'No entries';
  $('audit-previous').disabled = auditOffset === 0; $('audit-next').disabled = !data.hasMore;
}
$('search').onsubmit = (event) => { event.preventDefault(); offset = 0; void action(loadUsers); };
$('register').onsubmit = (event) => { event.preventDefault(); void action(async () => { await api('/api/admin/users', 'POST', { discordId: $('discord-id').value.trim() }); $('discord-id').value = ''; await loadUsers(); await loadAudit(); }); };
$('previous').onclick = () => { offset = Math.max(0, offset - limit); void action(loadUsers); };
$('next').onclick = () => { offset += limit; void action(loadUsers); };
$('audit-previous').onclick = () => { auditOffset = Math.max(0, auditOffset - limit); void action(loadAudit); };
$('audit-next').onclick = () => { auditOffset += limit; void action(loadAudit); };
$('audit-refresh').onclick = () => { auditOffset = 0; void action(loadAudit); };
$('logout').onclick = () => action(async () => { await api('/auth/logout', 'POST', {}); location.assign('/'); });
void action(async () => { const me = await api('/api/auth/me'); $('identity').textContent = `${me.username || me.discordId} · ${me.role}`; await loadUsers(); await loadAudit(); });
