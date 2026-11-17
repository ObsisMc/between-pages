import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resendError, startFakeResend, type FakeResend } from '../../test/resend.ts';
import { createMailer } from './resend.ts';

// How Resend's answers are sorted (email-reminders D10 "Resend 的答复"), against a stand-in
// on a local port; the SDK is never pointed at the real service.

let fake: FakeResend;
beforeAll(async () => {
  fake = await startFakeResend();
});
afterAll(() => fake.close());

const mail = { subject: 's', html: '<p>h</p>', text: 't', headers: { 'List-Unsubscribe': '<x>' } };
const send = () =>
  createMailer({ apiKey: 're_test', from: 'A <a@mail.test>', baseUrl: fake.url }).send(
    'b@mail.test',
    mail,
    'key-1',
  );

describe('Resend answers', () => {
  it('sends the content, headers and idempotency key it is given', async () => {
    fake.reset();
    expect(await send()).toEqual({ kind: 'accepted', providerId: 'email-1' });
    expect(fake.requests[0]).toEqual({
      key: 'key-1',
      body: expect.objectContaining({
        from: 'A <a@mail.test>',
        to: 'b@mail.test',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
        headers: { 'List-Unsubscribe': '<x>' },
      }),
    });
  });

  it.each([
    [resendError(500, 'internal_server_error'), { kind: 'unknown', code: 'internal_server_error' }],
    ['drop' as const, { kind: 'unknown', code: 'application_error' }],
    [
      resendError(409, 'invalid_idempotent_request'),
      { kind: 'unknown', code: 'invalid_idempotent_request' },
    ],
    [
      resendError(429, 'rate_limit_exceeded', { 'retry-after': '7' }),
      { kind: 'later', afterMs: 7000, code: 'rate_limit_exceeded' },
    ],
    [
      resendError(409, 'concurrent_idempotent_requests'),
      { kind: 'later', afterMs: 30_000, code: 'concurrent_idempotent_requests' },
    ],
    [
      resendError(429, 'daily_quota_exceeded'),
      { kind: 'quota', period: 'day', code: 'daily_quota_exceeded' },
    ],
    [
      resendError(429, 'monthly_quota_exceeded'),
      { kind: 'quota', period: 'month', code: 'monthly_quota_exceeded' },
    ],
    [resendError(403, 'invalid_from_address'), { kind: 'rejected', code: 'invalid_from_address' }],
    [resendError(422, 'validation_error'), { kind: 'rejected', code: 'validation_error' }],
  ])('sorts %j', async (answer, outcome) => {
    fake.reset();
    fake.next(answer);
    expect(await send()).toEqual(outcome);
  });
});
