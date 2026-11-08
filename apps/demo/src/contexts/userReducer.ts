import { ADMIN_OPERATOR } from '../data/demoUsers';
import type { DemoState } from './demoReducer';
import type { DemoUser } from '../types/signals';
import type { UserLink } from '../types/users';

export type UserAction =
{type: 'createUser';user: DemoUser;link: UserLink;at: number;} |
{type: 'editUser';userId: string;name: string;email: string;at: number;} |
{type: 'issueUserLink';link: UserLink;at: number;} |
{type: 'completeSetup';linkId: string;at: number;} |
{type: 'completeReset';linkId: string;at: number;} |
{type: 'setUserAccess';userId: string;status: 'active' | 'suspended';at: number;};

const TYPES = new Set(['createUser', 'editUser', 'issueUserLink', 'completeSetup', 'completeReset', 'setUserAccess']);
export function isUserAction(a: {type: string;}): a is UserAction {
  return TYPES.has(a.type);
}

const STATUS_LABEL = { invited: 'Invited', active: 'Active', suspended: 'Suspended' } as const;

function log(state: DemoState, at: number, action: string, target: string, previous: string, next: string): DemoState['adminLog'] {
  return [{ id: `adm-${at}-${state.adminLog.length + 1}`, at, operator: ADMIN_OPERATOR, action, target, previous, next }, ...state.adminLog];
}

/** Issues a link and marks any earlier active link of the same kind for that user as replaced. */
function withLink(links: UserLink[], link: UserLink): UserLink[] {
  return [link, ...links.map((l) => l.userId === link.userId && l.kind === link.kind && l.state === 'active' ? { ...l, state: 'replaced' as const } : l)];
}

export function userReducer(state: DemoState, action: UserAction): DemoState {
  switch (action.type) {
    case 'createUser':
      if (state.users.some((u) => u.email.toLowerCase() === action.user.email.toLowerCase())) return state;
      return {
        ...state,
        users: [...state.users, action.user],
        userLinks: withLink(state.userLinks, action.link),
        adminLog: log(state, action.at, 'Subscriber created', action.user.name, '—', 'Invited · invitation email simulated')
      };
    case 'editUser':{
        const u = state.users.find((x) => x.id === action.userId);
        const clash = state.users.some((x) => x.id !== action.userId && x.email.toLowerCase() === action.email.toLowerCase());
        if (!u || clash || u.name === action.name && u.email === action.email) return state;
        return {
          ...state,
          users: state.users.map((x) => x.id === u.id ? { ...x, name: action.name, email: action.email } : x),
          adminLog: log(state, action.at, 'Subscriber details edited', u.name, `${u.name} · ${u.email}`, `${action.name} · ${action.email}`)
        };
      }
    case 'issueUserLink':{
        const u = state.users.find((x) => x.id === action.link.userId);
        if (!u) return state;
        if (action.link.kind === 'invite' && u.status !== 'invited') return state;
        if (action.link.kind === 'reset' && u.status !== 'active') return state;
        return {
          ...state,
          userLinks: withLink(state.userLinks, action.link),
          adminLog: log(state, action.at, action.link.kind === 'invite' ? 'Invitation resent' : 'Password reset sent', u.name, '—', `${action.link.kind === 'invite' ? 'Invitation' : 'Reset'} email simulated · earlier link invalidated`)
        };
      }
    case 'completeSetup':{
        const link = state.userLinks.find((l) => l.id === action.linkId);
        const u = link && state.users.find((x) => x.id === link.userId);
        if (!link || !u || link.kind !== 'invite' || link.state !== 'active' || u.status !== 'invited') return state;
        return {
          ...state,
          users: state.users.map((x) => x.id === u.id ? { ...x, status: 'active', invitation: 'accepted' } : x),
          userLinks: state.userLinks.map((l) => l.id === link.id ? { ...l, state: 'used', usedAt: action.at } : l),
          adminLog: log(state, action.at, 'Account setup completed', u.name, 'Invited · Pending', 'Active · Accepted')
        };
      }
    case 'completeReset':{
        const link = state.userLinks.find((l) => l.id === action.linkId);
        const u = link && state.users.find((x) => x.id === link.userId);
        if (!link || !u || link.kind !== 'reset' || link.state !== 'active') return state;
        return {
          ...state,
          userLinks: state.userLinks.map((l) => l.id === link.id ? { ...l, state: 'used', usedAt: action.at } : l),
          adminLog: log(state, action.at, 'Password reset completed', u.name, 'Reset link active', 'Reset link used · status unchanged')
        };
      }
    case 'setUserAccess':{
        const u = state.users.find((x) => x.id === action.userId);
        if (!u) return state;
        if (action.status === 'suspended' && u.status !== 'active') return state;
        if (action.status === 'active' && u.status !== 'suspended') return state;
        return {
          ...state,
          users: state.users.map((x) => x.id === u.id ? { ...x, status: action.status } : x),
          // A suspended user's outstanding reset link can no longer be used.
          userLinks: action.status === 'suspended' ? state.userLinks.map((l) => l.userId === u.id && l.kind === 'reset' && l.state === 'active' ? { ...l, state: 'replaced' } : l) : state.userLinks,
          adminLog: log(state, action.at, action.status === 'suspended' ? 'Subscriber suspended' : 'Subscriber reactivated', u.name, STATUS_LABEL[u.status], action.status === 'suspended' ? 'Suspended — simulated account access blocked; exchange positions are not closed' : 'Active')
        };
      }
    default:
      return state;
  }
}