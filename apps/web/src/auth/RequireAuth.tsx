import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useMe } from './me.ts';

/** Renders its children only for a signed-in user (authentication-and-sessions D10). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <p className="status">正在打开…</p>;
  if (me.signedOut) return <Navigate to="/login" replace />;
  if (me.isError)
    return (
      <div className="status">
        <p>服务暂不可用，请稍后再试</p>
        <button type="button" onClick={() => void me.refetch()}>
          重试
        </button>
      </div>
    );
  return <>{children}</>;
}
