import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { bundledNotices } from './licenses.mjs';
import { bundleMain } from './bundle.mjs';

const main = await bundleMain('src/main/main.ts', 'dist/main/main.js');
const preload = await bundle({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  platform: 'browser',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
  target: 'chrome140',
  metafile: true,
});
await build({
  configFile: false,
  root: fileURLToPath(new URL('./src/renderer/', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    license: { fileName: 'licenses.json' },
  },
});
await writeFile(
  'dist/THIRD_PARTY_NOTICES.txt',
  await bundledNotices(
    [
      ...Object.keys(main.metafile.inputs),
      ...Object.keys(preload.metafile.inputs),
    ],
    JSON.parse(await readFile('dist/renderer/licenses.json', 'utf8')),
  ),
);
