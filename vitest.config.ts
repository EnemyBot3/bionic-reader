import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The reader is a browser program: give the tests a DOM and real storage.
    environment: 'happy-dom',
    include: ['web/**/*.test.ts'],
  },
});
