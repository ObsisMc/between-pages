import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.tsx';
import { DiaryPage } from './diary/index.ts';
import { JoinPage } from './join/index.ts';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SpacePage } from './space/index.ts';

// authentication-and-sessions D10: /login is public, / and diaries need a session,
// everything else goes to /. /join is public so it can keep an invitation across the login
// round trip (spaces-and-invitations D12); it asks for a session itself.
export const appRoutes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <HomePage />
      </RequireAuth>
    ),
  },
  {
    path: '/diaries/:diaryId',
    element: (
      <RequireAuth>
        <DiaryPage />
      </RequireAuth>
    ),
  },
  { path: '/join', element: <JoinPage /> },
  {
    path: '/spaces/:spaceId',
    element: (
      <RequireAuth>
        <SpacePage />
      </RequireAuth>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
];
