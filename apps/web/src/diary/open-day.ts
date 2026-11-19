import type { ResponseOf } from '@between-pages/contracts';
import { isoDateIn } from '@between-pages/time';
import { ApiError, callApi } from '../api/client.ts';

/** The device's IANA zone decides which date "today" is (spec §4); the server checks it. */
export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Today's date in the device's zone, as the server would decide it. */
export const todayHere = () => isoDateIn(Date.now(), timezone());

/** Why the own diary of a date was not opened: not begun here, refused, or never asked. */
export type OpenFailure = 'future' | 'failed' | 'offline';

export const openFailureText: Record<OpenFailure, string> = {
  future: '你这边还没到这一天',
  failed: '创建失败，请稍后再试',
  offline: '离线时无法创建，请联网后再试',
};

/**
 * Opens the caller's diary of `date`, creating it when missing (spec §4 "可打开/补写过去
 * 日期", `POST /api/diaries` with the date and the device's zone). The server decides whether
 * the date has begun in that zone: a later one is `future`. Without an answer nothing counts
 * as created (DATE-06).
 */
export async function openOwnDiary(
  date: string,
): Promise<ResponseOf<'openDiary'> | { failure: OpenFailure }> {
  try {
    return await callApi('openDiary', { body: { timezone: timezone(), date } });
  } catch (error) {
    if (!(error instanceof ApiError)) return { failure: 'offline' };
    return { failure: error.code === 'VALIDATION_FAILED' ? 'future' : 'failed' };
  }
}
