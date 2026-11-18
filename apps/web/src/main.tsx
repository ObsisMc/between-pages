import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { registerServiceWorker } from './pwa/index.ts';
import { appRoutes } from './routes.tsx';
import './styles.css';

// The dev server has no worker to register (installable-pwa invariant 9).
if (import.meta.env.PROD) registerServiceWorker();

const queryClient = new QueryClient();
const router = createBrowserRouter(appRoutes);
const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
