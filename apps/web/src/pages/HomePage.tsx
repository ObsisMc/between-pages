import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { signOut } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';

/** Placeholder home behind RequireAuth until the diary space exists. */
export function HomePage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  const onSignOut = async () => {
    setFailed(false);
    try {
      await signOut();
      // Drop every cached answer of the old session before showing the login page.
      queryClient.clear();
      await navigate('/login', { replace: true });
    } catch {
      setFailed(true);
    }
  };

  return (
    <main className="page home">
      <header>
        <button type="button" onClick={() => void onSignOut()}>
          退出
        </button>
      </header>
      <p className="greeting">已登录为 {me.data?.user.displayName}</p>
      <p>日记空间即将开放。</p>
      {failed && (
        <p className="notice" role="alert">
          退出失败，请重试
        </p>
      )}
    </main>
  );
}
