import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { noAnswer } from '../api/client.ts';
import { useOnline } from '../api/online.ts';
import { Button, Card } from '../ui/index.ts';
import { useMe } from './me.ts';

/**
 * Renders its children only for a signed-in user (authentication-and-sessions D10). Before
 * the server has said who is signed in, no answer at all means offline, and the page says so
 * without a name or any content; an HTTP error is the service's (installable-pwa D3).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const online = useOnline();
  const offline = !online || noAnswer(me.failureReason);
  if (me.signedOut) return <Navigate to="/login" replace />;
  if (me.isError && !offline)
    return (
      <div className="grid justify-items-center gap-4 px-5 py-16 text-center text-ink-soft">
        <p>服务暂不可用，请稍后再试</p>
        <Button type="button" variant="outline" onClick={() => void me.refetch()}>
          重试
        </Button>
      </div>
    );
  if (me.data) return <>{children}</>;
  if (offline) return <OfflinePage />;
  return <p className="px-5 py-16 text-center text-ink-soft">正在打开…</p>;
}

/** The book's cover pages while offline, with nothing of anyone's; it opens by itself. */
function OfflinePage() {
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-16 font-sans">
      <Card className="grid w-full max-w-2xl gap-0 p-0 sm:grid-cols-2">
        <div className="grid place-items-center border-line px-8 py-12 sm:border-r">
          <h1 className="font-serif text-3xl font-medium">Between Pages</h1>
        </div>
        <div className="grid place-items-center border-t border-line px-8 py-12 sm:border-t-0">
          <p role="status" className="text-ink-soft">
            现在离线，联网后会自动打开
          </p>
        </div>
      </Card>
    </main>
  );
}
