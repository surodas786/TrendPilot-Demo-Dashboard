import Decimal from 'decimal.js';
import { z } from 'zod';

export { Decimal };

/** Plain decimal notation only: no exponent, sign, spaces or thousands separators. */
const DECIMAL_RE = /^\d{1,20}(\.\d{1,8})?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

/** Canonical string form for API output, e.g. "100.00000000" -> "100". */
export function normDecimal(value: string | number | Decimal): string {
  return new Decimal(value).toFixed();
}

/** §10: decimals are serialized as strings. Positive, at most 8 fractional digits. */
export const positiveDecimal = z
  .string({ error: 'Enter the value as a decimal string.' })
  .trim()
  .refine(isDecimalString, 'Enter a positive number with up to 8 decimal places.')
  .refine((v) => !isDecimalString(v) || new Decimal(v).gt(0), 'Must be greater than 0.')
  .transform(normDecimal);

/** A price-movement percentage, strictly between 0 and 100. */
export const percentDistance = z
  .string({ error: 'Enter the value as a decimal string.' })
  .trim()
  .refine(isDecimalString, 'Enter a number with up to 8 decimal places.')
  .refine((v) => !isDecimalString(v) || (new Decimal(v).gt(0) && new Decimal(v).lt(100)), 'Must be greater than 0 and below 100.')
  .transform(normDecimal);
