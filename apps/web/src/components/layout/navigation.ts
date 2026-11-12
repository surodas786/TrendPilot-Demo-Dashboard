import {
  ActivityIcon,
  ServerCogIcon,
  BellRingIcon,
  CandlestickChartIcon,
  WebhookIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MailIcon,
  RadioTowerIcon,
  SettingsIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon
} from 'lucide-react';

export type ShellRole = 'ADMIN' | 'INVESTOR';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Shown but not yet built (later milestones). */
  pending?: boolean;
  /** A menu group: `path` is the group's route prefix; children are its submenu. */
  children?: NavItem[];
}

/** PRD §2.2 investor screens (MagicPatterns consolidated navigation). */
const investorNav: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { path: '/my-holdings', label: 'My Holdings', icon: WalletIcon },
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
  {
    path: '/admin/settings',
    label: 'Settings',
    icon: SettingsIcon,
    children: [{ path: '/admin/settings/mail-box', label: 'Mail Box', icon: MailIcon }]
  },
  { path: '/admin/security', label: 'My Security', icon: KeyRoundIcon }
];

export const navFor = (role: ShellRole) => (role === 'ADMIN' ? adminNav : investorNav);

export function pageTitle(pathname: string, role: ShellRole): string {
  const flat = navFor(role).flatMap((i) => [i, ...(i.children ?? [])]);
  return flat.find((i) => i.path === pathname)?.label ?? 'TrendPilot';
}
