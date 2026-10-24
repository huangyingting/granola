import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
  const expected = readFileSync(
    new URL('../src/renderer/public/app-icon.png', import.meta.url),
  ).toString('base64');
  const icons = await application.evaluate(
    async ({ app, nativeImage }, { png, files }) => {
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
      const desired = original.resize({
        width: 32,
        height: 32,
        quality: 'best',
      });
      const desiredPixels = desired.toBitmap({ scaleFactor: 1 });
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
            expectedSize: desired.getSize(),
            bytes: actualPixels.length,
            expectedBytes: desiredPixels.length,
            samples: sample(actualPixels),
            expectedSamples: sample(desiredPixels),
          };
        }),
      );
    },
    { png: expected, files },
  );
  for (const observed of icons) {
    expect(observed.empty, observed.file).toBe(false);
    expect(observed.size, observed.file).toEqual({ width: 32, height: 32 });
    expect(observed.expectedSize, observed.file).toEqual(observed.size);
    expect(observed.bytes, observed.file).toBe(32 * 32 * 4);
    expect(observed.expectedBytes, observed.file).toBe(observed.bytes);
    expect(observed.samples, observed.file).toEqual(observed.expectedSamples);
  }
}
