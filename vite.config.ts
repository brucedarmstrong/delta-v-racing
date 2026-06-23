import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';

export default defineConfig({
  define: {
    // Injected at build time so the splash screen can show a build stamp.
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  plugins: [
    devvit({
      client: {
        build: {
          chunkSizeWarningLimit: 2000,
        },
      },
    }),
  ],
});
