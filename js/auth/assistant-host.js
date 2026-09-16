import { getAuthContext } from './runtime-context.js';
/** The Standard graph knows only this small extension interface, not Dev code. */
export function createAssistantExtensionHost(standardEngine, context = getAuthContext()) {
  let mounted = null;
  const unsubscribe = context.auth.subscribe((identity) => { if (!identity.capabilities.canUseDevAgent) { mounted?.destroy(); mounted = null; } });
  // A fresh facade preserves frozen-property Proxy invariants of the delegate.
  const engine = {};
  for (const key of Reflect.ownKeys(standardEngine)) {
    if (key === 'run') continue;
    Object.defineProperty(engine, key, { enumerable: true, get() {
      const value = standardEngine[key]; return typeof value === 'function' ? value.bind(standardEngine) : value;
    } });
  }
  engine.run = (input) => mounted ? mounted.engine.run(input) : standardEngine.run(input);
  return Object.freeze({
    engine,
    get dev() { return mounted ? Object.freeze({ settings: mounted.settings, supervisor: mounted.supervisor }) : null; },
    mount(panel, session) {
      if (!context.childExtension || !context.auth.getIdentity().capabilities.canUseDevAgent) return;
      try { mounted = context.childExtension.mountAssistant({ standardEngine, panel, session }); }
      catch { mounted?.destroy(); mounted = null; }
    },
    destroy() { unsubscribe(); mounted?.destroy(); mounted = null; },
  });
}
export function installAccountControl(panel, context = getAuthContext()) {
  const root = document.createElement('div'); root.className = 'ai-account';
  const label = document.createElement('span'), button = document.createElement('button'); button.type = 'button';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  root.append(label, button, status);
  const target = panel.root.querySelector('.ai-context-bar') || panel.root;
  target.append(root);
  const render = () => {
    const identity = context.auth.getIdentity();
    label.textContent = identity.authenticated ? `${identity.username || identity.discordId} · ${identity.role} ` : '';
    button.textContent = identity.authenticated ? 'Logout' : 'Login with Discord';
  };
  button.onclick = async () => {
    status.textContent = '';
    if (!context.auth.getIdentity().authenticated) { context.login(); return; }
    button.disabled = true;
    try { await context.logout(); } catch { status.textContent = 'Logout could not reach the server. Retry when connected.'; }
    finally { button.disabled = false; render(); }
  };
  const unsubscribe = context.auth.subscribe(render); render();
  return { destroy() { unsubscribe(); root.remove(); } };
}
