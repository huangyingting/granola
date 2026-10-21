import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { bundledNotices } from './licenses.mjs';

it('includes actual bundled package licenses and notices, deduplicating renderer copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-licenses-'));
  try {
    await mkdir(join(directory, 'dist'));
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'synthetic-package',
        version: '1.0.0',
        license: 'MIT',
      }),
    );
    await writeFile(
      join(directory, 'dist', 'package.json'),
      '{"type":"module"}',
    );
    await writeFile(
      join(directory, 'LICENSE'),
      'Synthetic complete license text.',
    );
    await writeFile(
      join(directory, 'NOTICE.txt'),
      'Synthetic attribution notice.',
    );
    const result = await bundledNotices(
      [join(directory, 'dist', 'index.js')],
      [
        {
          name: 'synthetic-package',
          version: '1.0.0',
          identifier: 'MIT',
          text: 'Synthetic complete license text.',
        },
        { name: '@windows-ai-notes/contracts', version: '0.1.0' },
        {
          name: 'synthetic-renderer',
          version: '2.0.0',
          identifier: 'MIT',
          text: 'Synthetic renderer license.',
        },
      ],
    );
    expect(result.match(/synthetic-package@1.0.0/g)).toHaveLength(1);
    expect(result).toContain('Synthetic attribution notice.');
    expect(result).toContain('Synthetic complete license text.');
    expect(result).toContain('Synthetic renderer license.');
    expect(result).not.toContain('@windows-ai-notes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails the build rather than silently distributing dependencies without license text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-missing-license-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'synthetic-missing',
        version: '1.0.0',
        license: 'MIT',
      }),
    );
    await expect(
      bundledNotices([join(directory, 'index.js')], []),
    ).rejects.toThrow('Missing license text');
    await expect(
      bundledNotices(
        [],
        [
          {
            name: 'synthetic-missing',
            version: '1.0.0',
            identifier: 'MIT',
            text: '',
          },
        ],
      ),
    ).rejects.toThrow('Missing renderer dependency notice');
    await expect(bundledNotices([], [null])).rejects.toThrow(
      'invalid dependency license metadata',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
