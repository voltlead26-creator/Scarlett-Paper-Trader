import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    proxy: { '/paper': 'http://127.0.0.1:8899' },
  },
});
