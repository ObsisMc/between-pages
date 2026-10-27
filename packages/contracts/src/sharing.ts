import { z } from 'zod';

// Sharing range wire shapes (spaces-and-invitations ADR D3). A selection names the dates a
// person keeps sharing; saving one configures a range and publishes no diary text.

/**
 * Inclusive calendar days; `null` leaves that end open. A single day has equal ends; the
 * whole history and future is `{ from: null, to: null }`.
 */
export const DateRange = z
  .strictObject({ from: z.iso.date().nullable(), to: z.iso.date().nullable() })
  .refine((r) => r.from === null || r.to === null || r.from <= r.to, {
    message: 'from must not be after to',
  })
  .meta({ id: 'DateRange' });
export type DateRange = z.infer<typeof DateRange>;

/** The shared days are the union of `include` minus the union of `exclude`. */
export const DateSelection = z
  .strictObject({ include: z.array(DateRange), exclude: z.array(DateRange) })
  .meta({ id: 'DateSelection' });
export type DateSelection = z.infer<typeof DateSelection>;
