import { REPORTING_TIMEZONE } from '../data/mockData';
import type { DemoState } from '../contexts/demoReducer';
import type { DemoUser } from '../types/signals';
import type { UserLink } from '../types/users';

/** Versioned browser storage for non-sensitive user records. Passwords are never stored. */
const KEY = 'trendpilot.userDirectory';
const VERSION = 1;

interface StoredDirectory {
  version: number;
  users: DemoUser[];
  links: UserLink[];
}

const isUser = (u: unknown): u is DemoUser => {
  const x = u as DemoUser;
  return Boolean(x) && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.email === 'string' && ['invited', 'active', 'suspended'].includes(x.status) && ['pending', 'accepted'].includes(x.invitation) && typeof x.createdAt === 'number';
};
const isLink = (l: unknown): l is UserLink => {
  const x = l as UserLink;
  return Boolean(x) && typeof x.id === 'string' && typeof x.userId === 'string' && ['invite', 'reset'].includes(x.kind) && ['active', 'used', 'replaced'].includes(x.state);
};

export function hydrateUserDirectory(state: DemoState): DemoState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return state;
    const data = JSON.parse(raw) as StoredDirectory;
    if (data.version !== VERSION || !Array.isArray(data.users) || !data.users.every(isUser) || !Array.isArray(data.links) || !data.links.every(isLink)) {
      window.localStorage.removeItem(KEY);
      return state;
    }
    // Only the whitelisted, non-sensitive fields are restored.
    const users = data.users.map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status, invitation: u.invitation, createdAt: u.createdAt, entriesPaused: Boolean(u.entriesPaused), workspacePaused: Boolean(u.workspacePaused) }));
    const traderUserId = users.some((u) => u.id === state.traderUserId) ? state.traderUserId : users[0]?.id ?? state.traderUserId;
    return { ...state, users, userLinks: data.links.map((l) => ({ id: l.id, userId: l.userId, kind: l.kind, createdAt: l.createdAt, state: l.state, usedAt: l.usedAt })), traderUserId };
  } catch {
    return state;
  }
}

export function saveUserDirectory(users: DemoUser[], links: UserLink[]): void {
  try {
    const data: StoredDirectory = { version: VERSION, users, links };
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {

    // Storage unavailable — records stay in memory for this session.
  }}

let seq = 0;
export function makeLinkId(kind: UserLink['kind'], at: number): string {
  seq += 1;
  return `SIM-${kind === 'invite' ? 'INV' : 'RST'}-${at.toString(36).toUpperCase()}-${seq}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: REPORTING_TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' });
export function formatUserDate(ms: number): string {
  return dateFmt.format(ms);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD = 8;

export function passwordErrors(pw: string, confirm: string): {password?: string;confirm?: string;} {
  return {
    password: pw.length === 0 ? 'Enter a password.' : pw.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : undefined,
    confirm: confirm.length === 0 ? 'Confirm the password.' : confirm !== pw ? 'Passwords do not match.' : undefined
  };
}