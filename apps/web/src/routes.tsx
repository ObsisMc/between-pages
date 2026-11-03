import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.tsx';
import { BackupPage, GoogleCallbackPage } from './backup/index.ts';
import { DaysWorkspace } from './diary/index.ts';
import { JoinPage } from './join/index.ts';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SpacePage } from './space/index.ts';
import { ClocksPage } from './two-clocks/index.ts';
import { WishesPage } from './wishes/index.ts';
import { AnniversariesPage, AnniversaryPage } from './anniversaries/index.ts';
import { SiteLayout } from './shell/index.ts';

// authentication-and-sessions D10: /login is public, / and diaries need a session,
// everything else goes to /. /join is public so it can keep an invitation across the login
// round trip (spaces-and-invitations D12); it asks for a session itself.
const pages: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <HomePage />
      </RequireAuth>
    ),
  },
  // The diary workspace: all diaries by date, and one date's two diaries beside them
  // (book-frontend-workspace D3, unread-and-day-page D6). One route, so the feed stays
  // mounted while the date changes.
  {
    path: '/days/:date?',
    element: (
      <RequireAuth>
        <DaysWorkspace />
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
  // Anniversaries and one anniversary's years (anniversaries ADR).
  {
    path: '/anniversaries',
    element: (
      <RequireAuth>
        <AnniversariesPage />
      </RequireAuth>
    ),
  },
  {
    path: '/anniversaries/:anniversaryId',
    element: (
      <RequireAuth>
        <AnniversaryPage />
      </RequireAuth>
    ),
  },
  // Wish lists, gifts in preparation and the gift wall (wishes-and-gifts ADR).
  {
    path: '/wishes',
    element: (
      <RequireAuth>
        <WishesPage />
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

// Every page sits under one site header, shown once signed in (digital-paper-interface D1).
export const appRoutes: RouteObject[] = [{ element: <SiteLayout />, children: pages }];
