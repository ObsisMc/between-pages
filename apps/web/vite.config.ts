import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin in development: /api is proxied to the API process (ADR-0006), whose
// port comes from the same repo-root .env the API reads.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    server: { proxy: { '/api': `http://127.0.0.1:${env.PORT ?? 3000}` } },
  };
});
