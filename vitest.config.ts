import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { exclude: [...configDefaults.exclude, 'apps/desktop/tests/**'] },
});
