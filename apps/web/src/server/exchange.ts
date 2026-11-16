import { DomainError, ErrorCode, parseExchangeId, type ExchangeId } from '@trendpilot/domain';

/**
 * The exchange a connection request is about: `?exchange=` or the body's `exchange`, MEXC when
 * neither is given (every client from before Bitunix). An unknown value is a 400, never a fallback.
 */
export function exchangeOf(req: Request, body?: Record<string, unknown>): ExchangeId {
  const fromQuery = new URL(req.url).searchParams.get('exchange');
  const q = parseExchangeId(fromQuery);
  const b = parseExchangeId(body?.exchange);
  if (!q || !b) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'exchange must be MEXC or BITUNIX.');
  if (fromQuery && body?.exchange !== undefined && q !== b) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'The exchange in the URL and in the body differ.');
  return fromQuery ? q : b;
}
