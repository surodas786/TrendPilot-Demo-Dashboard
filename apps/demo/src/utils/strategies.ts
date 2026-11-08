import { strategies } from '../data/mockData';

export function strategyName(id: string): string {
  if (id === 'external') return 'External · unmanaged';
  return strategies.find((s) => s.id === id)?.name ?? id;
}

export function strategyWithVersion(id: string, version?: string | null): string {
  if (id === 'external') return strategyName(id);
  return `${strategyName(id)} · ${version ? `v${version}` : 'version not recorded'}`;
}