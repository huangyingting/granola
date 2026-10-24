import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { iconImages, readIconAssets, validateIconAssets } from '../icons.mjs';

export async function assertAppIcon(
  application: ElectronApplication,
  page: Page,
  files: string[] = [],
) {
  const brand = page.locator('img.brand-mark');
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute('alt', '');
  await expect(brand).toHaveAttribute('aria-hidden', 'true');
  await expect
    .poll(() =>
      brand.evaluate((element) => {
        if (!(element instanceof HTMLImageElement)) return false;
        return (
          element.complete &&
          element.naturalWidth === 256 &&
          element.naturalHeight === 256
        );
      }),
    )
    .toBe(true);
  const assets = await readIconAssets();
  validateIconAssets(assets);
  const image = iconImages(assets.ico).find(({ size }) => size === 32);
  if (!image) throw new Error('The committed 32px Windows icon is missing.');
  // DIB rows are bottom-up; NativeImage exposes top-down, premultiplied BGRA.
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    image.bitmap.copy(
      bitmap,
      y * 128,
      40 + (31 - y) * 128,
      40 + (32 - y) * 128,
    );
  for (let offset = 0; offset < bitmap.length; offset += 4)
    for (let channel = 0; channel < 3; channel++)
      bitmap[offset + channel] = Math.round(
        (bitmap[offset + channel] * bitmap[offset + 3]) / 255,
      );
  const icons = await application.evaluate(
    async ({ app, nativeImage }, { png, pixels, files }) => {
      const original = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
      const { join } = process.getBuiltinModule('node:path');
      const windowIcon = nativeImage.createFromPath(
        join(app.getAppPath(), 'dist/renderer/app-icon.png'),
      );
      if (
        windowIcon.isEmpty() ||
        !windowIcon.toBitmap().equals(original.toBitmap())
      )
        throw new Error('The shipped window icon does not match its source.');
      const desiredPixels = Buffer.from(pixels, 'base64');
      const points: [number, number][] = [
        [0, 0],
        [16, 4],
        [4, 16],
        [16, 28],
        [11, 19],
        [20, 19],
      ];
      const sample = (bytes: Buffer) =>
        points.map(([x, y]) =>
          bytes
            .subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)
            .toString('hex'),
        );
      return Promise.all(
        [process.execPath, ...files].map(async (file) => {
          const actual = await app.getFileIcon(file, { size: 'normal' });
          const actualPixels = actual.toBitmap({ scaleFactor: 1 });
          return {
            file,
            empty: actual.isEmpty(),
            size: actual.getSize(),
            bytes: actualPixels.length,
            expectedBytes: desiredPixels.length,
            samples: sample(actualPixels),
            expectedSamples: sample(desiredPixels),
          };
        }),
      );
    },
    {
      png: assets.png.toString('base64'),
      pixels: bitmap.toString('base64'),
      files,
    },
  );
  for (const observed of icons) {
    expect(observed.empty, observed.file).toBe(false);
    expect(observed.size, observed.file).toEqual({ width: 32, height: 32 });
    expect(observed.bytes, observed.file).toBe(32 * 32 * 4);
    expect(observed.expectedBytes, observed.file).toBe(observed.bytes);
    expect(observed.samples, observed.file).toEqual(observed.expectedSamples);
  }
}
