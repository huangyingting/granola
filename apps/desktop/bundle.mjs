import { build } from 'esbuild';

export function bundleMain(entryPoint, outfile) {
  return build({
    entryPoints: [entryPoint],
    outfile,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as __createBundleRequire } from 'node:module'; const require = __createBundleRequire(import.meta.url);",
    },
    bundle: true,
    external: ['electron', 'node:*'],
    target: 'node24',
    metafile: true,
  });
}
