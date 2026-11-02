import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The offline logic is plain TypeScript over IndexedDB and fetch; the
    // component tests opt into a DOM per file.
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
