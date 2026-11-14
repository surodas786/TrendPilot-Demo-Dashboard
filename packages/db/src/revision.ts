import { execFileSync } from 'node:child_process';

let cached: string | null = null;

/**
 * Code revision this process runs: GIT_SHA if the deploy sets it, else the checkout's HEAD, else
 * 'unknown'. Read once per process; reported by the worker heartbeat and stored with every Live
 * order request so each attempt names the revision that sent it.
 */
export function codeRevision(env: Record<string, string | undefined> = process.env): string {
  if (env.GIT_SHA) return env.GIT_SHA.slice(0, 40);
  if (cached) return cached;
  try {
    cached = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim().slice(0, 40) || 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
