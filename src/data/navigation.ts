import {
  BellRingIcon,
  CandlestickChartIcon,
  FileBarChart2Icon,
  FlaskConicalIcon,
  HistoryIcon,
  LayersIcon,
  LayoutDashboardIcon,
  PlugZapIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WalletIcon } from
'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PreviewRole } from '../types/trading';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

export const adminNav: NavItem[] = [
{ path: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
{ path: '/admin/users', label: 'Users', icon: UsersIcon },
{ path: '/admin/signals', label: 'Signals & Strategy Packages', icon: RadioTowerIcon },
{ path: '/admin/pairs', label: 'Trading Pairs & Defaults', icon: CandlestickChartIcon },
{ path: '/logs', label: 'Logs', icon: ScrollTextIcon },
{ path: '/demo-center', label: 'Demo Center', icon: FlaskConicalIcon },
{ path: '/admin', label: 'Admin Workspace', icon: ShieldIcon }];


export const subscriberNav: NavItem[] = [
{ path: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
{ path: '/exchange-connections', label: 'Exchange Connections', icon: PlugZapIcon },
{ path: '/trade-settings', label: 'Trade Settings', icon: SlidersHorizontalIcon },
{ path: '/holdings', label: 'Holdings', icon: LayersIcon },
{ path: '/trade-history', label: 'Trade History', icon: HistoryIcon },
{ path: '/funds-funding', label: 'Funds & Funding', icon: WalletIcon },
{ path: '/reports', label: 'Reports', icon: FileBarChart2Icon },
{ path: '/signals', label: 'Signals', icon: BellRingIcon },
{ path: '/logs', label: 'Logs', icon: ScrollTextIcon },
{ path: '/settings', label: 'Settings', icon: SettingsIcon },
{ path: '/demo-center', label: 'Demo Center', icon: FlaskConicalIcon }];


export function navForRole(role: PreviewRole): NavItem[] {
  return role === 'admin' ? adminNav : subscriberNav;
}

export function pageTitle(pathname: string): string {
  return [...adminNav, ...subscriberNav].find((i) => i.path === pathname)?.label ?? 'Dashboard';
}