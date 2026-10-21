import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { bundleMain } from './bundle.mjs';

it('initializes bundled CommonJS dependencies with real Node builtins in ESM Main', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-main-bundle-'));
  try {
    await writeFile(
      join(directory, 'dependency.cjs'),
      "const { EventEmitter } = require('node:events'); const { createHash } = require('crypto'); module.exports = () => [new EventEmitter().eventNames().length, createHash('sha256').update('synthetic').digest('hex').length];",
    );
    const entry = join(directory, 'entry.mjs');
    const output = join(directory, 'main.mjs');
    await writeFile(
      entry,
      "import dependency from './dependency.cjs'; process.stdout.write(JSON.stringify(dependency()));",
    );
    await bundleMain(entry, output);
    const result = await promisify(execFile)(process.execPath, [output], {
      timeout: 5000,
      maxBuffer: 1024,
    });

    expect(result.stdout).toBe('[0,64]');
    expect(result.stderr).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('evaluates the isolated Electron fixture without awaiting startup before Playwright releases readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-live-bootstrap-'));
  try {
    const output = join(directory, 'fixture.mjs');
    const mocks = {
      electron:
        'export const app = {setPath(){}, whenReady:()=>new Promise(()=>{}), exit(){throw new Error("Unexpected startup exit")}}; export class BrowserWindow{}; export const ipcMain = {};',
      'node:fs/promises': 'export const readFile = () => new Promise(()=>{});',
    };
    await build({
      entryPoints: [
        fileURLToPath(
          new URL('./tests/fixtures/live-preview-main.mjs', import.meta.url),
        ),
      ],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      plugins: [
        {
          name: 'held-electron-startup',
          setup(builder) {
            builder.onResolve(
              { filter: /^(electron|node:fs\/promises)$/ },
              (args) => ({ path: args.path, namespace: 'held-startup' }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: 'held-startup' },
              (args) => ({ contents: mocks[args.path], loader: 'js' }),
            );
          },
        },
      ],
    });
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await import(process.argv[1]); process.stdout.write("fixture_evaluated");',
        pathToFileURL(output).href,
      ],
      {
        env: { ...process.env, NOTES_LIVE_UI_FIXTURE: directory },
        timeout: 5000,
        maxBuffer: 1024,
      },
    );
    expect(result.stdout).toBe('fixture_evaluated');
    expect(result.stderr).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
