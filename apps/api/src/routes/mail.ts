import type { FastifyReply } from 'fastify';
import { sendError } from '../errors.ts';
import type { MailSettingsService } from '../notify/settings.ts';
import type { ContractRequest } from './contract.ts';

// Email reminder routes (email-reminders D8). `mail` and `saveMail` run after requireUser
// and touch only the caller's own settings; the three unsubscribe routes are public and
// trust only the token. GET never changes anything, so a mail provider fetching the link
// ahead of the person unsubscribes no one.
export function mailHandlers(mail: MailSettingsService, publicOrigin: string) {
  return {
    async mail(request: ContractRequest<'mail'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return { mail: await mail.view(request.user!.id) };
    },
    async saveMail(request: ContractRequest<'saveMail'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return { mail: await mail.save(request.user!.id, request.body, new Date()) };
    },
    unsubscribeLink(request: ContractRequest<'unsubscribeLink'>, reply: FastifyReply) {
      const token = encodeURIComponent(request.query.token);
      return reply.redirect(`${publicOrigin}/unsubscribe?token=${token}`, 303);
    },
    unsubscribeCategory(request: ContractRequest<'unsubscribeCategory'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const category = mail.categoryOf(request.query.token);
      return category ? { category } : sendError(reply, 'NOT_FOUND', 'Unknown unsubscribe link');
    },
    async unsubscribe(request: ContractRequest<'unsubscribe'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const category = await mail.unsubscribe(request.query.token, new Date());
      return category
        ? { category, unsubscribed: true as const }
        : sendError(reply, 'NOT_FOUND', 'Unknown unsubscribe link');
    },
  };
}
