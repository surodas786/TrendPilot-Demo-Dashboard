/** Simulated invitation or password-reset link. Never contains a password. */
export interface UserLink {
  id: string;
  userId: string;
  kind: 'invite' | 'reset';
  createdAt: number;
  /** active = usable · used = completed · replaced = superseded by a newer link */
  state: 'active' | 'used' | 'replaced';
  usedAt?: number;
}