import { z } from 'zod';
import {
  DiaryListPage,
  DiaryListQuery,
  DiaryParams,
  DiaryResponse,
  HistoryPage,
  HistoryQuery,
  HistoryVersion,
  HistoryVersionParams,
  OpenDiaryRequest,
  OpenDiaryResponse,
  ReceiptQuery,
  ReceiptResponse,
} from './diaries.ts';

// Every HTTP route the web client may call. The API registers handlers from these
// definitions and the client builds requests from them, so the path, method and
// response shape cannot drift apart.
export interface RouteDefinition<Response extends z.ZodType = z.ZodType> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  summary: string;
  // 'user' routes answer 401 without a session; public ones must say so explicitly
  // (authentication-and-sessions invariant 13).
  access: 'public' | 'user';
  /** Path parameters, named as the `:name` segments of `path`. */
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: Response;
}

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'HealthResponse' });

// What one member may learn about a user. Never add last-seen time or login data here
// (authentication-and-sessions invariant 9).
export const UserSummary = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
  })
  .meta({ id: 'UserSummary' });

export const MeResponse = z.object({ user: UserSummary }).meta({ id: 'MeResponse' });

export const routes = {
  health: {
    method: 'GET',
    path: '/api/health',
    summary: 'Report that the API process is serving requests.',
    access: 'public',
    response: HealthResponse,
  },
  me: {
    method: 'GET',
    path: '/api/me',
    summary: 'Return the signed-in user.',
    access: 'user',
    response: MeResponse,
  },
  diaries: {
    method: 'GET',
    path: '/api/diaries',
    summary: "List the caller's own diaries, newest date first, one page per `before` date.",
    access: 'user',
    query: DiaryListQuery,
    response: DiaryListPage,
  },
  openDiary: {
    method: 'POST',
    path: '/api/diaries',
    summary:
      "Open the caller's diary for today in the given time zone, or for a past date, creating it if missing.",
    access: 'user',
    body: OpenDiaryRequest,
    response: OpenDiaryResponse,
  },
  diary: {
    method: 'GET',
    path: '/api/diaries/:diaryId',
    summary: "Open one of the caller's diaries: its current text, generation and seq.",
    access: 'user',
    params: DiaryParams,
    response: DiaryResponse,
  },
  receipt: {
    method: 'GET',
    path: '/api/diaries/:diaryId/receipt',
    summary: "Look up the caller's committed batch by batch ID or by one operation ID.",
    access: 'user',
    params: DiaryParams,
    query: ReceiptQuery,
    response: ReceiptResponse,
  },
  history: {
    method: 'GET',
    path: '/api/diaries/:diaryId/history',
    summary: 'List history points of a diary, newest first, one page per opaque cursor.',
    access: 'user',
    params: DiaryParams,
    query: HistoryQuery,
    response: HistoryPage,
  },
  historyVersion: {
    method: 'GET',
    path: '/api/diaries/:diaryId/history/:publicId',
    summary: 'Read one committed version as server-rendered, read-only author runs.',
    access: 'user',
    params: HistoryVersionParams,
    response: HistoryVersion,
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof routes;
export type ResponseOf<Name extends RouteName> = z.infer<(typeof routes)[Name]['response']>;

type InputOf<
  Name extends RouteName,
  Key extends 'params' | 'query' | 'body',
> = (typeof routes)[Name] extends { [K in Key]: infer Schema extends z.ZodType }
  ? z.infer<Schema>
  : undefined;
export type ParamsOf<Name extends RouteName> = InputOf<Name, 'params'>;
export type QueryOf<Name extends RouteName> = InputOf<Name, 'query'>;
export type BodyOf<Name extends RouteName> = InputOf<Name, 'body'>;
