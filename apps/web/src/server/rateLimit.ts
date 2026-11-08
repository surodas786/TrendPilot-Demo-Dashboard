/**
 * In-memory fixed-window limiter for sign-in attempts. Single-process dev/test only;
 * a shared store replaces this before multi-instance deployment (remaining M1 work).
 */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function hitLimit(key: string, now = Date.now(), max = MAX_ATTEMPTS, windowMs = WINDOW_MS): boolean {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

export function clearLimit(key: string): void {
  buckets.delete(key);
}

export function resetAllLimits(): void {
  buckets.clear();
}
