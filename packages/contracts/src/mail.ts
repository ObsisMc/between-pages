import { z } from 'zod';

// Email reminder wire shapes (email-reminders D8). Every answer concerns the caller's own
// settings only (invariant 7); the unsubscribe routes are authenticated by their token.

export const MailCategory = z
  .enum(['new_content', 'anniversary', 'backup'])
  .meta({ id: 'MailCategory' });

/** The caller's three switches, the address mails go to, and whether the home notice was closed. */
export const MailSettings = z
  .object({
    newContent: z.boolean(),
    anniversary: z.boolean(),
    backup: z.boolean(),
    /** The sign-in Google address; read only. */
    address: z.string(),
    hintDismissed: z.boolean(),
  })
  .meta({ id: 'MailSettings' });

export const MailResponse = z.object({ mail: MailSettings }).meta({ id: 'MailResponse' });

/** Any of the switches, or `dismissHint` to close the home notice for good. */
export const SaveMailRequest = z
  .strictObject({
    newContent: z.boolean().optional(),
    anniversary: z.boolean().optional(),
    backup: z.boolean().optional(),
    dismissHint: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change')
  .meta({ id: 'SaveMailRequest' });

/**
 * Inline, not a named component: the one-click route sits in its own Fastify scope (for its
 * form parser), where the OpenAPI generator cannot resolve a component reference.
 */
export const UnsubscribeQuery = z.strictObject({ token: z.string().min(1).max(200) });

export const UnsubscribeCategoryResponse = z
  .object({ category: MailCategory })
  .meta({ id: 'UnsubscribeCategoryResponse' });

/**
 * The page sends `{}`; a mail client's one-click request sends the RFC 8058 form body
 * `List-Unsubscribe=One-Click`.
 */
export const UnsubscribeRequest = z
  .strictObject({ 'List-Unsubscribe': z.literal('One-Click').optional() })
  .meta({ id: 'UnsubscribeRequest' });

export const UnsubscribeResponse = z
  .object({ category: MailCategory, unsubscribed: z.literal(true) })
  .meta({ id: 'UnsubscribeResponse' });

/** The link in `List-Unsubscribe` answers 303 to the unsubscribe page and no body. */
export const UnsubscribeRedirect = z.null().meta({ id: 'UnsubscribeRedirect' });
