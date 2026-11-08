const MINUS = '\u2212';

function isEffectivelyZero(value: number, decimals: number): boolean {
  return Math.abs(value) < 0.5 * 10 ** -decimals;
}

export function formatNumber(value: number, decimals = 2): string {
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return value < 0 && !isEffectivelyZero(value, decimals) ? `${MINUS}${abs}` : abs;
}

export function formatSigned(value: number, decimals = 2): string {
  if (isEffectivelyZero(value, decimals)) return formatNumber(0, decimals);
  return value > 0 ? `+${formatNumber(value, decimals)}` : formatNumber(value, decimals);
}

export function formatUsdt(value: number, decimals = 2): string {
  return `${formatNumber(value, decimals)} USDT`;
}

export function formatPercent(value: number, decimals = 2): string {
  return `${formatSigned(value, decimals)}%`;
}

export function formatLeverage(value: number): string {
  return `${value}×`;
}

/** Missing values are never shown as zero. */
export function formatMaybe(value: number | null | undefined, decimals = 2, fallback = 'Not recorded'): string {
  return value === null || value === undefined || !Number.isFinite(value) ? fallback : formatNumber(value, decimals);
}

export function formatQuantity(value: number, decimals: number, asset: string): string {
  return `${formatNumber(value, decimals)} ${asset}`;
}