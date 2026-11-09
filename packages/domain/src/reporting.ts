import { Decimal } from './decimal';

/**
 * REP-03/04 reporting rules for paper accounts. Pure; no I/O.
 *
 * - The reporting day is a calendar day in the investor's reporting timezone (Asia/Dhaka by
 *   default, SRS §13). Realized results are attributed to the fill date, funding to the
 *   settlement time.
 * - Net realized P&L = gross realized trading P&L − trading fees + net settled funding.
 *   Margin postings and releases and the opening balance are balance movements, not P&L.
 * - Unrealized P&L is reported separately, on the mark price.
 */

export const REPORTING_DEFAULT_TIMEZONE = 'Asia/Dhaka';
/** MEXC USDT perpetuals settle funding every 8 hours at 00:00, 08:00 and 16:00 UTC. */
export const FUNDING_CYCLE_HOURS = 8;

const D = (v: Decimal.Value) => new Decimal(v);

const parts = (instant: Date, tz: string) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
};

/** Offset of `tz` from UTC at `instant`, in ms (Asia/Dhaka: +6 h). */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** UTC bounds [from, to) of a local calendar day. Handles DST by re-checking the offset at each bound. */
export function reportingDayWindow(date: string, tz: string): { date: string; timezone: string; from: Date; to: Date } {
  if (!isIsoDate(date)) throw new Error(`Invalid reporting date ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const midnight = (yy: number, mm: number, dd: number) => {
    const guess = Date.UTC(yy, mm - 1, dd);
    let t = guess - tzOffsetMs(new Date(guess), tz);
    t = guess - tzOffsetMs(new Date(t), tz);
    return new Date(t);
  };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { date, timezone: tz, from: midnight(y, m, d), to: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) };
}

/** Mark-price unrealized P&L for the remaining contracts. */
export function unrealizedPnl(side: 'LONG' | 'SHORT', avgEntry: string, price: string, contracts: string, multiplier: string): string {
  const diff = side === 'LONG' ? D(price).minus(avgEntry) : D(avgEntry).minus(price);
  return diff.times(D(contracts).times(multiplier)).toDecimalPlaces(8).toFixed();
}

/**
 * Settled funding for one position: notional at the settlement mark × rate. A positive rate means
 * Longs pay Shorts. Paid funding is negative, received funding positive (REP-02).
 */
export function fundingAmount(side: 'LONG' | 'SHORT', contracts: string, multiplier: string, markPrice: string, rate: string): { notional: string; amount: string } {
  const notional = D(contracts).times(multiplier).times(markPrice);
  const signed = notional.times(rate).times(side === 'LONG' ? -1 : 1);
  return { notional: notional.toDecimalPlaces(8).toFixed(), amount: signed.toDecimalPlaces(8).toFixed() };
}

/** Funding settlement instants in [from, to). */
export function fundingSettlementsBetween(from: Date, to: Date, cycleHours = FUNDING_CYCLE_HOURS): Date[] {
  const ms = cycleHours * 3_600_000;
  const out: Date[] = [];
  for (let t = Math.ceil(from.getTime() / ms) * ms; t < to.getTime(); t += ms) out.push(new Date(t));
  return out;
}

export type FundingStatus = 'NONE_DUE' | 'RECORDED' | 'INCOMPLETE' | 'UNAVAILABLE';

export const FUNDING_STATUS_TEXT: Record<FundingStatus, string> = {
  NONE_DUE: 'No funding was due: no position was open at a funding settlement.',
  RECORDED: 'Simulated funding booked from settled funding rates.',
  INCOMPLETE: 'Some funding settlements have no settled rate or price yet; the total is partial.',
  UNAVAILABLE: 'Funding was due but no settled rate or price is recorded yet.'
};

/** Distinguishes "nothing due" (a real zero) from "due but not known" (unavailable). */
export function fundingStatus(due: number, booked: number): FundingStatus {
  if (due === 0) return 'NONE_DUE';
  if (booked >= due) return 'RECORDED';
  return booked === 0 ? 'UNAVAILABLE' : 'INCOMPLETE';
}

/**
 * REP-03 net realized from booked amounts. Funding that is unavailable is not guessed: callers
 * report the funding status next to this figure so a missing charge is never shown as zero.
 */
export function netRealized(grossRealized: string, fees: string, bookedFunding: string): string {
  return D(grossRealized).minus(fees).plus(bookedFunding).toDecimalPlaces(8).toFixed();
}
