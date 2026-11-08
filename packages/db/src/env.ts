import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Repository root: the nearest ancestor of the working directory whose package.json
 * declares workspaces. Works from any workspace and inside bundlers.
 */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(/* turbopackIgnore: true */ start);
  for (;;) {
    const pkg = path.join(/* turbopackIgnore: true */ dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        // ignore unreadable package.json and keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(/* turbopackIgnore: true */ start);
    dir = parent;
  }
}

/**
 * Loads KEY=VALUE pairs from the repo-root .env without overriding variables that
 * are already set, so explicit test/e2e settings always win.
 */
export function loadRootEnv(file = path.join(/* turbopackIgnore: true */ findRepoRoot(), '.env')): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set. Copy .env.example to .env at the repository root.`);
  return v;
}
