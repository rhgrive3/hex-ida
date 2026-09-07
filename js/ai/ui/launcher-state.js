/* Map session lifecycle events to the launcher's visible activity state. */
export function launcherStateForSessionEvent(eventType, busy) {
  if (eventType === 'turn') return 'running';
  if (eventType === 'settled') return busy ? 'running' : 'idle';
  return null;
}

export default launcherStateForSessionEvent;
