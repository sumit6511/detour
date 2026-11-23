/**
 * Every read and write is wrapped: storage can be missing or throw (private windows, blocked
 * site data, embedded previews), and the game must still work, just without memory.
 */
export function load<T>(key: string, fallback: T, isValid?: (value: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as unknown;
    if (isValid && !isValid(value)) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort: losing a save slot is not worth interrupting the game for.
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
}
