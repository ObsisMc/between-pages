import type { ResponseOf } from '@between-pages/contracts';
import type { Addresses } from '../auth/email.ts';
import { readToken, type Category } from '../mail/tokens.ts';
import type { MailStore } from '../store/mail.ts';

// The caller's own reminder settings and the token-only unsubscribe (email-reminders D8).
// Nothing here answers about anyone but the caller or the token's own user (invariant 7);
// a token only ever turns its category off (invariant 9).

type MailSettings = ResponseOf<'mail'>['mail'];
export type SettingsChange = {
  newContent?: boolean | undefined;
  anniversary?: boolean | undefined;
  backup?: boolean | undefined;
  dismissHint?: true | undefined;
};

export function createMailSettings(deps: {
  store: MailStore;
  addresses: Pick<Addresses, 'emailOf'>;
  /** Without `MAIL_TOKEN_KEY` every token is invalid (技术设计 新配置). */
  tokenKey: Buffer | null;
}) {
  const view = async (userId: string): Promise<MailSettings> => {
    const settings = await deps.store.queries.settings(userId);
    return {
      newContent: settings.newContent,
      anniversary: settings.anniversary,
      backup: settings.backup,
      address: (await deps.addresses.emailOf(userId)) ?? '',
      hintDismissed: settings.hintDismissed,
    };
  };
  const tokenOf = (token: string) => (deps.tokenKey ? readToken(deps.tokenKey, token) : null);

  return {
    view,

    async save(userId: string, change: SettingsChange, now: Date): Promise<MailSettings> {
      await deps.store.queries.saveSettings(
        userId,
        {
          ...(change.newContent !== undefined ? { new_content: change.newContent } : {}),
          ...(change.anniversary !== undefined ? { anniversary: change.anniversary } : {}),
          ...(change.backup !== undefined ? { backup: change.backup } : {}),
          ...(change.dismissHint ? { dismissHint: true } : {}),
        },
        now,
      );
      return view(userId);
    },

    /** The category a token turns off, or null for an invalid one; changes nothing. */
    categoryOf: (token: string): Category | null => tokenOf(token)?.category ?? null,

    /** Turns the token's category off for its user; again changes nothing more. */
    async unsubscribe(token: string, now: Date): Promise<Category | null> {
      const found = tokenOf(token);
      if (!found) return null;
      if (!(await deps.store.queries.person(found.userId))) return null;
      await deps.store.queries.turnOff(found.userId, found.category, now);
      return found.category;
    },
  };
}

export type MailSettingsService = ReturnType<typeof createMailSettings>;
