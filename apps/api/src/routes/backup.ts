import type { FastifyReply } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';
import type {
  BackupService,
  BackupStatus,
  ConnectRefusal,
  PageCopyStatus,
} from '../backup/backup.ts';
import { sendError } from '../errors.ts';
import type { ContractRequest } from './contract.ts';

const MESSAGES: Record<ConnectRefusal, string> = {
  GOOGLE_UNAVAILABLE: 'Google Drive backup is not configured on this server',
  GOOGLE_STATE_INVALID: 'This authorization is unknown, expired or was started by someone else',
  GOOGLE_EXCHANGE_FAILED: 'Google did not grant Drive access',
  GOOGLE_DISCONNECTING: 'The previous connection is still being disconnected',
  GOOGLE_ACCOUNT_IN_USE: 'This Google account is connected by another user',
};

/** A shared page's Doc on the page itself (google-copy-beyond-diaries D8). */
export const pageCopyBody = (copy: PageCopyStatus) => ({
  ...copy,
  coveredAt: copy.coveredAt?.toISOString() ?? null,
});

const statusBody = (status: BackupStatus): ResponseOf<'backup'> => ({
  backup: {
    google: {
      ...status.google,
      connectedAt: status.google.connectedAt?.toISOString() ?? null,
      expiresAt: status.google.expiresAt?.toISOString() ?? null,
    },
    progress: status.progress && {
      ...status.progress,
      backedUpTo: status.progress.backedUpTo?.toISOString() ?? null,
      categories: status.progress.categories.map((c) => ({
        ...c,
        backedUpTo: c.backedUpTo?.toISOString() ?? null,
      })),
    },
    attention: status.attention,
    events: status.events.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind as ResponseOf<'backup'>['backup']['events'][number]['kind'],
      diaryDate: e.diaryDate,
      item: e.item,
      email: e.email,
    })),
  },
});

// The backup page's routes (server-backup-and-google-docs D9, D10). Run after requireUser;
// every answer concerns the session's own user and is no-store. No token, code or state is
// ever part of a response.
export function backupHandlers(backup: BackupService) {
  const refuse = (reply: FastifyReply, code: ConnectRefusal) =>
    sendError(reply, code, MESSAGES[code]);

  return {
    async backup(request: ContractRequest<'backup'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return statusBody(await backup.status(request.user!.id));
    },

    async startGoogleConnection(
      request: ContractRequest<'startGoogleConnection'>,
      reply: FastifyReply,
    ) {
      reply.header('cache-control', 'no-store');
      const started = await backup.start(request.user!.id);
      return typeof started === 'string' ? refuse(reply, started) : started;
    },

    async finishGoogleConnection(
      request: ContractRequest<'finishGoogleConnection'>,
      reply: FastifyReply,
    ) {
      reply.header('cache-control', 'no-store');
      const { code, state } = request.body;
      const finished = await backup.finish(request.user!.id, code, state);
      return typeof finished === 'string' ? refuse(reply, finished) : statusBody(finished);
    },

    async disconnectGoogle(request: ContractRequest<'disconnectGoogle'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return statusBody(await backup.disconnect(request.user!.id));
    },

    async runBackup(request: ContractRequest<'runBackup'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return statusBody(await backup.runNow(request.user!.id));
    },
  };
}
