import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.tsx';
import { BackupPage, GoogleCallbackPage } from './backup/index.ts';
import { DayPage, DiaryPage } from './diary/index.ts';
import { JoinPage } from './join/index.ts';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SpacePage } from './space/index.ts';
import { ClocksPage } from './two-clocks/index.ts';

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
  // The partner's view of a shared diary, addressed by its epoch (kernel D10).
  {
    path: '/diaries/:diaryId/shares/:epochId',
    element: (
      <RequireAuth>
        <DiaryPage />
      </RequireAuth>
    ),
  },
  // Both people's diaries of one date (unread-and-day-page D6).
  {
    path: '/days/:date',
    element: (
      <RequireAuth>
        <DayPage />
      </RequireAuth>
    ),
  },
  // The caller's own backup status and Google Drive connection (server-backup-and-google-docs D9).
  {
    path: '/backup',
    element: (
      <RequireAuth>
        <BackupPage />
      </RequireAuth>
    ),
  },
  {
    path: '/backup/google/callback',
    element: (
      <RequireAuth>
        <GoogleCallbackPage />
      </RequireAuth>
    ),
  },
  // Both people's local times and today's shared awake hours (two-clocks D3).
  {
    path: '/clocks',
    element: (
      <RequireAuth>
        <ClocksPage />
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
