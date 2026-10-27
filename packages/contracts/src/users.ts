import { z } from 'zod';

// What one member may learn about a user. Never add last-seen time or login data here
// (authentication-and-sessions invariant 9).
export const UserSummary = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
  })
  .meta({ id: 'UserSummary' });
