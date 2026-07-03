import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['core/**/*.test.ts', 'ui/**/*.test.ts'],
  },
});
