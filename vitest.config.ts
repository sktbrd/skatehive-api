import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Mirror the tsconfig path alias so tests can import via '@/...'.
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  test: {
    environment: 'node',
    // Unit tests live outside the app tree; route folders contain literal
    // brackets (e.g. [author]) that break glob includes.
    include: ['tests/unit/**/*.test.ts'],
  },
});
