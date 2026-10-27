import type { FastifyReply } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';
import type { CommitService } from '../commit/commit.ts';
import type { DiaryService, DiaryView } from '../diaries/diaries.ts';
import { sendError } from '../errors.ts';
import type { HistoryService } from '../history/history.ts';
import type { ContractRequest } from './contract.ts';

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function diaryState(view: DiaryView): ResponseOf<'diary'>['diary'] {
  return {
    diaryId: view.diaryId,
    diaryDate: view.diaryDate,
    ownerId: view.ownerId,
    generationId: view.generationId,
    seq: view.seq,
    state: base64(view.state),
    bindings: [...view.bindings].map(([clientId, userId]) => ({ clientId, userId })),
  };
}

const receiptBody = (receipt: {
  batchId: string;
  operationIds: string[];
  generationId: string;
  seq: number;
  publicId: string;
  committedAt: Date;
}) => ({ ...receipt, committedAt: receipt.committedAt.toISOString() });

const notFound = (reply: FastifyReply) => sendError(reply, 'NOT_FOUND', 'No such diary');

// Personal diary routes (kernel D10). Run after requireUser, so request.user is set; the
// owner comes from the session, never from the request.
export function diaryHandlers(services: {
  diaries: DiaryService;
  commit: CommitService;
  history: HistoryService;
}) {
  return {
    async openDiary(request: ContractRequest<'openDiary'>, reply: FastifyReply) {
      const opened = await services.diaries.open(request.user!.id, request.body);
      if (opened === 'FUTURE_DATE')
        return sendError(reply, 'VALIDATION_FAILED', 'Diaries cannot be created for future dates');
      return { created: opened.created, diary: diaryState(opened.diary) };
    },

    async diary(request: ContractRequest<'diary'>, reply: FastifyReply) {
      const view = await services.diaries.view(request.user!.id, request.params.diaryId);
      return view ? { diary: diaryState(view) } : notFound(reply);
    },

    async receipt(request: ContractRequest<'receipt'>, reply: FastifyReply) {
      const { batchId, operationId } = request.query;
      const receipt = await services.commit.receipt(
        request.user!.id,
        request.params.diaryId,
        batchId ? { batchId } : { operationId: operationId! },
      );
      if (receipt === 'NOT_FOUND') return notFound(reply);
      return { receipt: receipt && receiptBody(receipt) };
    },

    async history(request: ContractRequest<'history'>, reply: FastifyReply) {
      const page = await services.history.page(
        request.user!.id,
        request.params.diaryId,
        request.query.cursor,
        new Date(),
      );
      if (page === 'NOT_FOUND') return notFound(reply);
      if (page === 'BAD_CURSOR') return sendError(reply, 'VALIDATION_FAILED', 'Unknown cursor');
      return {
        points: page.points.map((p) => ({ ...p, committedAt: p.committedAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
    },

    async historyVersion(request: ContractRequest<'historyVersion'>, reply: FastifyReply) {
      const { diaryId, publicId } = request.params;
      const version = await services.history.version(request.user!.id, diaryId, publicId);
      if (!version) return sendError(reply, 'NOT_FOUND', 'No such version');
      return { ...version, committedAt: version.committedAt.toISOString() };
    },
  };
}
