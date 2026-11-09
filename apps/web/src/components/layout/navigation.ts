import {
  ActivityIcon,
  ServerCogIcon,
  BellRingIcon,
  CandlestickChartIcon,
  WebhookIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
  UsersIcon,
  type LucideIcon
} from 'lucide-react';

export type ShellRole = 'ADMIN' | 'INVESTOR';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Shown but not yet built (later milestones). */
  pending?: boolean;
}

/** PRD §2.2 investor screens (MagicPatterns consolidated navigation). */
const investorNav: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { path: '/my-account', label: 'My Account', icon: UserRoundIcon },
  { path: '/trade-settings', label: 'Trade Settings', icon: SlidersHorizontalIcon },
  { path: '/signals', label: 'Signals', icon: BellRingIcon },
  { path: '/my-trades', label: 'My Trades', icon: ListChecksIcon }
];

/** PRD §2.3 / MagicPatterns admin menu: Users, Signals & Strategy Packages, Trading Pairs & Defaults, Logs. */
const adminNav: NavItem[] = [
  { path: '/admin', label: 'Users', icon: UsersIcon },
  { path: '/admin/signals', label: 'TradingView Webhook & Routes', icon: WebhookIcon },
  { path: '/admin/strategies', label: 'Strategy Packages', icon: RadioTowerIcon },
  { path: '/admin/pairs', label: 'Trading Pairs & Defaults', icon: CandlestickChartIcon },
  { path: '/admin/operations', label: 'Operations', icon: ServerCogIcon },
  { path: '/admin/market-data', label: 'Market Data Feed', icon: ActivityIcon },
  { path: '/admin/audit', label: 'Audit Log', icon: ScrollTextIcon },
  { path: '/admin/security', label: 'My Security', icon: KeyRoundIcon }
];

export const navFor = (role: ShellRole) => (role === 'ADMIN' ? adminNav : investorNav);

export function pageTitle(pathname: string, role: ShellRole): string {
  return navFor(role).find((i) => i.path === pathname)?.label ?? 'TrendPilot';
}
