import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths, so a build can be served from any static host or
  // subpath without being rebuilt for it.
  base: './',
  plugins: [react()],
});
