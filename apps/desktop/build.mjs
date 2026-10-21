import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

await bundle({
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.js',
  platform: 'node',
  format: 'esm',
  bundle: true,
  external: ['electron', 'node:*'],
  target: 'node24',
});
await bundle({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  platform: 'browser',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
  target: 'chrome140',
});
await build({
  configFile: false,
  root: fileURLToPath(new URL('./src/renderer/', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
