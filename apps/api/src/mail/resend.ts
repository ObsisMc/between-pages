import { Resend } from 'resend';
import type { Rendered } from './render.ts';

// Sends one rendered mail through Resend's official SDK (email-reminders D2) and sorts its
// answer into what the caller must do (D10 "Resend 的答复"). The record's ID is the
// idempotency key, so a retry with the same content is answered with the first result.

export type MailerConfig = { apiKey: string; from: string; baseUrl: string };

export type Outcome =
  | { kind: 'accepted'; providerId: string }
  /** The request may or may not have reached Resend: network, timeout, 5xx, or a key reused with other content. */
  | { kind: 'unknown'; code: string }
  /** Resend asks to come back later: rate limited, or the same key still in flight. */
  | { kind: 'later'; afterMs: number; code: string }
  /** The daily or monthly free quota is used up. */
  | { kind: 'quota'; period: 'day' | 'month'; code: string }
  /** Refused for good: bad address, invalid key, unverified domain. */
  | { kind: 'rejected'; code: string };

const TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 60_000;
const IN_FLIGHT_RETRY_MS = 30_000;

export type Mailer = {
  send(to: string, mail: Rendered, idempotencyKey: string): Promise<Outcome>;
};

export function createMailer(config: MailerConfig): Mailer {
  // baseUrl is always passed, so the SDK never reads RESEND_BASE_URL from the environment.
  const resend = new Resend(config.apiKey, { baseUrl: config.baseUrl });
  return {
    async send(to, mail, idempotencyKey) {
      let answer: Awaited<ReturnType<typeof resend.emails.send>>;
      try {
        answer = await resend.emails.send(
          {
            from: config.from,
            to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            headers: mail.headers,
          },
          { idempotencyKey, signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
      } catch {
        return { kind: 'unknown', code: 'request_failed' };
      }
      if (answer.data) return { kind: 'accepted', providerId: answer.data.id };
      const { name, statusCode } = answer.error;
      if (statusCode === null || statusCode >= 500 || name === 'invalid_idempotent_request')
        return { kind: 'unknown', code: name };
      if (name === 'daily_quota_exceeded') return { kind: 'quota', period: 'day', code: name };
      if (name === 'monthly_quota_exceeded') return { kind: 'quota', period: 'month', code: name };
      if (name === 'concurrent_idempotent_requests')
        return { kind: 'later', afterMs: IN_FLIGHT_RETRY_MS, code: name };
      if (statusCode === 429) {
        const seconds = Number(answer.headers?.['retry-after']);
        return {
          kind: 'later',
          afterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS,
          code: name,
        };
      }
      return { kind: 'rejected', code: name };
    },
  };
}
