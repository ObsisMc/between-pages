import { useQuery } from '@tanstack/react-query';
import { ApiError, callApi } from '../api/client.ts';

export const meQueryKey = ['me'] as const;

const isSignedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

/** The signed-in user, from GET /api/me. A 401 is an answer, not a failure to retry. */
export function useMe() {
  const query = useQuery({
    queryKey: meQueryKey,
    queryFn: () => callApi('me'),
    retry: (count, error) => !isSignedOut(error) && count < 2,
  });
  return { ...query, signedOut: isSignedOut(query.error) };
}
