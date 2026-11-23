/**
 * The little that the rest of the app needs to know about nearby races without loading the
 * WebRTC code: which backend is this tab's referee, and whether this tab was hosting before a
 * reload.
 */

export const SNAPSHOT_KEY = "detour:nearby-host";

let hostBackend: unknown = null;

export function registerHost(backend: unknown) {
  hostBackend = backend;
}

/** Is this the host's own seat (the device running the referee)? */
export function isNearbyHost(backend: unknown): boolean {
  return hostBackend !== null && hostBackend === backend;
}

export function readSnapshot(): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function writeSnapshot(text: string): boolean {
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, text);
    return true;
  } catch {
    return false;
  }
}

/** Did this tab host a nearby race before it reloaded? */
export function hadNearbyHost(): boolean {
  const snapshot = readSnapshot();
  return Array.isArray(snapshot) && snapshot.length > 0;
}
