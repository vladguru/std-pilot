import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Пороги покрытия — ограничитель: ослабление только с согласия владельца.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, '.') } },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
    coverage: {
      provider: 'v8',
      include: ['app/**/*.{ts,tsx}', 'lib/**/*.ts', 'components/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'app/layout.tsx', 'app/page.tsx'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
