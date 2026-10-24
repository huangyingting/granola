import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  iconImages,
  iconSizes,
  readIconAssets,
  validateIconAssets,
  verifyDesktopIcons,
} from './icons.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
it('validates a single committed source and all transparent Windows shell sizes without a rendering dependency', async () => {
  await expect(verifyDesktopIcons()).resolves.toBeUndefined();
  const assets = await readIconAssets();
  const images = iconImages(assets.ico);
  expect(images.map((image) => image.size)).toEqual([
    16, 24, 32, 48, 64, 128, 256,
  ]);
  expect(images.every((image) => image.bitmap.readUInt32LE(16) === 0)).toBe(
    true,
  );
  expect(Object.isFrozen(iconSizes)).toBe(true);
});
it.each(['svg', 'png', 'ico'])(
  'rejects a stale or changed %s rather than allowing a default Electron fallback',
  async (name) => {
    const assets = await readIconAssets();
    assets[name] = Buffer.concat([assets[name], Buffer.from('changed')]);
    expect(() => validateIconAssets(assets)).toThrow('desktop_icon_invalid');
  },
);
it.each(['count', 'offset', 'range', 'size', 'bit-depth', 'trailing'])(
  'rejects malformed %s ICO structure even when its recorded hash matches',
  async (kind) => {
    const assets = await readIconAssets();
    assets.ico = Buffer.from(assets.ico);
    if (kind === 'count') assets.ico.writeUInt16LE(8, 4);
    if (kind === 'offset') assets.ico.writeUInt32LE(0, 18);
    if (kind === 'range') assets.ico.writeUInt32LE(assets.ico.length, 14);
    if (kind === 'size') assets.ico[6] = 17;
    if (kind === 'bit-depth') assets.ico.writeUInt16LE(24, 12);
    if (kind === 'trailing')
      assets.ico = Buffer.concat([assets.ico, Buffer.from([0])]);
    assets.manifest.ico_sha256 = digest(assets.ico);
    expect(() => validateIconAssets(assets)).toThrow('desktop_icon_invalid');
  },
);
it('rejects truncated files and nonclassic or invalid bitmap headers required by NSIS', async () => {
  const assets = await readIconAssets();
  expect(() => iconImages(assets.ico.subarray(0, -1))).toThrow(
    'desktop_icon_invalid',
  );
  for (const field of [0, 4, 8, 16]) {
    const changed = Buffer.from(assets.ico);
    changed.writeUInt32LE(1, changed.readUInt32LE(18) + field);
    expect(() => iconImages(changed)).toThrow('desktop_icon_invalid');
  }
  assets.png = assets.png.subarray(0, -1);
  assets.manifest.png_sha256 = digest(assets.png);
  expect(() => validateIconAssets(assets)).toThrow('desktop_icon_invalid');
});
it('wires the same mark into renderer, favicon, Main window, Windows executable and taskbar identity', async () => {
  const [config, main, html, renderer] = await Promise.all(
    [
      './electron-builder.unsigned.json',
      './src/main/main.ts',
      './src/renderer/index.html',
      './src/renderer/main.tsx',
    ].map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  const builder = JSON.parse(config);
  expect(builder.win.icon).toBe('build/app-icon.ico');
  expect(builder.nsis.installerIcon).toBe(builder.win.icon);
  expect(builder.nsis.uninstallerIcon).toBe(builder.win.icon);
  expect(builder.files).toContain('dist/renderer/**/*');
  expect(main).toContain(`app.setAppUserModelId('${builder.appId}')`);
  expect(main).toContain("icon: join(directory, '../renderer/app-icon.png')");
  expect(html).toContain('href="./app-icon.svg"');
  expect(renderer).toContain('src="./app-icon.svg"');
});
