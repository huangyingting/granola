import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
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
