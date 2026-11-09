import type { Db } from '../client';
import { LiveOrderTransportRefused, openLiveOrderTransport } from '../live/mexcPrivate';
import { paperVenue } from './paper';
import type { ExecutionVenue } from './types';

/**
 * The only place that maps a trading mode to a venue. PAPER (and Demo, replay, tests, CI) always
 * get the paper simulator. LIVE requires the live order transport, which refuses in this build,
 * so no LIVE intent can reach MEXC; it fails closed instead of falling back to paper.
 */
export function venueForMode(db: Db, mode: string, env: Record<string, string | undefined> = process.env): ExecutionVenue {
  if (mode === 'PAPER') return paperVenue(db);
  if (mode === 'LIVE') {
    openLiveOrderTransport(env); // throws in this build
    throw new LiveOrderTransportRefused('no live venue is configured');
  }
  throw new Error(`Unknown trading mode ${mode}`);
}

/**
 * Test seam: an explicitly injected venue (e.g. the MEXC adapter over a mocked exchange). Refused
 * in production so a deployment can never swap the paper simulator for another venue by code path.
 */
export function resolveVenue(db: Db, mode: string, injected?: ExecutionVenue, env: Record<string, string | undefined> = process.env): ExecutionVenue {
  if (injected) {
    if (env.NODE_ENV === 'production') throw new LiveOrderTransportRefused('venue injection is not allowed in production');
    return injected;
  }
  return venueForMode(db, mode, env);
}
