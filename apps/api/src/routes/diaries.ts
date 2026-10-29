import type { FastifyReply } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';
import type { BackupService } from '../backup/backup.ts';
import type { CommitService } from '../commit/commit.ts';
import type { DiaryService, DiaryView } from '../diaries/diaries.ts';
import { sendError } from '../errors.ts';
import type { HistoryService } from '../history/history.ts';
import type { DayCard, Reader, SharedView } from '../reader/reader.ts';
import type { ReadingService } from '../reading/reading.ts';
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

function sharedState(view: SharedView): ResponseOf<'sharedDiary'>['diary'] {
  return {
    diaryId: view.diaryId,
    diaryDate: view.diaryDate,
    ownerId: view.ownerId,
    epochId: view.epochId,
    share: view.share,
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

function dayBody(card: DayCard): ResponseOf<'day'>['day'] {
  return {
    diaryDate: card.diaryDate,
    mine: card.mine && { ...card.mine, updatedAt: card.mine.updatedAt.toISOString() },
    partner: card.partner && { ...card.partner, updatedAt: card.partner.updatedAt.toISOString() },
  };
}

const notFound = (reply: FastifyReply) => sendError(reply, 'NOT_FOUND', 'No such diary');

// Diary routes (kernel D10): the owner's personal entry, and the partner's shared entry
// through the authorized-state reader (D17). Run after requireUser, so request.user is
// set; the viewer comes from the session, never from the request. A diary or epoch the
// viewer may not read answers like one that does not exist.
export function diaryHandlers(services: {
  backup: BackupService;
  diaries: DiaryService;
  commit: CommitService;
  history: HistoryService;
  reader: Reader;
  reading: ReadingService;
}) {
  return {
    async diaries(request: ContractRequest<'diaries'>) {
      const page = await services.diaries.list(request.user!.id, request.query.before);
      return {
        diaries: page.diaries.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })),
        nextBefore: page.nextBefore,
      };
    },

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
        nextPointInMs: page.nextPointInMs,
      };
    },

    async readRanges(request: ContractRequest<'readRanges'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const ranges = await services.reading.ranges(request.user!.id, request.params.diaryId);
      return ranges ? { ranges } : notFound(reply);
    },

    async reportRead(request: ContractRequest<'reportRead'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const ranges = await services.reading.report(
        request.user!.id,
        request.params.diaryId,
        request.body.ranges,
      );
      return ranges ? { ranges } : notFound(reply);
    },

    async sharedDiaries(request: ContractRequest<'sharedDiaries'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const page = await services.reader.sharedDiaries(
        request.user!.id,
        request.params.spaceId,
        request.query.before,
      );
      if (!page) return sendError(reply, 'NOT_FOUND', 'No such space');
      return {
        diaries: page.diaries.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })),
        nextBefore: page.nextBefore,
      };
    },

    async days(request: ContractRequest<'days'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const page = await services.reader.days(
        request.user!.id,
        request.query.before,
        services.history.settled(new Date()),
      );
      return { days: page.days.map(dayBody), nextBefore: page.nextBefore };
    },

    async day(request: ContractRequest<'day'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const card = await services.reader.day(
        request.user!.id,
        request.params.date,
        services.history.settled(new Date()),
      );
      return {
        day: dayBody(card),
        google: await services.backup.day(request.user!.id, request.params.date),
      };
    },

    async sharedDiary(request: ContractRequest<'sharedDiary'>, reply: FastifyReply) {
      const { diaryId, epochId } = request.params;
      const view = await services.reader.open(request.user!.id, diaryId, epochId);
      return view ? { diary: sharedState(view) } : notFound(reply);
    },

    async character(request: ContractRequest<'character'>, reply: FastifyReply) {
      const { diaryId, clientId, clock } = request.params;
      const info = await services.reader.character(
        request.user!.id,
        diaryId,
        request.query.epochId,
        clientId,
        clock,
      );
      if (!info) return sendError(reply, 'NOT_FOUND', 'No such character');
      return { ...info, writtenAt: info.writtenAt.toISOString() };
    },

    async historyVersion(request: ContractRequest<'historyVersion'>, reply: FastifyReply) {
      const { diaryId, publicId } = request.params;
      const version = await services.history.version(request.user!.id, diaryId, publicId);
      if (!version) return sendError(reply, 'NOT_FOUND', 'No such version');
      return { ...version, committedAt: version.committedAt.toISOString() };
    },
  };
}
