import type { Executor } from '../client';
import type { CloseResult, OpeningRequest, SimResult, VenueQuote } from '../paper/simulator';

/**
 * §10.2 exchange interface used by the execution flows (entry submit, exits, reversal). The
 * flows hold durable order intents and call the venue only through this interface:
 *  - PAPER: the paper simulator (`paperVenue`), the only venue reachable in this build;
 *  - LIVE: the MEXC private adapter (`mexcVenue`), behind the closed live gate (Step 12).
 * Every method is idempotent by client order ID, and lookups never create anything.
 */

export interface ProtectionState {
  status: 'ACTIVE' | 'CANCELLED' | 'TRIGGERED' | 'INVALID' | 'FAILED' | string;
  /** Side the stop would trade (the opposite of the position). */
  side: string;
  contracts: string;
  triggerPrice: string | null;
  basis: string | null;
  reduceOnly: boolean;
}

export interface CloseRequest {
  paperAccountId: string;
  clientOrderId: string;
  instrumentId: string;
  positionSide: 'LONG' | 'SHORT';
  contracts: string;
  contract: { multiplier: string; qtyStep: string; takerFeeRate: string };
  quote: VenueQuote;
  now: Date;
  /** Venue position reference, where the venue needs one (MEXC positionId). */
  positionRef?: string | null;
  marginMode?: 'ISOLATED' | 'CROSS';
}

export interface ExecutionVenue {
  readonly kind: 'PAPER_SIMULATOR' | 'MEXC_PRIVATE';
  /** EXE-02: opening market order with its stop loss in the same request. */
  placeOpeningOrderWithStop(r: OpeningRequest): Promise<SimResult>;
  /** EXE-04: what the venue knows about this client order ID (null = no such order). */
  lookupOrder(clientOrderId: string, instrumentId: string): Promise<SimResult | null>;
  inspectProtection(stopOrderId: string, instrumentId: string): Promise<ProtectionState | null>;
  /** Reduce-only market close; never opens exposure in the opposite direction. */
  placeReduceOnlyClose(r: CloseRequest): Promise<CloseResult>;
  lookupCloseOrder(clientOrderId: string, instrumentId: string): Promise<CloseResult | null>;
  /**
   * Resizes the resting stop to `contracts` and returns the stop order ID that now covers the
   * position (a venue may replace the order). Never widens the trigger.
   */
  resizeProtection(stopOrderId: string, contracts: string, instrumentId: string): Promise<string>;
  cancelOrder(orderId: string, instrumentId: string): Promise<void>;
  /** Net venue position for the account and contract. */
  position(paperAccountId: string, instrumentId: string, tx?: Executor): Promise<{ side: string | null; contracts: string }>;
  /** Venue stop order ID for a position's stored stop reference. */
  stopOrderIdFor(stopRef: string, tx?: Executor): Promise<string | null>;
}
