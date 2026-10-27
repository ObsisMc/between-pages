import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { ErrorCode } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';

// Relationship state lives in TanStack Query, refreshed on focus and by hand (D12); no
// polling and no socket. Tokens never enter a query key or a cached value (D8).

export const relationshipKeys = {
  binding: ['binding'] as const,
  spaces: ['spaces'] as const,
  space: (spaceId: string) => ['space', spaceId] as const,
  mySharing: (spaceId: string) => ['my-sharing', spaceId] as const,
};

export const useBinding = () =>
  useQuery({ queryKey: relationshipKeys.binding, queryFn: () => callApi('binding') });

export const useSpaces = () =>
  useQuery({ queryKey: relationshipKeys.spaces, queryFn: () => callApi('spaces') });

/** After a binding changes, every relationship answer may be stale. */
export const refreshRelationships = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: relationshipKeys.binding }),
    client.invalidateQueries({ queryKey: relationshipKeys.spaces }),
    client.invalidateQueries({ queryKey: ['space'] }),
    client.invalidateQueries({ queryKey: ['my-sharing'] }),
  ]);

const REFUSAL_TEXT: Partial<Record<ErrorCode, string>> = {
  INVITE_INVALID: '这条邀请链接无效',
  INVITE_EXPIRED: '这条邀请已过期，请对方重新生成',
  INVITE_REVOKED: '这条邀请已被撤销',
  INVITE_USED: '这条邀请已被使用',
  SELF_INVITE: '不能接受自己发出的邀请',
  ALREADY_BOUND: '你或对方已有当前绑定',
  PARTNER_FIXED: '首版绑定后搭档固定，只能与原搭档恢复关系',
  PERIOD_CLOSED: '这次绑定已经结束',
  POLICY_CONFLICT: '共享范围已在别处修改，请重新载入后再改',
  NOT_FOUND: '找不到这个空间',
};

/** The screen's text for a failed relationship call; codes decide it, never server messages. */
export function refusalText(error: unknown): string {
  if (!(error instanceof ApiError)) return '网络中断，无法确认结果，请联网后重试';
  return REFUSAL_TEXT[error.code] ?? '操作失败，请稍后再试';
}

/** A refusal that a retry of the same request cannot change. */
export const isFinalRefusal = (error: unknown) =>
  error instanceof ApiError && error.code in REFUSAL_TEXT;
