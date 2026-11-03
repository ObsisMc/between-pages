import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { Button } from '../ui/index.ts';
import { useMe } from './me.ts';

/** Renders its children only for a signed-in user (authentication-and-sessions D10). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <p className="px-5 py-16 text-center text-ink-soft">正在打开…</p>;
  if (me.signedOut) return <Navigate to="/login" replace />;
  if (me.isError)
    return (
      <div className="grid justify-items-center gap-4 px-5 py-16 text-center text-ink-soft">
        <p>服务暂不可用，请稍后再试</p>
        <Button type="button" variant="outline" onClick={() => void me.refetch()}>
          重试
        </Button>
      </div>
    );
  return <>{children}</>;
}
