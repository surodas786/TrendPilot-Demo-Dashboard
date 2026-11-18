/** Display helpers for reporting values. A null value is always "Unavailable", never 0. */
/** Money in an account's currency (USDT by default; Lighter Paper accounts are USDC). */
export const usdtOrUnavailable = (v: string | null | undefined, signed = false, currency = 'USDT') => {
  if (v === null || v === undefined) return 'Unavailable';
  const n = Number(v);
  const txt = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return `${signed && n > 0 ? '+' : ''}${txt} ${currency}`;
};

export const priceOrUnavailable = (v: string | null | undefined) => (v === null || v === undefined ? 'Unavailable' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 }));

export const pnlTone = (v: string | null | undefined) => (v === null || v === undefined ? 'text-muted' : Number(v) > 0 ? 'text-gain' : Number(v) < 0 ? 'text-loss' : 'text-ink');

export const fmtTime = (iso: string | null | undefined, tz: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }) : 'Unavailable';

export const FUNDING_LABEL: Record<string, string> = {
  NONE_DUE: 'None due',
  RECORDED: 'Booked',
  INCOMPLETE: 'Partly booked',
  UNAVAILABLE: 'Unavailable'
};
