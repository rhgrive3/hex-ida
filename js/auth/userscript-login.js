const SECRET = /^[A-Za-z0-9_-]{43}$/;
export function validCompletionMessage(event, { workerOrigin, transactionId, popup = null }) {
  const value = event?.data;
  return event?.origin === workerOrigin && (!popup || event.source === popup) && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => ['type', 'transactionId', 'completionProof'].includes(key)) && value.type === 'hex.auth.complete' && value.transactionId === transactionId && typeof value.completionProof === 'string' && SECRET.test(value.completionProof);
}
/** Only this parent-realm UI owns the popup, poll secret and completion proof. */
export function createUserscriptLogin({ auth, apiOrigin, windowRef = globalThis.window, documentRef = globalThis.document, onComplete = () => windowRef.location.reload(), intervalMs = 2000 } = {}) {
  let active = null;
  function cancel() {
    if (!active) return;
    const state = active; active = null;
    state.controller.abort(); clearTimeout(state.timer); windowRef.removeEventListener('message', state.listener); state.root.remove(); state.proof.value = ''; state.pollSecret = null;
  }
  async function show() {
    cancel();
    const root = documentRef.createElement('section'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'HEX Discord login');
    root.style.cssText = 'position:fixed;inset:10% 4% auto;max-width:600px;margin:auto;padding:20px;background:white;color:black;border:2px solid #444;z-index:2147483647;font:16px system-ui;box-shadow:0 8px 40px #0008;';
    const title = documentRef.createElement('h2'); title.textContent = 'HEX · Discord login';
    const status = documentRef.createElement('p'); status.textContent = 'Preparing login…'; status.setAttribute('role', 'status');
    const open = documentRef.createElement('button'); open.type = 'button'; open.textContent = 'Open Discord login'; open.disabled = true;
    const label = documentRef.createElement('label'); label.textContent = 'ログイン後、自動で戻らない場合は完了コードを貼り付けてください。';
    const proof = documentRef.createElement('input'); proof.type = 'text'; proof.autocomplete = 'off'; proof.maxLength = 43; proof.setAttribute('aria-label', 'Completion code');
    const complete = documentRef.createElement('button'); complete.type = 'button'; complete.textContent = 'Complete login'; complete.disabled = true;
    const close = documentRef.createElement('button'); close.type = 'button'; close.textContent = 'Cancel'; close.onclick = cancel;
    for (const control of [open, proof, complete, close]) control.style.cssText = 'font:inherit;min-height:44px;max-width:100%;margin:6px;';
    label.append(proof); root.append(title, status, open, label, complete, close); documentRef.documentElement.append(root);
    const state = { root, proof, controller: new AbortController(), pollSecret: null, timer: null, popup: null, listener: () => {}, completing: false };
    active = state;
    const failure = (text) => { if (active === state) { status.textContent = text; open.disabled = true; complete.disabled = true; state.controller.abort(); clearTimeout(state.timer); windowRef.removeEventListener('message', state.listener); } };
    async function finish(value) {
      if (active !== state || state.completing || !SECRET.test(value || '') || Date.now() >= state.expiresAt) return;
      state.completing = true; complete.disabled = true; status.textContent = 'Completing…';
      try {
        await auth.completePairing(state.id, state.pollSecret, value, state.controller.signal);
        if (active !== state) return;
        proof.value = ''; cancel(); onComplete();
      } catch { state.completing = false; if (active === state) { status.textContent = 'Login failed. Check the code or start again.'; complete.disabled = false; } }
    }
    try {
      const transaction = await auth.startPairing(windowRef.location.origin, state.controller.signal);
      if (active !== state) return;
      const url = new URL(transaction.authorizationUrl);
      if (!SECRET.test(transaction.transactionId || '') || !SECRET.test(transaction.pollSecret || '') || url.origin !== 'https://discord.com' || url.pathname !== '/oauth2/authorize' || !Number.isFinite(transaction.expiresAt)) throw new Error('invalid pairing');
      state.id = transaction.transactionId; state.pollSecret = transaction.pollSecret; state.expiresAt = Math.min(transaction.expiresAt, Date.now() + 600000);
      state.listener = (event) => { if (active === state && validCompletionMessage(event, { workerOrigin: apiOrigin, transactionId: state.id, popup: state.popup })) void finish(event.data.completionProof); };
      windowRef.addEventListener('message', state.listener);
      // A real click in this realm, never a child postMessage activation.
      open.onclick = () => { state.popup = windowRef.open(url.href, '_blank'); };
      complete.onclick = () => { void finish(proof.value.trim()); };
      open.disabled = false; complete.disabled = false; status.textContent = 'Open Discord, then return here. Do not share the completion code.';
      const poll = async () => {
        if (active !== state || state.controller.signal.aborted) return;
        if (Date.now() >= state.expiresAt) { failure('Login expired. Cancel and start again.'); return; }
        try {
          const result = await auth.pollPairing(state.id, state.pollSecret, state.controller.signal);
          if (active !== state) return;
          if (!result || Object.keys(result).length !== 1 || !['pending', 'completed', 'expired', 'consumed'].includes(result.status)) throw new Error('invalid status');
          if (result.status === 'expired' || result.status === 'consumed') { if (!state.completing) failure('Login expired or already used.'); return; }
          if (result.status === 'completed' && !state.completing) status.textContent = 'Discord confirmed. Paste the completion code if login did not finish automatically.';
          state.timer = setTimeout(poll, Math.max(500, intervalMs));
        } catch { if (!state.controller.signal.aborted) failure('Status check failed. Cancel and start again.'); }
      };
      void poll();
    } catch { failure('Unable to start login. Check the Worker configuration and retry.'); }
  }
  return Object.freeze({ show: () => { void show(); }, close: cancel });
}
