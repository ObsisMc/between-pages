import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { BookSpread } from '../book/index.ts';
import { useMe } from './me.ts';

/**
 * Renders its children only for a signed-in user (authentication-and-sessions D10). Until
 * then the window shows the book with what is happening on its left page, and no bookmark,
 * as there is no session yet (book-fit-and-bookmark D3).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending)
    return (
      <main>
        <BookSpread left={<p>正在打开…</p>} right={null} />
      </main>
    );
  if (me.signedOut) return <Navigate to="/login" replace />;
  if (me.isError)
    return (
      <main>
        <BookSpread
          left={
            <>
              <p role="alert">服务暂不可用，请稍后再试</p>
              <p>
                <button type="button" onClick={() => void me.refetch()}>
                  重试
                </button>
              </p>
            </>
          }
          right={null}
        />
      </main>
    );
  return <>{children}</>;
}
