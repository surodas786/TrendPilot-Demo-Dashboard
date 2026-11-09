import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { simOrders } from '../schema';
import { cancelOrder, inspectProtection, lookupCloseOrder, lookupOrder, placeOpeningOrderWithStop, placeReduceOnlyClose, resizeProtection, venuePosition } from '../paper/simulator';
import type { ExecutionVenue } from './types';

/** The paper simulator as an ExecutionVenue. Behaviour is exactly the simulator's. */
export function paperVenue(db: Db): ExecutionVenue {
  return {
    kind: 'PAPER_SIMULATOR',
    placeOpeningOrderWithStop: (r) => placeOpeningOrderWithStop(db, r),
    lookupOrder: (clientOrderId) => lookupOrder(db, clientOrderId),
    inspectProtection: (stopOrderId) => inspectProtection(db, stopOrderId),
    placeReduceOnlyClose: (r) => placeReduceOnlyClose(db, r),
    lookupCloseOrder: (clientOrderId) => lookupCloseOrder(db, clientOrderId),
    resizeProtection: async (stopOrderId, contracts) => {
      await resizeProtection(db, stopOrderId, contracts);
      return stopOrderId;
    },
    cancelOrder: (orderId) => cancelOrder(db, orderId),
    position: (paperAccountId, instrumentId, tx) => venuePosition(tx ?? db, paperAccountId, instrumentId),
    stopOrderIdFor: async (stopRef, tx) => {
      const [s] = await (tx ?? db).select({ id: simOrders.id }).from(simOrders).where(and(eq(simOrders.clientOrderId, stopRef), eq(simOrders.kind, 'STOP_MARKET')));
      return s?.id ?? null;
    }
  };
}
