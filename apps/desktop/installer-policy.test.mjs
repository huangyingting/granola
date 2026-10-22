import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('compiled first-party NSIS identity policy', () => {
  let compiler;
  let directory;
  const marker = 'io.github.windowsainotes.desktop.nsis.x64.v1';
  beforeAll(async () => {
    const local = createRequire(new URL('./package.json', import.meta.url));
    const linked = createRequire(
      local.resolve('electron-builder/package.json'),
    );
    const { getMakeNsisPath } = linked(
      'app-builder-lib/out/toolsets/windows.js',
    );
    const { UUID } = linked('builder-util-runtime');
    const config = JSON.parse(
      await readFile(
        new URL('./electron-builder.unsigned.json', import.meta.url),
        'utf8',
      ),
    );
    expect(config.nsis.guid).toBe(
      UUID.v5(config.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')),
    );
    compiler = await getMakeNsisPath();
    directory = await mkdtemp(join(tmpdir(), 'notes-nsis-policy-'));
  }, 120_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function compile(name, changes = {}) {
    const defines = {
      APP_ID: 'io.github.windowsainotes.desktop',
      APP_GUID: 'dbdb543e-07bd-5ef6-99a5-00d80b9bdfb6',
      APP_64: 'synthetic-embedded-x64-package',
      VERSION: '0.1.1',
      ...changes,
    };
    const file = join(directory, `${name}.exe`);
    const script = join(directory, `${name}.nsi`);
    const include = fileURLToPath(
      new URL('./build/installer.nsh', import.meta.url),
    );
    await writeFile(
      script,
      [
        'Unicode true',
        'Name "Compile-only installer policy fixture"',
        'RequestExecutionLevel user',
        'SetCompress off',
        `OutFile "${file}"`,
        'VIProductVersion "0.1.1.0"',
        'VIAddVersionKey /LANG=1033 ProductName "Compile-only installer policy fixture"',
        'VIAddVersionKey /LANG=1033 ProductVersion "0.1.1"',
        'VIAddVersionKey /LANG=1033 FileDescription "Compile-only policy fixture"',
        'VIAddVersionKey /LANG=1033 FileVersion "0.1.1"',
        'VIAddVersionKey /LANG=1033 LegalCopyright "Synthetic test fixture"',
        `!include "${include}"`,
        '!insertmacro customHeader',
        'Section "Never executed"',
        'DetailPrint "Compile-only policy fixture"',
        'SectionEnd',
      ].join('\n'),
    );
    await promisify(execFile)(
      compiler.path,
      [
        '-INPUTCHARSET',
        'UTF8',
        ...Object.entries(defines)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `-D${key}=${value}`),
        script,
      ],
      {
        env: { ...process.env, ...compiler.env },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
    );
    return readFile(file);
  }
  it('embeds the exact installer and version markers only for the declared first-party embedded x64 package', async () => {
    const bytes = await compile('installer');
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ');
    expect(bytes.includes(Buffer.from(marker, 'utf16le'))).toBe(true);
    expect(
      bytes.includes(
        Buffer.from('windows-ai-notes-0.1.1-x64-setup.exe', 'utf16le'),
      ),
    ).toBe(true);
  }, 30_000);
  it('marks the uninstaller distinctly so it cannot satisfy the installer role', async () => {
    const bytes = await compile('uninstaller-role', { BUILD_UNINSTALLER: '' });
    expect(bytes.includes(Buffer.from(marker, 'utf16le'))).toBe(false);
    expect(
      bytes.includes(
        Buffer.from(
          'io.github.windowsainotes.desktop.uninstaller.x64.v1',
          'utf16le',
        ),
      ),
    ).toBe(true);
    expect(
      bytes.includes(
        Buffer.from('windows-ai-notes-0.1.1-x64-uninstaller.exe', 'utf16le'),
      ),
    ).toBe(true);
  }, 30_000);
  it.each([
    ['wrong-app', { APP_ID: 'different.application' }],
    ['wrong-guid', { APP_GUID: '00000000-0000-0000-0000-000000000000' }],
    ['missing-guid', { APP_GUID: undefined }],
    ['missing-x64', { APP_64: undefined }],
    ['x86-only', { APP_64: undefined, APP_32: 'synthetic-x86-package' }],
    ['mixed-x86', { APP_32: 'synthetic-x86-package' }],
    ['mixed-arm64', { APP_ARM64: 'synthetic-arm64-package' }],
    ['external-url', { APP_PACKAGE_URL: 'https://example.invalid/package' }],
    ['web-package', { APP_PACKAGE_STORE_FILE: 'synthetic-web-package' }],
  ])(
    'refuses to emit installer markers for an unsupported build: %s',
    async (name, changes) => {
      await expect(compile(name, changes)).rejects.toMatchObject({ code: 1 });
      await expect(
        readFile(join(directory, `${name}.exe`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );
});
