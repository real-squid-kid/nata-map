import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: env.PHP_API_TARGET || 'http://127.0.0.1:8080' } },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  };
});
