import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';

// authentication-and-sessions D10: /login is public, / needs a session, everything else
// goes to /.
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
  { path: '*', element: <Navigate to="/" replace /> },
];
